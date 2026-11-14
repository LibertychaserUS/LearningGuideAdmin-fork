import { canonicalJson } from '../contracts';
import {
  ALIGN_RULE_VERSION,
  alignPackage,
  initialAssetVersions,
} from './align';
import type { AlignResult, AlignmentSeed } from './align';
import { deriveTiming } from './derive-timing';
import type {
  DocumentStructureInput,
  TranscriptArtifactInput,
} from './derive-timing';
import { parsePackage } from './parse';
import type { PackageIR, RawPackage, RawWorkbook } from './parse';
import { validatePackage } from './validate';
import type { ValidatedRows } from './validate';
import {
  EXHIBIT_CODE,
  LESSON_CODE,
  LP_CODE,
  buildDocuments,
  buildPackageFixture,
  buildWorkbook,
  clone,
  priorContent,
  removeResource,
  replaceResourceBytes,
} from './parse.fixtures';

/**
 * P4 align 单元测试（设计 §14 C5 P4 / C3 / C4）。
 * 覆盖：ContentSpec/Block/Rendition 派生、坐标单源、proposed Alignment
 * （import/legacy、rebound/stale）、显式 binding seeds、superseded、确定性与 golden。
 */

type MutableWorkbook = {
  sheets: Record<string, { headers: unknown[]; rows: unknown[][] }>;
};

interface InputConfig {
  readonly content?: unknown;
  readonly mutateWorkbook?: (workbook: MutableWorkbook) => void;
  readonly removeResources?: readonly string[];
  readonly replaceResources?: ReadonlyArray<readonly [string, Uint8Array]>;
  readonly documents?: readonly DocumentStructureInput[];
  readonly transcripts?: readonly TranscriptArtifactInput[];
}

function buildPipeline(
  config: InputConfig = {},
  options: {
    readonly assetVersions?: Readonly<Record<string, number>>;
    readonly bindingSeeds?: readonly AlignmentSeed[];
  } = {},
): {
  ir: PackageIR;
  rows: ValidatedRows;
  timing: ReturnType<typeof deriveTiming>;
  result: AlignResult;
} {
  const workbook = clone(buildWorkbook()) as unknown as MutableWorkbook;
  config.mutateWorkbook?.(workbook);
  let pkg: RawPackage = buildPackageFixture({
    content: config.content,
    workbook: workbook as unknown as RawWorkbook,
  }).pkg;
  for (const resourceId of config.removeResources ?? []) {
    pkg = removeResource(pkg, resourceId);
  }
  for (const [resourceId, bytes] of config.replaceResources ?? []) {
    pkg = replaceResourceBytes(pkg, resourceId, bytes);
  }
  const ir = parsePackage(pkg);
  const rows = validatePackage(ir).rows;
  const documents = config.documents ?? buildDocuments();
  const timing = deriveTiming({
    ir,
    rows,
    documents,
    ...(config.transcripts === undefined
      ? {}
      : { transcripts: config.transcripts }),
  });
  const result = alignPackage({
    ir,
    rows,
    timing,
    documents,
    options: {
      assetVersions: options.assetVersions ?? initialAssetVersions(rows),
      ...(options.bindingSeeds === undefined
        ? {}
        : { bindingSeeds: options.bindingSeeds }),
    },
  });
  return { ir, rows, timing, result };
}

function renditionByAnchor(
  result: AlignResult,
  predicate: (rendition: AlignResult['renditions'][number]) => boolean,
): AlignResult['renditions'][number] | undefined {
  return result.renditions.find(predicate);
}

