import { buildMinimalMp4 } from '../partc/compiler/parse.fixtures';
import {
  compilePartcPackage,
  decodeTemplateWorkbook,
  isPartCV2Manifest,
} from './partc-import';
import { assemblePartcPackage, partcIdentityFromCourse } from './partc-export';
import type { PackageCourse } from './contracts/manifest';
import type { PackageProvenance } from '../partc/contracts/package-manifest';

/**
 * Part C v2 包导出 → 导入闭环（单测，无数据库）：
 * exporter 产出的 manifest/模板/资源必须能通过同一契约与编译器管线
 * （parse→validate→deriveTiming→align），且分类路径、provenance、章节时间源
 * 原样往返。评审阻断 2/3（v2 契约 SSOT + round-trip）。
 */

const DURATION_MS = 60_000;

function legacyCourse(): PackageCourse {
  return {
    code: 'RT-001',
    slug: 'rt-001',
    categoryPath: ['Society', 'Sociology'],
    learningMode: 'VIDEO_ONLY',
    learningLanguages: ['en-GB'],
    defaultContentLanguage: 'en-GB',
    cover: 'media/cover.png',
    localized: {
      'en-GB': {
        title: 'Round trip course',
        shortDescription: 'short',
        overview: 'overview',
        whatYouLearn: ['one', 'two'],
      },
    },
    lessons: [
      {
        code: 'L1',
        order: 1,
        localized: {
          'en-GB': {
            title: 'First lesson',
            video: {
              file: 'media/video/L1/en-GB.mp4',
              durationSeconds: DURATION_MS / 1000,
              learningPoints: [
                { code: '1.1', timeSeconds: 5, title: 'Why models matter' },
                { code: '1.2', timeSeconds: 20, title: 'Here is a model' },
              ],
              exhibitTriggers: [],
            },
          },
        },
        exhibits: [
          {
            code: 'ex-1',
            type: 'IMAGE',
            file: 'media/exhibits/ex-1.png',
            thumbnail: 'media/exhibits/ex-1.thumb.png',
            localized: {
              'en-GB': { title: 'A model', description: 'A model photo' },
            },
          },
        ],
        knowledgeTest: {
          enabled: true,
          questions: [
            {
              code: 'q1',
              question: 'What is a model?',
              referenceAnswer: 'A representation',
            },
          ],
        },
        applicationTest: {
          enabled: true,
          scenario: 'Apply modeling.',
          referenceAnswer: 'Any model',
        },
      },
    ],
    trial: { enabled: false, lessons: [] },
  };
}

describe('Part C v2 package export → import round trip (unit)', () => {
  it('exports a v2 package whose manifest/模板/资源 pass the same contract and compiler', async () => {
    const course = legacyCourse();
    const media = new Map<string, Buffer>([
      ['media/cover.png', Buffer.from([137, 80, 78, 71, 1])],
      ['media/video/L1/en-GB.mp4', Buffer.from(buildMinimalMp4(DURATION_MS))],
      ['media/exhibits/ex-1.png', Buffer.from([137, 80, 78, 71, 2])],
      ['media/exhibits/ex-1.thumb.png', Buffer.from([137, 80, 78, 71, 3])],
    ]);
    const provenance = {
      sourceEnv: 'sandbox',
      sourceVersionLabel: '4.2',
      exportedAt: '2026-11-12T08:00:00Z',
      exportedBy: 'operator@example.com',
      courseKey: 'RT-001',
      planPin: {
        planId: 'plan/RT-001/export-4.2/target-default/v1',
        planVersion: 1,
      },
      approvalRef: 'unapproved-export:RT-001',
      auditSummaryRef: 'audit/RT-001/4.2.json',
      // C7/C10.6：ASR 模型/参数/规则 pin 随 provenance 原样往返。
      asr: {
        modelVersion: 'whisper-large-v3',
        params: { beamSize: 5 },
        ruleVersion: 'asr-rules-v1',
      },
    } as unknown as PackageProvenance;

    const assembled = await assemblePartcPackage(course, media, {
      identity: partcIdentityFromCourse(course, { versionNo: 3 }),
      provenance,
      annotations: { slug: 'rt-001', versionLabel: '4.2' },
      exportedAt: '2026-11-12T08:00:00Z',
    });

    expect(isPartCV2Manifest(assembled.manifest)).toBe(true);
    const manifest = assembled.manifest;
    expect(manifest.formatVersion).toBe(2);
    expect(manifest.course.categoryPath).toEqual(['Society', 'Sociology']);
    expect(manifest.provenance?.sourceEnv).toBe('sandbox');
    expect(manifest.provenance?.asr).toEqual({
      modelVersion: 'whisper-large-v3',
      params: { beamSize: 5 },
      ruleVersion: 'asr-rules-v1',
    });
    expect(manifest.annotations?.slug).toBe('rt-001');
    // 无哈希清单：包内不得出现 checksums 文件（资源闭合由 manifest 承担）。
    expect(manifest.resources.some((r) => /checksums/.test(r.path))).toBe(
      false,
    );
    // 分类路径全链（二级分类不丢父级）。
    expect(manifest.content.categoryPath).toEqual(['Society', 'Sociology']);

    // 解包（内存）后走同一编译器管线。
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(assembled.bytes);
    const files = new Map<string, Uint8Array>();
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      files.set(entry.name, await entry.async('uint8array'));
    }
    const templateBytes = files.get('template.xlsx');
    expect(templateBytes).toBeDefined();
    const workbook = decodeTemplateWorkbook(Buffer.from(templateBytes!));
    const compiled = compilePartcPackage({
      manifest,
      files,
      workbook,
    });
    expect(
      compiled.issues.filter((issue) => issue.severity === 'error'),
    ).toEqual([]);
    // 章节源 → 按学习点标题派生毫秒区间（C7）。
    const lp1 = compiled.timing.coordinates.find(
      (coordinate) => coordinate.kind === 'lp' && coordinate.code === '1.1',
    );
    const lp2 = compiled.timing.coordinates.find(
      (coordinate) => coordinate.kind === 'lp' && coordinate.code === '1.2',
    );
    expect(lp1?.startMs).toBe(5000);
    // C7：点锚点 end = 下一个锚点 - 1ms（[start,end) 半开区间）。
    expect(lp1?.endMs).toBe(19999);
    expect(lp2?.startMs).toBe(20000);
    expect(lp2?.endMs).toBe(DURATION_MS);
    expect(lp1?.anchorSource).toBe('chapter');
  });
});
