import {
  PublishingService,
  HISTORY_ACTIONS,
  importedDraftHistoryDetail,
} from './publishing.service';
import { CommerceCoursesService } from './commerce-courses.service';
import { captureVersionSnapshot } from './version-snapshot';
import { snapshotContentHash } from './content-hash';

jest.mock('./version-snapshot', () => ({
  captureVersionSnapshot: jest.fn(),
  applyVersionSnapshotInTx: jest.fn(),
  detailToCompletenessInput: jest.fn(),
  snapshotToCompletenessInput: jest.fn(),
}));
jest.mock('./content-hash', () => ({
  snapshotContentHash: jest.fn(),
}));

const captureMock = captureVersionSnapshot as unknown as jest.Mock;
const hashMock = snapshotContentHash as unknown as jest.Mock;

function publishing(
  prismaOverrides: Record<string, unknown> = {},
  config: Record<string, unknown> = { versionNumberingMode: 'sandbox' },
) {
  const prisma = {
    ...prismaOverrides,
  };
  const service = new PublishingService(
    prisma as never,
    {} as never,
    config as never,
  );
  jest
    .spyOn(service, 'completenessForDraft')
    .mockResolvedValue({ canPublish: true, publishBlockers: [] } as never);
  return { service, prisma };
}

interface ActivityData {
  action: string;
  versionNo: number | null;
  detail: Record<string, unknown>;
}

function activityData(create: jest.Mock): ActivityData {
  const call = create.mock.calls[0] as [{ data: ActivityData }];
  return call[0].data;
}

beforeEach(() => {
  jest.clearAllMocks();
  captureMock.mockResolvedValue({});
  hashMock.mockResolvedValue('hash');
});

describe('History detail — PRD §21 original/new values', () => {
  it('PUBLISH records the previous version label as from and the new one as to', async () => {
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([
          { draftRevision: 2, liveBaseRevision: 1, liveVersionId: null },
        ]),
      courseVersion: {
        findFirst: jest.fn().mockResolvedValue({
          versionNo: 2,
          versionSeries: 1,
          versionMinor: 2,
          versionLabel: '1.2',
          exportedAt: null,
        }),
        create: jest
          .fn()
          .mockResolvedValue({ id: 'v3', versionNo: 3, versionLabel: '1.3' }),
      },
      commerceCourse: { update: jest.fn().mockResolvedValue({}) },
      courseAuthoringActivity: { create: jest.fn().mockResolvedValue({}) },
    };
    const { service } = publishing({
      commerceCourse: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'course-1',
          code: 'C001',
          liveVersionId: null,
          liveStatus: 'OFFLINE',
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
    });

    await service.publish('course-1', 'emp-1');

    const data = activityData(tx.courseAuthoringActivity.create);
    expect(data.action).toBe(HISTORY_ACTIONS.PUBLISH);
    expect(data.versionNo).toBe(3);
    expect(data.detail).toEqual(
      expect.objectContaining({ from: '1.2', to: '1.3' }),
    );
  });

  it('DELETE_DRAFT records draft as from and the kept live version as to', async () => {
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([
          { liveVersionId: 'live-1', draftRevision: 2, liveBaseRevision: 1 },
        ]),
      courseVersion: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'live-1',
          versionNo: 3,
          versionLabel: 'Version 3',
          snapshotData: {},
        }),
      },
      commerceCourse: { update: jest.fn().mockResolvedValue({}) },
      courseAuthoringActivity: { create: jest.fn().mockResolvedValue({}) },
    };
    const { service } = publishing({
      $transaction: jest.fn(async (cb: (t: unknown) => Promise<unknown>) =>
        cb(tx),
      ),
    });

    await service.deleteDraft('course-1', 'emp-1');

    const data = activityData(tx.courseAuthoringActivity.create);
    expect(data.action).toBe(HISTORY_ACTIONS.DELETE_DRAFT);
    expect(data.versionNo).toBe(3);
    expect(data.detail).toEqual(
      expect.objectContaining({ from: 'Draft', to: 'Version 3' }),
    );
  });

  it('RESTORE records the restored version as from and draft as to', async () => {
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([
          { liveVersionId: 'live-1', draftRevision: 2, liveBaseRevision: 1 },
        ]),
      commerceCourse: { update: jest.fn().mockResolvedValue({}) },
      courseAuthoringActivity: { create: jest.fn().mockResolvedValue({}) },
    };
    const { service } = publishing({
      courseVersion: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'v1',
          courseId: 'course-1',
          versionNo: 1,
          versionLabel: 'Version 1',
          snapshotData: {},
        }),
      },
      $transaction: jest.fn(async (cb: (t: unknown) => Promise<unknown>) =>
        cb(tx),
      ),
    });

    await service.restore('course-1', 'v1', 'emp-1');

    const data = activityData(tx.courseAuthoringActivity.create);
    expect(data.action).toBe(HISTORY_ACTIONS.RESTORE);
    expect(data.versionNo).toBe(1);
    expect(data.detail).toEqual(
      // PRD §21 "Version 1 → draft"：草稿单词小写。
      expect.objectContaining({ from: 'Version 1', to: 'draft' }),
    );
  });

  it('CHANGE_STATUS keeps from/to/reason and records the live version number', async () => {
    const create = jest.fn().mockResolvedValue({});
    const { service } = publishing({
      commerceCourse: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'course-1',
          liveVersionId: 'live-1',
          liveStatus: 'ONLINE',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      courseVersion: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ versionNo: 3, versionLabel: 'Version 3' }),
      },
      courseAuthoringActivity: { create },
      $transaction: jest.fn(async (ops: Promise<unknown>[]) =>
        Promise.all(ops),
      ),
    });

    await service.changeStatus(
      'course-1',
      { status: 'HIDDEN', reason: 'Typos reported in Lesson 04' },
      'emp-1',
    );

    const data = activityData(create);
    expect(data.action).toBe(HISTORY_ACTIONS.CHANGE_STATUS);
    expect(data.versionNo).toBe(3);
    expect(data.detail).toEqual({
      from: 'ONLINE',
      to: 'HIDDEN',
      reason: 'Typos reported in Lesson 04',
    });
  });

  it('EXPORT_PACKAGE records the exported version and where the next publish starts', async () => {
    const create = jest.fn().mockResolvedValue({});
    const { service } = publishing({
      courseVersion: {
        update: jest.fn().mockResolvedValue({
          id: 'v4',
          courseId: 'course-1',
          versionNo: 4,
          versionLabel: '3.4',
          versionSeries: 3,
          versionMinor: 4,
        }),
      },
      courseAuthoringActivity: { create },
    });

    await service.markExported('v4', 'emp-1');

    const data = activityData(create);
    expect(data.action).toBe(HISTORY_ACTIONS.EXPORT_PACKAGE);
    expect(data.versionNo).toBe(4);
    // PRD §21 "Export package — Version 3.4 · next publish starts 4.1"
    expect(data.detail).toEqual(
      expect.objectContaining({
        versionLabel: '3.4',
        versionNo: 4,
        nextVersionLabel: '4.1',
      }),
    );
  });

  it('IMPORT_PACKAGE detail can carry the package identifier', () => {
    expect(importedDraftHistoryDetail('C001_4.2.zip')).toEqual({
      from: 'Draft',
      to: 'C001_4.2.zip',
    });
  });
});