describe('P4 ContentSpec/Block 派生（C3/P4）', () => {
  it('derives main/reading/knowledge-test/application-test specs with stable blockIds', () => {
    const { result } = buildPipeline();
    expect(result.issues).toEqual([]);
    expect(result.ruleVersion).toBe(ALIGN_RULE_VERSION);
    expect(result.contentSpecs.map((spec) => spec.contentKey)).toEqual([
      'lesson-01',
      'lesson-01.application-test',
      'lesson-01.knowledge-test',
      'lesson-01.reading',
    ]);
    const main = result.contentSpecs[0];
    expect(main.type).toBe('video');
    expect(main.blocks.map((block) => block.blockId)).toEqual([
      'video',
      'body',
      'ex-01',
    ]);
    expect(main.titleLocalized).toEqual({
      'en-GB': { title: 'Why models matter' },
      'zh-CN': { title: '为什么模型重要' },
    });

    const kt = result.contentSpecs.find(
      (spec) => spec.type === 'knowledge-test',
    );
    expect(kt?.blocks).toHaveLength(1);
    expect(kt?.blocks[0].blockId).toBe('q.1');
    const payload = kt?.blocks[0].payload as {
      kind: string;
      questionLocalized: Record<string, { question: string }>;
    };
    expect(payload.kind).toBe('question');
    expect(payload.questionLocalized['zh-CN'].question).toBe('什么是模型？');

    const reading = result.contentSpecs.find((spec) => spec.type === 'reading');
    expect(reading?.blocks.map((block) => block.blockId)).toEqual([
      'reading.1',
    ]);
    expect((reading?.blocks[0].payload as { html: string }).html).toContain(
      'Thinking in Systems',
    );

    const allBlockIds = result.blocks.map((block) => block.blockId);
    expect(allBlockIds).toEqual([
      'video',
      'body',
      'ex-01',
      'reading.1',
      'q.1',
      'application',
    ]);
  });

  it('reports an incomplete lesson without blocks instead of emitting an empty spec', () => {
    const { result } = buildPipeline({
      removeResources: [
        'asset-video-en',
        'asset-video-zh',
        'asset-sub-en',
        'asset-sub-zh',
        'asset-image-01',
        'asset-image-01-thumb',
      ],
      mutateWorkbook: (workbook) => {
        const media = workbook.sheets.Media;
        media.rows = media.rows.filter(
          (row) =>
            ![
              'asset-video-en',
              'asset-video-zh',
              'asset-sub-en',
              'asset-sub-zh',
              'asset-image-01',
              'asset-image-01-thumb',
            ].includes(String(row[0])),
        );
        const exhibits = workbook.sheets.Exhibits;
        exhibits.rows = [];
      },
      documents: buildDocuments().map((document) => ({
        ...document,
        html: undefined,
        triggerMarkers: [],
      })),
    });
    expect(
      result.issues.some(
        (issue) =>
          issue.code === 'CONTENT_INCOMPLETE' &&
          (issue.details as { reason?: string })?.reason === 'no-blocks',
      ),
    ).toBe(true);
    expect(
      result.contentSpecs.some((spec) => spec.contentKey === 'lesson-01'),
    ).toBe(false);
  });
});

