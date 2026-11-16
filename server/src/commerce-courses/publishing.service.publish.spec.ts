import { ConflictException } from '@nestjs/common';
import { PublishingService } from './publishing.service';
import { captureVersionSnapshot } from './version-snapshot';
import { snapshotContentHash } from './content-hash';

/**
 * N2（发布完整度检查在 FOR UPDATE 事务外，TOCTOU）回归测试。
 *
 * 红：旧实现先在工作区无锁读完成度（completenessForDraft），判定通过后
 * 才进事务拍快照——检查与冻结之间存在窗口，并发草稿写入滑入后不完整内容
 * 被冻结发布。下面 (a) 用确定性时序证明：工作区预检通过、锁内快照不完整
 * → 发布必须拒绝（旧代码会成功发布，测试红）。
 *
 * 绿：修复后完整度判定与快照同源（同一 FOR UPDATE 事务内的快照），
 * (a) 拒绝 + (b) 完整快照照常发布。
 */

jest.mock('./version-snapshot', () => {
  // requireActual 返回 any；断言成模块类型，让 mock 工厂的返回值可被下游按真实形状使用。
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const actual = jest.requireActual(
    './version-snapshot',
  ) as typeof import('./version-snapshot');
  return {
    ...actual,
    captureVersionSnapshot: jest.fn(),
    applyVersionSnapshotInTx: jest.fn(),
  };
});
jest.mock('./content-hash', () => ({
  snapshotContentHash: jest.fn(),
}));

const captureMock = captureVersionSnapshot as unknown as jest.Mock;
const hashMock = snapshotContentHash as unknown as jest.Mock;

/** 不完整快照：无分类、无学习语言、无本地化、无课时（CI 一步即缺）。 */
const INCOMPLETE_SNAPSHOT = {
  formatVersion: 3,
  course: {
    code: 'C001',
    slug: 'c001',
    categoryPath: null,
    coverAssetId: null,
    learningMode: 'TEXT_ONLY',
    defaultContentLanguage: 'en-GB',
    learningLanguages: [],
    localizations: [],
    lessons: [],
  },
};

/** 完整快照：CI 双语齐全 + 至少 1 个 lesson Study 完成（canPublish=true）。 */
const COMPLETE_SNAPSHOT = {
  formatVersion: 3,
  course: {
    code: 'C001',
    slug: 'c001',
    categoryPath: ['Society'],
    coverAssetId: null,
    learningMode: 'TEXT_ONLY',
    defaultContentLanguage: 'en-GB',
    learningLanguages: ['en-GB'],
    localizations: [
      {
        language: 'en-GB',
        title: 'C001 title',
        shortDescription: 'short',
        overview: 'overview',
        whatYouLearn: ['a', 'b', 'c', 'd'],
        provides: ['a', 'b', 'c', 'd'],
      },
      {
        language: 'zh-CN',
        title: 'C001 标题',
        shortDescription: '短',
        overview: '概述',
        whatYouLearn: ['a', 'b', 'c', 'd'],
        provides: ['a', 'b', 'c', 'd'],
      },
    ],
    lessons: [
      {
        id: 'lesson-1',
        code: 'lesson-1',
        sortOrder: 1,
        localizations: [
          {
            language: 'en-GB',
            title: 'Lesson 1',
            description: 'desc',
            videoAssetId: null,
            videoDurationSeconds: null,
            textHtml: '<h1>Heading One</h1><p>Body text here.</p>',
          },
          {
            language: 'zh-CN',
            title: '第 1 课',
            description: '描述',
            videoAssetId: null,
            videoDurationSeconds: null,
            textHtml: null,
          },
        ],
        exhibits: [],
        learningPoints: [{ language: 'en-GB', source: 'TEXT' }],
        triggers: [],
        readings: [
          {
            type: 'BOOK',
            title: 'T',
            author: 'A',
            whyRecommended: 'W',
          },
        ],
        questions: [],
        applicationTest: null,
      },
    ],
  },
};

function setup() {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([
      {
        draftRevision: 2,
        liveBaseRevision: 1,
        liveVersionId: 'live-1',
        trialEnabled: false,
      },
    ]),
    trialSetting: { findMany: jest.fn().mockResolvedValue([]) },
    courseVersion: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockResolvedValue({ id: 'v1', versionNo: 1, versionLabel: '1.1' }),
    },
    commerceCourse: { update: jest.fn().mockResolvedValue({}) },
    courseAuthoringActivity: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    commerceCourse: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'course-1',
        code: 'C001',
        liveVersionId: 'live-1',
        liveStatus: 'ONLINE',
        draftRevision: 2,
        liveBaseRevision: 1,
        draftSourceType: null,
        draftSourceEnvironment: null,
        draftSourceVersionLabel: null,
        archivedAt: null,
      }),
    },
    $transaction: jest.fn(async (cb: (t: unknown) => Promise<unknown>) =>
      cb(tx),
    ),
  };
  const service = new PublishingService(
    prisma as never,
    {} as never,
    { versionNumberingMode: 'sandbox' } as never,
  );
  // 模拟旧实现的工作区预检：判定通过（修复后该路径不再被 publish 使用）。
  jest
    .spyOn(service, 'completenessForDraft')
    .mockResolvedValue({ canPublish: true, publishBlockers: [] } as never);
  return { service, tx };
}

beforeEach(() => {
  jest.clearAllMocks();
  captureMock.mockResolvedValue(INCOMPLETE_SNAPSHOT);
  hashMock.mockResolvedValue('hash');
});

describe('publish — completeness gate inside the FOR UPDATE transaction (N2)', () => {
  it('rejects with 409 PUBLISH_BLOCKED when the frozen snapshot fails the gate even though the pre-check passed', async () => {
    const { service } = setup();
    captureMock.mockResolvedValue(INCOMPLETE_SNAPSHOT);

    const error = await service
      .publish('course-1', 'emp-1')
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).not.toBeNull();
    expect(error).toBeInstanceOf(ConflictException);
    const response = (error as ConflictException).getResponse() as {
      code: string;
      message: string;
      blockers: string[];
    };
    expect(response.code).toBe('PUBLISH_BLOCKED');
    expect(Array.isArray(response.blockers)).toBe(true);
    expect(response.blockers.length).toBeGreaterThan(0);
    expect(response.message).toBe(response.blockers.join(' '));
  });

  it('publishes when the frozen snapshot passes the gate (no over-blocking)', async () => {
    const { service, tx } = setup();
    captureMock.mockResolvedValue(COMPLETE_SNAPSHOT);

    const result = await service.publish('course-1', 'emp-1');

    expect(result).toEqual({
      versionId: 'v1',
      versionLabel: '1.1',
      versionNo: 1,
    });
    expect(tx.courseVersion.create).toHaveBeenCalled();
    expect(tx.commerceCourse.update).toHaveBeenCalled();
  });

  it('does not create a version or write history when the gate rejects', async () => {
    const { service, tx } = setup();
    captureMock.mockResolvedValue(INCOMPLETE_SNAPSHOT);

    await service.publish('course-1', 'emp-1').catch(() => undefined);

    expect(tx.courseVersion.create).not.toHaveBeenCalled();
    expect(tx.commerceCourse.update).not.toHaveBeenCalled();
    expect(tx.courseAuthoringActivity.create).not.toHaveBeenCalled();
  });
});
