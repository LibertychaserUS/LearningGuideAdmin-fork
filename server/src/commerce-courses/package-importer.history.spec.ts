import { PackageImporter } from './package-importer';
import { HISTORY_ACTIONS } from './publishing.service';
import { buildPartcVersionSnapshot } from './partc-import';
import type { PackageManifest } from './contracts/manifest';
import type { PackageManifestV2 } from '../partc/contracts/package-manifest';

jest.mock('./version-snapshot', () => {
  const actual = jest.requireActual('./version-snapshot');
  return { ...actual, applyVersionSnapshotInTx: jest.fn() };
});

jest.mock('./partc-import', () => {
  const actual = jest.requireActual('./partc-import');
  return {
    ...actual,
    buildPartcVersionSnapshot: jest.fn(() => ({})),
    persistPartcEntities: jest.fn(),
  };
});

interface ActivityData {
  action: string;
  detail: Record<string, unknown>;
}

function activityData(create: jest.Mock): ActivityData {
  const call = create.mock.calls[0] as [{ data: ActivityData }];
  return call[0].data;
}

function legacyManifest(): PackageManifest {
  return {
    format: 'lg-course-package',
    formatVersion: 2,
    packageId: 'pkg_C001_4',
    exportedAt: new Date().toISOString(),
    source: {
      environment: 'sandbox',
      courseCode: 'C001',
      sourceVersion: '4.2',
    },
    incomplete: false,
    course: {
      code: 'C001',
      slug: 'c001',
      categoryPath: null,
      learningMode: 'VIDEO_ONLY',
      learningLanguages: ['en-GB'],
      defaultContentLanguage: 'en-GB',
      localized: { 'en-GB': { title: 'Modeling life' } },
      lessons: [],
      trial: { enabled: false, lessons: [] },
      pricing: [],
    },
  };
}

function partcManifest(): PackageManifestV2 {
  return {
    format: 'lg-course-package',
    formatVersion: 2,
    packageId: 'pkg_C001_4',
    exportedAt: '2026-11-13T00:00:00Z',
    minReaderVersion: 2,
    extensionsUsed: [],
    extensionsRequired: [],
    course: {
      courseKey: 'C001',
      titleLocalized: { 'en-GB': { title: 'Modeling life' } },
      categoryPath: null,
      learningLanguages: ['en-GB'],
      studyMode: 'video',
    },
    content: {
      courseKey: 'C001',
      versionNo: 4,
      categoryPath: null,
      stages: [
        {
          courseKey: 'C001',
          stageKey: 'program-C001',
          parentStageKey: null,
          orderKey: '000001',
          kind: 'program',
          goal: 'Modeling life',
          objectiveKeys: [],
          exitEvidence: [],
          exitRollup: { kind: 'all' },
          status: 'active',
        },
      ],
      prerequisiteEdges: [],
      specPins: [],
      renditions: [],
      alignments: [],
      evidenceSpecs: [],
      assetPins: [],
    },
    resources: [{ id: 'template', kind: 'template', path: 'template.xlsx', size: 1 }],
    provenance: {
      sourceEnv: 'sandbox',
      sourceVersionLabel: '4.2',
      exportedAt: '2026-11-13T00:00:00Z',
      exportedBy: 'operator@example.com',
      courseKey: 'C001',
      planPin: {
        planId: 'plan/C001/content-v4/target-default/v1',
        planVersion: 1,
      },
      approvalRef: 'APR-DEMO-0001',
      auditSummaryRef: 'audit/C001/v4.json',
    },
  } as unknown as PackageManifestV2;
}