describe('P4 Rendition 派生（C3 ALN-3：坐标单源、业务键唯一）', () => {
  it('derives timed video/text renditions, exhibit display and thumbnail renditions', () => {
    const { result } = buildPipeline();
    expect(result.renditions).toHaveLength(11);
    const businessKeys = result.renditions.map((rendition) =>
      [
        rendition.contentKey,
        rendition.blockId,
        rendition.language,
        rendition.modality,
        rendition.carrierType,
        rendition.carrierKey,
        rendition.carrierVersion,
        rendition.occurrenceKey,
      ].join('|'),
    );
    expect(new Set(businessKeys).size).toBe(11);

    const lpVideo = renditionByAnchor(
      result,
      (rendition) =>
        rendition.blockId === 'video' &&
        rendition.language === 'en-GB' &&
        rendition.occurrenceKey === `lp.${LP_CODE}`,
    );
    expect(lpVideo).toMatchObject({
      carrierType: 'asset',
      carrierKey: 'asset-video-en',
      carrierVersion: 1,
      startMs: 5000,
      endMs: 9500,
      modality: 'video',
      anchorSource: 'subtitle',
      revision: 1,
    });

    const lpText = renditionByAnchor(
      result,
      (rendition) =>
        rendition.blockId === 'body' &&
        rendition.language === 'en-GB' &&
        rendition.occurrenceKey === `lp.${LP_CODE}`,
    );
    expect(lpText).toMatchObject({
      carrierType: 'document',
      carrierKey: 'asset-doc-en',
      headingCode: '1.1',
      offset: 120,
      anchorSource: 'doc-structure',
    });
    expect(lpText?.startMs).toBeUndefined();

    const trigger = renditionByAnchor(
      result,
      (rendition) => rendition.occurrenceKey === 'trigger.1',
    );
    expect(trigger).toMatchObject({
      blockId: EXHIBIT_CODE,
      language: 'en-GB',
      modality: 'video',
      carrierKey: 'asset-video-en',
      startMs: 10000,
      endMs: 12000,
      anchorSource: 'subtitle',
    });

    const display = renditionByAnchor(
      result,
      (rendition) =>
        rendition.blockId === EXHIBIT_CODE &&
        rendition.occurrenceKey === 'main',
    );
    expect(display).toMatchObject({
      modality: 'image',
      carrierKey: 'asset-image-01',
      anchorSource: 'import-legacy',
    });

    const thumbnail = renditionByAnchor(
      result,
      (rendition) => rendition.occurrenceKey === 'thumbnail',
    );
    expect(thumbnail).toMatchObject({
      blockId: EXHIBIT_CODE,
      carrierKey: 'asset-image-01-thumb',
      modality: 'image',
      language: 'en-GB',
    });

    const body = renditionByAnchor(
      result,
      (rendition) =>
        rendition.blockId === 'body' && rendition.occurrenceKey === 'body',
    );
    expect(body).toMatchObject({
      carrierType: 'document',
      carrierKey: 'asset-doc-en',
      anchorSource: 'doc-structure',
    });
  });

  it('fails explicitly when an asset has no assigned assetVersion', () => {
    const { result } = buildPipeline(
      {},
      { assetVersions: { 'asset-video-en': 1 } },
    );
    const missing = result.issues.filter(
      (issue) =>
        issue.code === 'CONTENT_INCOMPLETE' &&
        (issue.details as { reason?: string })?.reason ===
          'missing-asset-version',
    );
    expect(missing.length).toBeGreaterThan(0);
  });
});

describe('P4 proposed Alignment：旧内容重绑（import/legacy、rebound/stale）', () => {
  it('rebinds an unchanged verified alignment as proposed with provenance=import', () => {
    const { result } = buildPipeline({
      content: priorContent({ carrierVersion: 1 }),
    });
    expect(result.alignments).toHaveLength(1);
    const proposal = result.alignments[0];
    expect(proposal.provenance).toBe('import');
    expect(proposal.rebind).toBe('rebound');
    expect(proposal.previousAlignmentId).toBe('aln-old-1');
    expect(proposal.alignment).toMatchObject({
      alignmentId: 'aln-old-1',
      stageKey: 'step-01',
      objectiveKey: 'obj-01',
      role: 'primary',
      status: 'proposed',
      provenance: 'import',
    });
    expect(proposal.alignment.verifiedBy).toBeUndefined();
    expect(proposal.alignment.verifiedAgainst).toBeUndefined();
    // revision 保持（锚点未变）
    const rebound = result.renditions.find(
      (rendition) => rendition.renditionKey === proposal.alignment.renditionKey,
    );
    expect(rebound?.revision).toBe(2);
    expect(result.issues).toEqual([]);
  });

  it('inherits provenance=legacy for legacy alignments', () => {
    const { result } = buildPipeline({
      content: priorContent({ carrierVersion: 1, provenance: 'legacy' }),
    });
    expect(result.alignments[0].provenance).toBe('legacy');
    expect(result.alignments[0].alignment.provenance).toBe('legacy');
  });

  it('marks carrier-version changes as stale and bumps the rendition revision', () => {
    const { result } = buildPipeline({
      content: priorContent({ carrierVersion: 5 }),
      // assetVersions 默认 1：与旧 pin 的 carrierVersion=5 不同 → stale
    });
    expect(result.alignments[0].rebind).toBe('stale');
    const derived = result.renditions.find(
      (rendition) =>
        rendition.renditionKey === result.alignments[0].alignment.renditionKey,
    );
    expect(derived?.revision).toBe(3);
  });

  it('marks coordinate changes as stale', () => {
    const { result } = buildPipeline({
      content: priorContent({ carrierVersion: 1, startMs: 4000, endMs: 9000 }),
    });
    expect(result.alignments[0].rebind).toBe('stale');
  });

  it('drops old alignments whose rendition is not re-derived and lists them as superseded', () => {
    const content = priorContent({ carrierVersion: 1 });
    const renditions = (
      content as { renditions: Array<Record<string, unknown>> }
    ).renditions;
    renditions[0].blockId = 'ghost-block';
    const { result } = buildPipeline({ content });
    expect(result.alignments).toEqual([]);
    expect(
      result.issues.some((issue) => issue.code === 'ALIGNMENT_UNBOUND'),
    ).toBe(true);
    expect(result.superseded.renditionKeys).toEqual(['old-r-lp-en']);
  });

  it('lists old spec pins that the payload no longer derives as superseded', () => {
    const content = priorContent({ carrierVersion: 1 });
    (content as { specPins: unknown[] }).specPins = [
      { contentKey: LESSON_CODE, version: 1 },
      { contentKey: 'legacy-spec', version: 3 },
    ];
    const { result } = buildPipeline({ content });
    expect(result.superseded.contentKeys).toEqual(['legacy-spec']);
  });
});

