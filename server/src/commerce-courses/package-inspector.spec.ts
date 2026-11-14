import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { PackageInspector } from './package-inspector';
import { CourseStorageService } from './storage.service';
import { LEGACY_PACKAGE_FORMAT_VERSION } from './contracts/manifest';
import { TEMPLATE_V2_HEADERS } from '../partc/contracts';
import type { CommerceCourseConfig } from './commerce.config';

function testConfig(): CommerceCourseConfig {
  return {
    environmentLabel: 'test',
    publicSiteUrl: 'http://localhost',
    versionNumberingMode: 'sandbox',
    mediaRoot: '/tmp/lg-media',
    packageStagingRoot: '/tmp/lg-staging',
    maxImageBytes: 20 * 1024 * 1024,
    maxVideoBytes: 500 * 1024 * 1024,
    maxAudioBytes: 100 * 1024 * 1024,
    maxPdfBytes: 100 * 1024 * 1024,
    maxModelBytes: 25 * 1024 * 1024,
    packageMaxBytes: 8 * 1024 * 1024 * 1024,
    packageDirectUploadBytes: 200 * 1024 * 1024,
    packageExportTtlHours: 24,
    jobConcurrency: 2,
    jobPollMs: 2000,
    jobHeartbeatMs: 10000,
    jobStaleMs: 600000,
    jobMaxAttempts: 3,
  };
}

// Minimal valid PNG (1x1) signature + payload
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
);

const COURSE_KEY = 'C900';
const LESSON_CODE = 'L001';

/** Part C v2 模板工作簿（契约列名来自唯一 schema 源；模板无任何时间列）。 */
function buildTemplateWorkbook(): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = (name: keyof typeof TEMPLATE_V2_HEADERS, rows: unknown[][]) =>
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([[...TEMPLATE_V2_HEADERS[name]], ...rows]),
      name,
    );
  sheet('Meta', [[2, COURSE_KEY, 'en-GB', 'text']]);
  sheet('Media', []);
  sheet('Course Info', [
    ['title', 'en-GB', 'Test'],
    ['shortDescription', 'en-GB', 'desc'],
    ['overview', 'en-GB', 'ov'],
    ['whatYouLearn', 'en-GB', 'a'],
  ]);
  sheet('Lessons', [[LESSON_CODE, 1, 'en-GB', 'Lesson 1', 'Lesson desc']]);
  sheet('Learning Points', [[LESSON_CODE, '1.1', 'en-GB', 'Point one']]);
  sheet('Exhibits', []);
  sheet('Reading List', []);
  sheet('Knowledge Test', []);
  sheet('Application Test', []);
  return XLSX.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx',
  }) as Buffer;
}

/**
 * Part C v2 manifest（唯一 v2 契约 SSOT 形状）。
 * 评审阻断 2：legacy 聚合形状（course.lessons）不再被任何测试当作 v2 夹具。
 */
function partcManifest(
  resources: Array<{ id: string; kind: string; path: string; size: number }>,
) {
  return {
    format: 'lg-course-package',
    formatVersion: 2,
    packageId: 'pkg_test',
    exportedAt: new Date().toISOString(),
    minReaderVersion: 2,
    extensionsUsed: [],
    extensionsRequired: [],
    course: {
      courseKey: COURSE_KEY,
      titleLocalized: { 'en-GB': { title: 'Test' } },
      categoryPath: ['Science'],
      learningLanguages: ['en-GB'],
      studyMode: 'text',
    },
    content: {
      courseKey: COURSE_KEY,
      versionNo: 1,
      categoryPath: ['Science'],
      stages: [
        {
          courseKey: COURSE_KEY,
          stageKey: 'step-C900',
          parentStageKey: null,
          orderKey: '000001',
          kind: 'step',
          goal: 'Test',
          objectiveKeys: ['obj-C900'],
          exitEvidence: ['ev-C900'],
          exitRollup: { kind: 'all' },
          status: 'active',
        },
      ],
      prerequisiteEdges: [],
      specPins: [{ contentKey: LESSON_CODE, version: 1 }],
      renditions: [],
      alignments: [],
      evidenceSpecs: [
        {
          evidenceKey: 'ev-C900',
          version: 1,
          kind: 'artifact',
          objectiveKeys: ['obj-C900'],
          measure: { kind: 'artifact', instructions: 'Complete the course.' },
          scoring: 'pass-fail',
          threshold: 1,
          attempts: 1,
        },
      ],
      assetPins: [],
    },
    resources,
  };
}