describe('History — Create course (PRD §21)', () => {
  it('records the Course ID, learning mode and learning languages', async () => {
    const recordHistory = jest.fn().mockResolvedValue({});
    const prisma = {
      courseCatalogueEntry: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'cat-1', status: 'ACTIVE', parentId: null }),
      },
      commerceCourse: {
        create: jest.fn().mockResolvedValue({ id: 'course-1' }),
      },
    };
    const service = new CommerceCoursesService(
      prisma as never,
      {} as never,
      { recordHistory } as never,
    );
    jest.spyOn(service, 'detail').mockResolvedValue({} as never);

    await service.createCourse(
      {
        code: 'C001',
        title: 'Modeling life',
        language: 'en-GB',
        learningMode: 'VIDEO_AND_TEXT',
        categoryId: 'cat-1',
      },
      'emp-1',
    );

    expect(recordHistory).toHaveBeenCalledWith(
      'course-1',
      HISTORY_ACTIONS.CREATE_COURSE,
      // PRD §21 "C001 · Video and Text · English"；强制双语（PRD 11.5）后默认中英双开。
      expect.objectContaining({
        code: 'C001',
        learningMode: 'VIDEO_AND_TEXT',
        learningLanguages: ['en-GB', 'zh-CN'],
      }),
      'emp-1',
    );
  });
});

describe('History — Add learning language (PRD §21)', () => {
  function coursesService() {
    const recordHistory = jest.fn().mockResolvedValue({});
    const prisma = {
      commerceCourse: {
        findUnique: jest.fn().mockResolvedValue({
          code: 'C001',
          learningMode: 'VIDEO_ONLY',
          learningLanguages: ['en-GB'],
          categoryId: null,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const service = new CommerceCoursesService(
      prisma as never,
      {} as never,
      { recordHistory } as never,
    );
    jest.spyOn(service, 'detail').mockResolvedValue({} as never);
    return { service, recordHistory };
  }

  it('writes ADD_LEARNING_LANGUAGE with the old and new language lists', async () => {
    const { service, recordHistory } = coursesService();
    const updateCourse = (
      service.updateCourse as unknown as (
        id: string,
        body: unknown,
        actorEmployeeId: string | null,
      ) => Promise<unknown>
    ).bind(service);

    await updateCourse(
      'course-1',
      { learningLanguages: ['en-GB', 'zh-CN'] },
      'emp-1',
    );

    expect(recordHistory).toHaveBeenCalledWith(
      'course-1',
      HISTORY_ACTIONS.ADD_LEARNING_LANGUAGE,
      { from: ['en-GB'], to: ['en-GB', 'zh-CN'] },
      'emp-1',
    );
  });

  it('does not write history when no language is added', async () => {
    const { service, recordHistory } = coursesService();
    const updateCourse = (
      service.updateCourse as unknown as (
        id: string,
        body: unknown,
        actorEmployeeId: string | null,
      ) => Promise<unknown>
    ).bind(service);

    await updateCourse('course-1', { learningLanguages: ['en-GB'] }, 'emp-1');

    expect(recordHistory).not.toHaveBeenCalled();
  });
});