describe('P4 显式 binding seeds（不猜语义绑定）', () => {
  it('creates proposed alignments from explicit seeds with deterministic ids', () => {
    const { result } = buildPipeline(
      {},
      {
        bindingSeeds: [
          {
            stageKey: 'step-01',
            contentKey: LESSON_CODE,
            blockId: 'video',
            language: 'zh-CN',
            objectiveKey: 'obj-01',
            role: 'primary',
          },
        ],
      },
    );
    expect(result.alignments).toHaveLength(1);
    expect(result.alignments[0]).toMatchObject({
      provenance: 'import',
      rebind: 'new',
    });
    expect(result.alignments[0].alignment.alignmentId).toBe('aln.000001');
    expect(result.alignments[0].alignment.status).toBe('proposed');
  });

  it('rejects seeds that reference unknown stages or derive no rendition', () => {
    const { result } = buildPipeline(
      {},
      {
        bindingSeeds: [
          {
            stageKey: 'ghost-stage',
            contentKey: LESSON_CODE,
            objectiveKey: 'obj-01',
            role: 'primary',
          },
          {
            stageKey: 'step-01',
            contentKey: 'ghost-content',
            objectiveKey: 'obj-01',
            role: 'primary',
          },
        ],
      },
    );
    expect(
      result.issues.filter((issue) => issue.code === 'ALIGNMENT_SEED_UNBOUND'),
    ).toHaveLength(2);
  });

  it('rejects conflicting proposals for the same (stageKey, renditionKey)', () => {
    const content = priorContent({ carrierVersion: 1 });
    const stages = (content as { stages: Array<Record<string, unknown>> })
      .stages;
    stages[1].objectiveKeys = ['obj-01', 'obj-02'];
    const { result } = buildPipeline(
      { content },
      {
        bindingSeeds: [
          {
            stageKey: 'step-01',
            contentKey: LESSON_CODE,
            blockId: 'video',
            language: 'en-GB',
            objectiveKey: 'obj-02',
            role: 'primary',
          },
        ],
      },
    );
    const conflict = result.issues.find(
      (issue) => issue.code === 'ALIGNMENT_CONFLICT',
    );
    expect(conflict).toBeDefined();
    expect(conflict?.details?.stageKey).toBe('step-01');
  });
});