function templateResource(size: number) {
  return [
    { id: 'template', kind: 'template', path: 'template.xlsx', size },
  ] as Array<{ id: string; kind: string; path: string; size: number }>;
}

function inspector() {
  return new PackageInspector(testConfig(), {} as CourseStorageService);
}

describe('PackageInspector', () => {
  it('accepts a valid Part C v2 package', async () => {
    const template = buildTemplateWorkbook();
    const zip = new JSZip();
    zip.file(
      'manifest.json',
      JSON.stringify(partcManifest(templateResource(template.length))),
    );
    zip.file('template.xlsx', template);
    const result = await inspector().inspect(
      await zip.generateAsync({ type: 'nodebuffer' }),
    );
    expect(result.report.errors.length).toBe(0);
    expect(result.report.details?.contract).toBe('partc-v2');
  });

  it('rejects a package carrying an undeclared checksums.sha256 (closed package, no hash manifests)', async () => {
    const template = buildTemplateWorkbook();
    const zip = new JSZip();
    zip.file(
      'manifest.json',
      JSON.stringify(partcManifest(templateResource(template.length))),
    );
    zip.file('template.xlsx', template);
    zip.file('checksums.sha256', `${'a'.repeat(64)}  template.xlsx`);
    await expect(
      inspector().inspect(await zip.generateAsync({ type: 'nodebuffer' })),
    ).rejects.toMatchObject({
      code: 'PACKAGE_FILE_UNKNOWN',
    });
  });

  it('rejects the retired raw material package marker (legacy, not v2)', async () => {
    // raw 素材导入已退役：excel-package 产物带 legacy 标记与 EXCEL_* 来源。
    const manifest = {
      format: 'lg-course-package',
      formatVersion: LEGACY_PACKAGE_FORMAT_VERSION,
      packageId: 'raw-template-test',
      exportedAt: new Date().toISOString(),
      source: { environment: 'EXCEL_TEMPLATE', courseCode: COURSE_KEY },
      incomplete: false,
      course: {
        code: COURSE_KEY,
        slug: 'test-course',
        categoryPath: null,
        learningMode: 'TEXT_ONLY',
        learningLanguages: ['en-GB'],
        defaultContentLanguage: 'en-GB',
        localized: { 'en-GB': { title: 'Test' } },
        lessons: [],
      },
    };
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify(manifest));
    await expect(
      inspector().inspect(await zip.generateAsync({ type: 'nodebuffer' })),
    ).rejects.toMatchObject({
      code: 'PACKAGE_FORMAT_UNSUPPORTED',
    });
  });

  it('rejects invalid zip', async () => {
    await expect(
      inspector().inspect(Buffer.from('not a zip')),
    ).rejects.toMatchObject({
      code: 'PACKAGE_INVALID_ZIP',
    });
  });

  it('explains that a Word document is not a course package', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('word/document.xml', '<document/>');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(inspector().inspect(buf)).rejects.toMatchObject({
      code: 'PACKAGE_NOT_A_COURSE',
      status: 422,
      message: expect.stringContaining('Word/Office document') as unknown,
    });
  });

  it('rejects a manifest resource that the package does not deliver', async () => {
    const template = buildTemplateWorkbook();
    const resources = [
      ...templateResource(template.length),
      { id: 'cover', kind: 'cover', path: 'media/cover.png', size: PNG.length },
    ];
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify(partcManifest(resources)));
    zip.file('template.xlsx', template);
    // media/cover.png intentionally omitted
    await expect(
      inspector().inspect(await zip.generateAsync({ type: 'nodebuffer' })),
    ).rejects.toMatchObject({
      code: 'PACKAGE_FILE_MISSING',
    });
  });
});