function importerWithTx(tx: Record<string, unknown>, existing: Record<string, unknown>) {
  const prisma = {
    commerceCourse: {
      findUnique: jest.fn().mockResolvedValue(existing),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
  };
  return new PackageImporter(prisma as never, {} as never, {} as never);
}

describe('PackageImporter History detail — PRD §21 Create course', () => {
  it('legacy import that creates a course writes CREATE_COURSE with mode, language and package file', async () => {
    const create = jest.fn().mockResolvedValue({});
    const tx = {
      commerceCourse: { create: jest.fn().mockResolvedValue({}) },
      courseAuthoringActivity: { create },
    };
    const importer = importerWithTx(tx, {
      id: 'course-1',
      code: 'C001',
      slug: 'c001',
    });
    jest
      .spyOn(importer as never, 'transferMedia' as never)
      .mockResolvedValue(undefined as never);

    await (
      importer as unknown as {
        importPackage: (
          manifest: PackageManifest,
          files: Map<string, Buffer>,
          options: Record<string, unknown>,
        ) => Promise<unknown>;
      }
    ).importPackage(legacyManifest(), new Map(), {
      onConflict: 'ABORT',
      reassignCodes: false,
      actorEmployeeId: 'emp-1',
    });

    const data = activityData(create);
    expect(data.action).toBe(HISTORY_ACTIONS.CREATE_COURSE);
    // PRD §21 "C001 · Video and Text · English / Created from package C001_1.3.zip"
    expect(data.detail).toEqual(
      expect.objectContaining({
        code: 'C001',
        learningMode: 'VIDEO_ONLY',
        learningLanguages: ['en-GB'],
        sourcePackage: 'C001_4.2.zip',
      }),
    );
  });

  it('Part C import that creates a course writes CREATE_COURSE with the package file', async () => {
    const create = jest.fn().mockResolvedValue({});
    const tx = {
      commerceCourse: { create: jest.fn().mockResolvedValue({}) },
      courseAuthoringActivity: { create },
    };
    const importer = importerWithTx(tx, {
      id: 'course-1',
      code: 'C001',
      slug: 'c001',
    });
    jest
      .spyOn(importer as never, 'compilePartcPackage' as never)
      .mockResolvedValue({} as never);
    jest.spyOn(importer as never, 'transferPartcMedia' as never).mockResolvedValue({
      uriByPath: new Map(),
      assetIdByPath: new Map(),
      extensionByPath: new Map(),
      mediaMetas: [],
      storageKeys: [],
      mediaAssetIds: [],
    } as never);
    jest.spyOn(importer as never, 'resolvePartcCategory' as never).mockResolvedValue(null as never);
    jest.spyOn(importer as never, 'createPartcMediaRows' as never).mockResolvedValue(undefined as never);
    (buildPartcVersionSnapshot as unknown as jest.Mock).mockReturnValue({
      course: {
        learningMode: 'VIDEO_AND_TEXT',
        learningLanguages: ['en-GB'],
        defaultContentLanguage: 'en-GB',
        localizations: [],
      },
    });

    await (
      importer as unknown as {
        importPackage: (
          manifest: PackageManifestV2,
          files: Map<string, Buffer>,
          options: Record<string, unknown>,
        ) => Promise<unknown>;
      }
    ).importPackage(partcManifest(), new Map(), {
      onConflict: 'ABORT',
      reassignCodes: false,
      actorEmployeeId: 'emp-1',
    });

    const data = activityData(create);
    expect(data.action).toBe(HISTORY_ACTIONS.CREATE_COURSE);
    expect(data.detail).toEqual(
      expect.objectContaining({
        code: 'C001',
        learningMode: 'VIDEO_AND_TEXT',
        learningLanguages: ['en-GB'],
        sourcePackage: 'C001_4.2.zip',
      }),
    );
  });
});

describe('PackageImporter History detail — PRD §21 Import package', () => {
  it('legacy import writes "Draft replaced · file name" using the source version file name', async () => {
    const create = jest.fn().mockResolvedValue({});
    const tx = {
      commerceCourse: { update: jest.fn().mockResolvedValue({}) },
      lesson: { findMany: jest.fn().mockResolvedValue([]) },
      learningPoint: { findMany: jest.fn().mockResolvedValue([]) },
      trialSetting: { deleteMany: jest.fn().mockResolvedValue({}) },
      coursePlan: { updateMany: jest.fn().mockResolvedValue({}) },
      courseAuthoringActivity: { create },
    };
    const importer = importerWithTx(tx, {
      id: 'course-1',
      code: 'C001',
      slug: 'c001',
    });
    jest.spyOn(importer as never, 'transferMedia' as never).mockResolvedValue(undefined as never);
    jest.spyOn(importer as never, 'createMediaRows' as never).mockResolvedValue(undefined as never);
    jest.spyOn(importer as never, 'snapshotFromPackage' as never).mockReturnValue({} as never);

    await (
      importer as unknown as {
        importIntoExistingCourse: (
          courseId: string,
          manifest: PackageManifest,
          files: Map<string, Buffer>,
          actor: string | null,
        ) => Promise<unknown>;
      }
    ).importIntoExistingCourse('course-1', legacyManifest(), new Map(), 'emp-1');

    const data = activityData(create);
    expect(data.action).toBe(HISTORY_ACTIONS.IMPORT_PACKAGE);
    expect(data.detail).toEqual(
      expect.objectContaining({ from: 'Draft', to: 'C001_4.2.zip' }),
    );
  });

  it('Part C import writes the same "Draft replaced · file name" detail', async () => {
    const create = jest.fn().mockResolvedValue({});
    const tx = {
      commerceCourse: { update: jest.fn().mockResolvedValue({}) },
      courseAuthoringActivity: { create },
    };
    const importer = importerWithTx(tx, {
      id: 'course-1',
      code: 'C001',
      slug: 'c001',
    });
    jest
      .spyOn(importer as never, 'compilePartcPackage' as never)
      .mockResolvedValue({} as never);
    jest.spyOn(importer as never, 'transferPartcMedia' as never).mockResolvedValue({
      uriByPath: new Map(),
      assetIdByPath: new Map(),
      extensionByPath: new Map(),
      mediaMetas: [],
      storageKeys: [],
      mediaAssetIds: [],
    } as never);
    jest.spyOn(importer as never, 'resolvePartcCategory' as never).mockResolvedValue(null as never);
    jest.spyOn(importer as never, 'createPartcMediaRows' as never).mockResolvedValue(undefined as never);

    await (
      importer as unknown as {
        importPartcIntoExistingCourse: (
          courseId: string,
          manifest: PackageManifestV2,
          files: Map<string, Buffer>,
          actor: string | null,
        ) => Promise<unknown>;
      }
    ).importPartcIntoExistingCourse(
      'course-1',
      partcManifest(),
      new Map(),
      'emp-1',
    );

    const data = activityData(create);
    expect(data.action).toBe(HISTORY_ACTIONS.IMPORT_PACKAGE);
    expect(data.detail).toEqual(
      expect.objectContaining({ from: 'Draft', to: 'C001_4.2.zip' }),
    );
  });
});