describe('P4 确定性与 golden（PLN-1 精神：同输入同字节，无哈希）', () => {
  function projection(result: AlignResult) {
    return {
      specs: result.contentSpecs.map((spec) => ({
        key: spec.contentKey,
        type: spec.type,
        blocks: spec.blocks.map((block) => block.blockId),
      })),
      renditions: result.renditions.map((rendition) => ({
        key: rendition.renditionKey,
        start: rendition.startMs ?? null,
        end: rendition.endMs ?? null,
        heading: rendition.headingCode ?? null,
        revision: rendition.revision,
        anchor: rendition.anchorSource,
        carrierVersion: rendition.carrierVersion,
      })),
      alignments: result.alignments.map((proposal) => ({
        id: proposal.alignment.alignmentId,
        stage: proposal.alignment.stageKey,
        rendition: proposal.alignment.renditionKey,
        objective: proposal.alignment.objectiveKey,
        role: proposal.alignment.role,
        status: proposal.alignment.status,
        provenance: proposal.alignment.provenance,
        rebind: proposal.rebind,
      })),
      superseded: result.superseded,
    };
  }

  it('produces byte-identical canonical output for the same input', () => {
    const first = buildPipeline().result;
    const second = buildPipeline().result;
    expect(projection(second)).toEqual(projection(first));
    expect(canonicalJson(projection(second))).toBe(
      canonicalJson(projection(first)),
    );
  });

  it('locks the golden projection for the canonical v2 fixture', () => {
    const { result } = buildPipeline();
    expect(canonicalJson(projection(result))).toBe(
      `{"alignments":[],"renditions":[{"anchor":"doc-structure","carrierVersion":1,"end":null,"heading":null,"key":"r.lesson-01.body.en-GB.text.document.asset-doc-en.body","revision":1,"start":null},{"anchor":"doc-structure","carrierVersion":1,"end":null,"heading":"1.1","key":"r.lesson-01.body.en-GB.text.document.asset-doc-en.lp.lp-01","revision":1,"start":null},{"anchor":"doc-structure","carrierVersion":1,"end":null,"heading":null,"key":"r.lesson-01.body.zh-CN.text.document.asset-doc-zh.body","revision":1,"start":null},{"anchor":"doc-structure","carrierVersion":1,"end":null,"heading":"1.1","key":"r.lesson-01.body.zh-CN.text.document.asset-doc-zh.lp.lp-01","revision":1,"start":null},{"anchor":"import-legacy","carrierVersion":1,"end":null,"heading":null,"key":"r.lesson-01.ex-01.en-GB.image.asset.asset-image-01-thumb.thumbnail","revision":1,"start":null},{"anchor":"import-legacy","carrierVersion":1,"end":null,"heading":null,"key":"r.lesson-01.ex-01.en-GB.image.asset.asset-image-01.main","revision":1,"start":null},{"anchor":"subtitle","carrierVersion":1,"end":12000,"heading":null,"key":"r.lesson-01.ex-01.en-GB.video.asset.asset-video-en.trigger.1","revision":1,"start":10000},{"anchor":"import-legacy","carrierVersion":1,"end":null,"heading":null,"key":"r.lesson-01.ex-01.zh-CN.image.asset.asset-image-01.main","revision":1,"start":null},{"anchor":"subtitle","carrierVersion":1,"end":12000,"heading":null,"key":"r.lesson-01.ex-01.zh-CN.video.asset.asset-video-zh.trigger.1","revision":1,"start":10000},{"anchor":"subtitle","carrierVersion":1,"end":9500,"heading":null,"key":"r.lesson-01.video.en-GB.video.asset.asset-video-en.lp.lp-01","revision":1,"start":5000},{"anchor":"subtitle","carrierVersion":1,"end":9500,"heading":null,"key":"r.lesson-01.video.zh-CN.video.asset.asset-video-zh.lp.lp-01","revision":1,"start":5000}],"specs":[{"blocks":["video","body","ex-01"],"key":"lesson-01","type":"video"},{"blocks":["application"],"key":"lesson-01.application-test","type":"application-test"},{"blocks":["q.1"],"key":"lesson-01.knowledge-test","type":"knowledge-test"},{"blocks":["reading.1"],"key":"lesson-01.reading","type":"reading"}],"superseded":{"contentKeys":[],"renditionKeys":[]}}`,
    );
  });

  it('carries no content-fingerprint identity keys anywhere in the output', () => {
    // 分片拼接：负向断言的 token 组合本身不能落成 P0 CI grep 会命中的字面量。
    const forbiddenIdentityPattern = new RegExp(
      [
        'check' + 'sum',
        'content' + 'ha' + 'sh',
        'content_' + 'ha' + 'sh',
        'sha' + '-?256',
        'sha' + '-?1\\b',
        'md' + '-?5',
        'di' + 'gest',
      ].join('|'),
      'i',
    );
    const { result } = buildPipeline({
      content: priorContent({ carrierVersion: 1 }),
    });
    const wire = canonicalJson(result);
    expect(wire).not.toMatch(forbiddenIdentityPattern);
    expect(wire).not.toMatch(/[0-9a-f]{40,}/i);
  });
});

