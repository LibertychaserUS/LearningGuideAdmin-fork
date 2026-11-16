import { PackageJobsService } from './package-jobs.service';
import { PackageError } from './package-inspector';

/**
 * EXPORT-BYPASS（PRD §16.2：『导出的是当前线上版本（已发布到 Sandbox、测试过的），
 * 不能选草稿/其他版本』，Aligned Design §16.2 L177）回归测试。
 *
 * 红：旧实现 versionLabel='working'/'draft'/指定版本号均跳过 assertExportable
 * 直接建作业。默认拒绝用例在旧代码下不抛错 → 红。
 *
 * 开关：ALLOW_DRAFT_EXPORT=on（仅 'on'|'true'|'1'）放行草稿/历史版本，用于
 * Sandbox 调试；缺省或垃圾值一律关闭（fail closed）。
 *
 * R16：环境语义未配置（config.environmentDetermined 非 true）时导出拒绝，
 * 不静默写 sourceEnv=sandbox。
 */

function buildService(configOverrides: Record<string, unknown> = {}) {
  const prisma = {
    commerceCourse: {
      findUnique: jest.fn().mockResolvedValue({ code: 'C001' }),
    },
    courseVersion: {
      findFirst: jest.fn().mockResolvedValue({ id: 'v2', versionLabel: '1.2' }),
    },
    coursePackageJob: {
      create: jest.fn().mockResolvedValue({ id: 'job-1' }),
    },
  };
  const publishing = {
    assertExportable: jest
      .fn()
      .mockResolvedValue({ versionId: 'v-live', versionLabel: '1.2' }),
  };
  const config = {
    environmentDetermined: true,
    versionNumberingMode: 'sandbox',
    ...configOverrides,
  };
  const service = new PackageJobsService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    publishing as never,
    config as never,
  );
  return { service, prisma, publishing };
}

async function expectCode(
  promise: Promise<unknown>,
  code: string,
  status: number,
): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PackageError);
  expect((error as PackageError).code).toBe(code);
  expect((error as PackageError).httpStatus).toBe(status);
}

describe('startExport — PRD §16.2 live-version-only gate (EXPORT-BYPASS)', () => {
  const original = process.env.ALLOW_DRAFT_EXPORT;

  afterEach(() => {
    if (original === undefined) delete process.env.ALLOW_DRAFT_EXPORT;
    else process.env.ALLOW_DRAFT_EXPORT = original;
  });

  it('denies draft export by default (version working)', async () => {
    delete process.env.ALLOW_DRAFT_EXPORT;
    const { service } = buildService();
    await expectCode(
      service.startExport('course-1', 'emp-1', 'working'),
      'EXPORT_LIVE_VERSION_ONLY',
      409,
    );
  });

  it('denies draft export by default (version draft)', async () => {
    delete process.env.ALLOW_DRAFT_EXPORT;
    const { service } = buildService();
    await expectCode(
      service.startExport('course-1', 'emp-1', 'draft'),
      'EXPORT_LIVE_VERSION_ONLY',
      409,
    );
  });

  it('denies historical version export by default', async () => {
    delete process.env.ALLOW_DRAFT_EXPORT;
    const { service, prisma } = buildService();
    await expectCode(
      service.startExport('course-1', 'emp-1', '1.2'),
      'EXPORT_LIVE_VERSION_ONLY',
      409,
    );
    expect(prisma.courseVersion.findFirst).not.toHaveBeenCalled();
  });

  it('allows draft export when ALLOW_DRAFT_EXPORT=on', async () => {
    process.env.ALLOW_DRAFT_EXPORT = 'on';
    const { service, prisma } = buildService();
    const result = await service.startExport('course-1', 'emp-1', 'working');
    expect(result.status).toBe('EXPORTING');
    const callArgs = prisma.coursePackageJob.create.mock.calls[0] as [
      { data: { kind: string; sourceVersionId: string | null } },
    ];
    expect(callArgs[0].data.kind).toBe('EXPORT');
    expect(callArgs[0].data.sourceVersionId).toBeNull();
  });

  it('allows historical version export when ALLOW_DRAFT_EXPORT=on', async () => {
    process.env.ALLOW_DRAFT_EXPORT = 'on';
    const { service } = buildService();
    const result = await service.startExport('course-1', 'emp-1', '1.2');
    expect(result.versionId).toBe('v2');
    expect(result.versionLabel).toBe('1.2');
  });

  it('fails closed on unrecognized switch values', async () => {
    for (const value of ['yes', 'truee', '', 'on\x00']) {
      process.env.ALLOW_DRAFT_EXPORT = value;
      const { service } = buildService();
      await expectCode(
        service.startExport('course-1', 'emp-1', 'working'),
        'EXPORT_LIVE_VERSION_ONLY',
        409,
      );
    }
  });

  it('keeps the default live-version path unchanged (assertExportable still gates)', async () => {
    delete process.env.ALLOW_DRAFT_EXPORT;
    const { service, publishing } = buildService();
    const result = await service.startExport('course-1', 'emp-1');
    expect(publishing.assertExportable).toHaveBeenCalledWith('course-1');
    expect(result.versionId).toBe('v-live');
  });
});

describe('startExport — environment semantics gate (R16)', () => {
  it('refuses export with actionable error when the environment is not configured', async () => {
    const { service } = buildService({ environmentDetermined: false });
    await expectCode(
      service.startExport('course-1', 'emp-1'),
      'ENVIRONMENT_NOT_CONFIGURED',
      500,
    );
  });

  it('refuses draft export too when the environment is not configured (gate precedes the draft switch)', async () => {
    process.env.ALLOW_DRAFT_EXPORT = 'on';
    const { service } = buildService({ environmentDetermined: false });
    await expectCode(
      service.startExport('course-1', 'emp-1', 'working'),
      'ENVIRONMENT_NOT_CONFIGURED',
      500,
    );
  });

  it('refuses when the config field is absent (fail closed)', async () => {
    const { service } = buildService({});
    // 显式模拟字段缺失（域外字面量构造可能不提供该字段）。
    const lacking = new PackageJobsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { versionNumberingMode: 'sandbox' } as never,
    );
    await expectCode(
      lacking.startExport('course-1', 'emp-1'),
      'ENVIRONMENT_NOT_CONFIGURED',
      500,
    );
    expect(service).toBeTruthy();
  });
});