// ---------------------------------------------------------------------------
// ASR 兜底 → Rendition + proposed Alignment（C5 P3/P4 / C7 / ALN-7）
// ---------------------------------------------------------------------------

const ASR_EN: TranscriptArtifactInput = {
  sourceKind: 'asr',
  assetKey: 'asset-video-en',
  language: 'en-GB',
  sourceArtifact: 'asr:asset-video-en:en-GB',
  modelVersion: 'asr-model-v1',
  params: { beamSize: 5 },
  ruleVersion: 'asr-rules-v1',
  cues: [
    {
      startMs: 5000,
      endMs: 9500,
      text: 'Why models matter',
      confidence: 0.9,
    },
    {
      startMs: 10000,
      endMs: 12000,
      text: 'Here is a model.',
      confidence: 0.9,
    },
  ],
};

const ASR_ZH: TranscriptArtifactInput = {
  sourceKind: 'asr',
  assetKey: 'asset-video-zh',
  language: 'zh-CN',
  sourceArtifact: 'asr:asset-video-zh:zh-CN',
  modelVersion: 'asr-model-v1',
  params: { beamSize: 5 },
  ruleVersion: 'asr-rules-v1',
  cues: [
    {
      startMs: 5000,
      endMs: 9500,
      text: '为什么模型重要',
      confidence: 0.9,
    },
    {
      startMs: 10000,
      endMs: 12000,
      text: '这是一个模型。',
      confidence: 0.9,
    },
  ],
};

function asrOnlyConfig(): InputConfig {
  return {
    removeResources: ['asset-sub-en', 'asset-sub-zh'],
    mutateWorkbook: (workbook) => {
      const media = workbook.sheets.Media;
      media.rows = media.rows.filter(
        (row) => row[0] !== 'asset-sub-en' && row[0] !== 'asset-sub-zh',
      );
    },
    transcripts: [ASR_EN, ASR_ZH],
  };
}

describe('P4 ASR-derived renditions and alignment provenance (C5 P3/P4/C7)', () => {
  it('derives ASR video renditions and carries the ASR pins onto proposals', () => {
    const { result, timing } = buildPipeline(asrOnlyConfig(), {
      bindingSeeds: [
        {
          stageKey: 'step-01',
          contentKey: LESSON_CODE,
          blockId: 'video',
          language: 'en-GB',
          objectiveKey: 'obj-01',
          role: 'primary',
        },
      ],
    });
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual(
      [],
    );
    expect(timing.provenance.map((pin) => pin.sourceKind)).toContain('asr');

    const lpVideo = renditionByAnchor(
      result,
      (rendition) =>
        rendition.blockId === 'video' &&
        rendition.language === 'en-GB' &&
        rendition.occurrenceKey === `lp.${LP_CODE}`,
    );
    expect(lpVideo).toMatchObject({
      carrierKey: 'asset-video-en',
      startMs: 5000,
      endMs: 9500,
      anchorSource: 'asr',
    });

    const trigger = renditionByAnchor(
      result,
      (rendition) =>
        rendition.occurrenceKey === 'trigger.1' &&
        rendition.language === 'en-GB',
    );
    expect(trigger).toMatchObject({
      blockId: EXHIBIT_CODE,
      modality: 'video',
      anchorSource: 'asr',
      startMs: 10000,
      endMs: 12000,
    });

    expect(result.alignments).toHaveLength(1);
    expect(result.alignments[0].timingProvenance).toEqual({
      sourceKind: 'asr',
      sourceArtifact: 'asr:asset-video-en:en-GB',
      modelVersion: 'asr-model-v1',
      params: { beamSize: 5 },
      ruleVersion: 'asr-rules-v1',
    });
  });

  it('stays deterministic for the same ASR artifact input', () => {
    const first = buildPipeline(asrOnlyConfig()).result;
    const second = buildPipeline(asrOnlyConfig()).result;
    const project = (result: AlignResult) => ({
      renditions: result.renditions.map((rendition) => ({
        key: rendition.renditionKey,
        anchor: rendition.anchorSource,
        start: rendition.startMs ?? null,
        end: rendition.endMs ?? null,
      })),
      superseded: result.superseded,
    });
    expect(canonicalJson(project(second))).toBe(canonicalJson(project(first)));
  });
});
