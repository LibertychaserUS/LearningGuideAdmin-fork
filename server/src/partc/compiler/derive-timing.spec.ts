import { canonicalJson } from '../contracts';
import {
  deriveTiming,
  extractMp4Chapters,
  formatTimecode,
  parseChaptersJson,
  parseSrt,
  parseSubtitleCues,
  parseVtt,
  probeMp4DurationMs,
  SubtitleSyntaxError,
  TIMING_RULE_PARAMETERS,
  TIMING_RULE_VERSION,
} from './derive-timing';
import type {
  DocumentStructureInput,
  ForcedAlignmentDeclaration,
  TimingResult,
  TranscriptArtifactInput,
} from './derive-timing';
import { parsePackage } from './parse';
import type { PackageIR, RawPackage, RawWorkbook } from './parse';
import { validatePackage } from './validate';
import type { ValidatedRows } from './validate';
import {
  DURATION_MS,
  EN_CUES,
  ZH_CUES,
  baseProvenance,
  buildDocuments,
  buildMinimalMp4,
  buildMp4WithChapterTrack,
  buildMp4WithChpl,
  buildPackageFixture,
  buildSrt,
  buildVtt,
  buildWorkbook,
  clone,
  removeResource,
  replaceResourceBytes,
} from './parse.fixtures';

/**
 * P3 deriveTiming 单元测试（设计 §14 C5 P3 / C7）。
 * 覆盖：容器探测、SRT/VTT、MP4 chapter track/chpl、chapters JSON、点锚点展开、
 * 越界/无源/歧义 error、审计报告字段、确定性。
 */

const encoder = new TextEncoder();

type MutableWorkbook = {
  sheets: Record<string, { headers: unknown[]; rows: unknown[][] }>;
};

interface InputConfig {
  readonly mutateWorkbook?: (workbook: MutableWorkbook) => void;
  readonly removeResources?: readonly string[];
  readonly replaceResources?: ReadonlyArray<readonly [string, Uint8Array]>;
  readonly documents?: readonly DocumentStructureInput[];
  readonly transcripts?: readonly TranscriptArtifactInput[];
  readonly forcedAlignmentDeclarations?: readonly ForcedAlignmentDeclaration[];
  readonly provenance?: unknown;
}

interface DerivationFixture {
  readonly ir: PackageIR;
  readonly rows: ValidatedRows;
  readonly documents: readonly DocumentStructureInput[];
  readonly transcripts?: readonly TranscriptArtifactInput[];
  readonly forcedAlignmentDeclarations?: readonly ForcedAlignmentDeclaration[];
}

function buildInput(config: InputConfig = {}): DerivationFixture {
  const workbook = clone(buildWorkbook()) as unknown as MutableWorkbook;
  config.mutateWorkbook?.(workbook);
  let pkg: RawPackage = buildPackageFixture({
    workbook: workbook as unknown as RawWorkbook,
    ...(config.provenance === undefined
      ? {}
      : { provenance: config.provenance }),
  }).pkg;
  for (const resourceId of config.removeResources ?? []) {
    pkg = removeResource(pkg, resourceId);
  }
  for (const [resourceId, bytes] of config.replaceResources ?? []) {
    pkg = replaceResourceBytes(pkg, resourceId, bytes);
  }
  const ir = parsePackage(pkg);
  const validation = validatePackage(ir);
  return {
    ir,
    rows: validation.rows,
    documents: config.documents ?? buildDocuments(),
    ...(config.transcripts === undefined
      ? {}
      : { transcripts: config.transcripts }),
    ...(config.forcedAlignmentDeclarations === undefined
      ? {}
      : {
          forcedAlignmentDeclarations: config.forcedAlignmentDeclarations,
        }),
  };
}

function removeMediaRow(workbook: MutableWorkbook, assetKey: string): void {
  const media = workbook.sheets.Media;
  media.rows = media.rows.filter((row) => row[0] !== assetKey);
}

function documentsWithoutMarkers(
  documents: readonly DocumentStructureInput[],
): DocumentStructureInput[] {
  return documents.map((document) => ({ ...document, triggerMarkers: [] }));
}

function issueReasons(result: TimingResult): string[] {
  return result.issues.map((issue) =>
    String((issue.details as { reason?: string })?.reason ?? issue.code),
  );
}

describe('P3 容器探测与时间格式化（C7）', () => {
  it('formats mm:ss.mmm with total minutes', () => {
    expect(formatTimecode(0)).toBe('00:00.000');
    expect(formatTimecode(9500)).toBe('00:09.500');
    expect(formatTimecode(600000)).toBe('10:00.000');
    expect(formatTimecode(3600000 + 1001)).toBe('60:01.001');
  });

  it('probes MP4 mvhd duration as integer milliseconds', () => {
    expect(probeMp4DurationMs(buildMinimalMp4(DURATION_MS))).toBe(DURATION_MS);
    expect(probeMp4DurationMs(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(probeMp4DurationMs(new Uint8Array(0))).toBeNull();
  });

  it('extracts ffmpeg-style chapter tracks and Nero chpl chapters', () => {
    const chapters = [
      { startMs: 0, title: 'Intro' },
      { startMs: 5000, title: 'Why models matter' },
      { startMs: 20000, title: 'State variables' },
    ];
    const fromTrack = extractMp4Chapters(
      buildMp4WithChapterTrack(DURATION_MS, chapters),
    );
    expect(fromTrack.map((cue) => [cue.startMs, cue.title])).toEqual([
      [0, 'Intro'],
      [5000, 'Why models matter'],
      [20000, 'State variables'],
    ]);
    expect(fromTrack[0].endMs).toBe(5000);

    const fromChpl = extractMp4Chapters(
      buildMp4WithChpl(DURATION_MS, chapters),
    );
    expect(fromChpl.map((cue) => [cue.startMs, cue.title])).toEqual([
      [0, 'Intro'],
      [5000, 'Why models matter'],
      [20000, 'State variables'],
    ]);
  });
});

describe('P3 字幕 SRT/VTT 与 chapters JSON 解析（C7）', () => {
  it('parses SRT cues (comma or dot millis, BOM tolerated)', () => {
    const cues = parseSrt(buildSrt(EN_CUES));
    expect(cues).toHaveLength(3);
    expect(cues[1]).toEqual({
      index: 2,
      startMs: 5000,
      endMs: 9500,
      text: 'Why models matter',
    });
    const dotMillis = buildSrt(EN_CUES).replace(/,(\d{3})/g, '.$1');
    expect(
      parseSrt(`${String.fromCharCode(0xfeff)}${dotMillis}`)[0].startMs,
    ).toBe(1000);
  });

  it('parses VTT and auto-detects the format', () => {
    const vtt = buildVtt(EN_CUES);
    expect(parseSubtitleCues(vtt)).toHaveLength(3);
    expect(parseSubtitleCues(vtt)[2].text).toBe('Here is a model.');
    expect(parseSubtitleCues(buildSrt(EN_CUES))[0].text).toBe(
      'Welcome to modeling life.',
    );
    expect(() => parseVtt(buildSrt(EN_CUES))).toThrow(SubtitleSyntaxError);
  });

  it('fails closed on malformed cue timing with a line number', () => {
    expect(() => parseSrt('1\nnot a timing line\nText')).toThrow(
      SubtitleSyntaxError,
    );
    try {
      parseSrt('1\nnot a timing line\nText');
    } catch (error) {
      expect((error as SubtitleSyntaxError).line).toBe(1);
    }
    expect(() => parseSrt('1\n00:00:05,000 --> 00:00:01,000\nText')).toThrow(
      SubtitleSyntaxError,
    );
  });

  it('parses chapters JSON as integer milliseconds and rejects ambiguity', () => {
    const cues = parseChaptersJson({
      chapters: [
        { startMs: 5000, title: 'B' },
        { startMs: 0, title: 'A' },
      ],
    });
    expect(cues.map((cue) => [cue.startMs, cue.title, cue.endMs])).toEqual([
      [0, 'A', 5000],
      [5000, 'B', undefined],
    ]);
    expect(() => parseChaptersJson([{ startMs: -1, title: 'x' }])).toThrow(
      SubtitleSyntaxError,
    );
    expect(() => parseChaptersJson([{ startMs: 1.5, title: 'x' }])).toThrow(
      SubtitleSyntaxError,
    );
    expect(() =>
      parseChaptersJson([
        { startMs: 1, title: 'a' },
        { startMs: 1, title: 'b' },
      ]),
    ).toThrow(SubtitleSyntaxError);
    expect(() => parseChaptersJson({ nope: true })).toThrow(
      SubtitleSyntaxError,
    );
  });
});

describe('P3 派生 LP/触发坐标与审计报告（C5 P3/C7）', () => {
  it('derives subtitle-coordinate LP anchors and exhibit triggers for both languages', () => {
    const input = buildInput();
    const result = deriveTiming(input);

    expect(result.issues).toEqual([]);
    expect(result.ruleVersion).toBe(TIMING_RULE_VERSION);
    expect(result.parameters).toEqual(TIMING_RULE_PARAMETERS);
    expect(result.coordinates).toHaveLength(6);

    const lpEn = result.coordinates.find(
      (coordinate) =>
        coordinate.kind === 'lp' &&
        coordinate.language === 'en-GB' &&
        coordinate.carrierType === 'asset',
    );
    expect(lpEn).toMatchObject({
      lessonCode: 'lesson-01',
      code: 'lp-01',
      occurrenceKey: 'lp.lp-01',
      carrierKey: 'asset-video-en',
      startMs: 5000,
      endMs: 9500,
      anchorSource: 'subtitle',
      source: 'subtitle',
    });

    const lpEnText = result.coordinates.find(
      (coordinate) =>
        coordinate.kind === 'lp' &&
        coordinate.language === 'en-GB' &&
        coordinate.carrierType === 'document',
    );
    expect(lpEnText).toMatchObject({
      carrierKey: 'asset-doc-en',
      headingCode: '1.1',
      offset: 120,
      anchorSource: 'doc-structure',
      source: 'doc-structure',
    });
    expect(lpEnText?.startMs).toBeUndefined();

    const triggerZh = result.coordinates.find(
      (coordinate) =>
        coordinate.kind === 'trigger' && coordinate.language === 'zh-CN',
    );
    expect(triggerZh).toMatchObject({
      code: 'ex-01',
      occurrenceKey: 'trigger.1',
      carrierKey: 'asset-video-zh',
      startMs: 10000,
      endMs: 12000,
      anchorSource: 'subtitle',
    });

    expect(result.audit).toHaveLength(6);
    const auditEn = result.audit.find(
      (entry) =>
        entry.kind === 'lp' &&
        entry.language === 'en-GB' &&
        entry.carrierType === 'asset',
    );
    expect(auditEn).toMatchObject({
      startMs: 5000,
      startFormatted: '00:05.000',
      endMs: 9500,
      endFormatted: '00:09.500',
      nearbyText: 'Why models matter',
    });
    expect(result.assets).toEqual([
      {
        assetKey: 'asset-video-en',
        durationMs: DURATION_MS,
        chapterSource: null,
      },
      {
        assetKey: 'asset-video-zh',
        durationMs: DURATION_MS,
        chapterSource: null,
      },
    ]);

    // 确定性：同输入同输出
    expect(deriveTiming(input)).toEqual(result);
  });

  it('blocks publish with TIMING_SOURCE_MISSING when a video has no subtitle/chapters/ASR (F1)', () => {
    const input = buildInput({
      removeResources: ['asset-sub-en', 'asset-sub-zh'],
      mutateWorkbook: (workbook) => {
        removeMediaRow(workbook, 'asset-sub-en');
        removeMediaRow(workbook, 'asset-sub-zh');
      },
    });
    const result = deriveTiming(input);
    // ALN-7 / C7 §4.4：无源 ⇒ TIMING_SOURCE_MISSING，阶段 blocked（incomplete，
    // 可入库草稿但不可发布）；只有越界/非法源工件才是 error 整包拒绝。
    const errors = result.issues.filter(
      (issue) =>
        issue.code === 'TIMING_SOURCE_MISSING' &&
        issue.severity === 'incomplete',
    );
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(issueReasons(result)).toContain('no-timing-source');
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual(
      [],
    );
    // 文本锚点仍从 DOCX Heading 派生（不猜视频时间）
    expect(
      result.coordinates.filter(
        (coordinate) => coordinate.carrierType === 'document',
      ),
    ).toHaveLength(2);
  });

  it('reports invalid subtitle syntax against the Media source coordinate', () => {
    const input = buildInput({
      replaceResources: [
        ['asset-sub-en', encoder.encode('this is not a subtitle file')],
      ],
    });
    const result = deriveTiming(input);
    const issue = result.issues.find(
      (candidate) =>
        candidate.code === 'TIMING_SOURCE_MISSING' &&
        (candidate.details as { reason?: string })?.reason ===
          'invalid-subtitle',
    );
    expect(issue).toBeDefined();
    expect(issue?.source).toMatchObject({
      sheet: 'Media',
      column: 'relative_path',
    });
  });

  it('reports ambiguous LP title matches instead of guessing', () => {
    const duplicated = [
      { startMs: 1000, endMs: 2000, text: 'Why models matter' },
      { startMs: 5000, endMs: 9500, text: 'Why models matter' },
      { startMs: 10000, endMs: 12000, text: 'Here is a model.' },
    ];
    const input = buildInput({
      replaceResources: [
        ['asset-sub-en', encoder.encode(buildSrt(duplicated))],
      ],
    });
    const result = deriveTiming(input);
    expect(
      result.issues.some((issue) => issue.code === 'TIMING_AMBIGUOUS'),
    ).toBe(true);
  });

  it('rejects out-of-range cue intervals with TIMING_RANGE_INVALID', () => {
    const outOfRange = EN_CUES.map((cue, index) =>
      index === 1 ? { ...cue, endMs: DURATION_MS + 1000 } : cue,
    );
    const input = buildInput({
      replaceResources: [
        ['asset-sub-en', encoder.encode(buildSrt(outOfRange))],
      ],
    });
    const result = deriveTiming(input);
    const issue = result.issues.find(
      (candidate) => candidate.code === 'TIMING_RANGE_INVALID',
    );
    expect(issue).toBeDefined();
    expect(issue?.details).toMatchObject({
      startMs: 5000,
      endMs: DURATION_MS + 1000,
      durationMs: DURATION_MS,
    });
  });
});

describe('P3 MP4 chapter track 与点锚点展开（C7）', () => {
  it('uses chapter-track anchors when no subtitle is delivered', () => {
    const input = buildInput({
      removeResources: ['asset-sub-en', 'asset-sub-zh'],
      mutateWorkbook: (workbook) => {
        removeMediaRow(workbook, 'asset-sub-en');
        removeMediaRow(workbook, 'asset-sub-zh');
      },
      replaceResources: [
        [
          'asset-video-en',
          buildMp4WithChapterTrack(DURATION_MS, [
            { startMs: 0, title: 'Intro' },
            { startMs: 5000, title: 'Why models matter' },
          ]),
        ],
        [
          'asset-video-zh',
          buildMp4WithChapterTrack(DURATION_MS, [
            { startMs: 0, title: '介绍' },
            { startMs: 5000, title: '为什么模型重要' },
          ]),
        ],
      ],
      documents: documentsWithoutMarkers(buildDocuments()),
    });
    const result = deriveTiming(input);
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual(
      [],
    );
    const lpEn = result.coordinates.find(
      (coordinate) =>
        coordinate.kind === 'lp' &&
        coordinate.language === 'en-GB' &&
        coordinate.carrierType === 'asset',
    );
    expect(lpEn).toMatchObject({
      startMs: 5000,
      endMs: DURATION_MS,
      anchorSource: 'chapter',
      source: 'chapter',
      nearbyText: 'Why models matter',
    });
    // 大窗口提醒进入报告（只告警，不改变 C7 的展开规则）
    expect(
      result.issues.some((issue) => issue.code === 'TIMING_WINDOW_LARGE'),
    ).toBe(true);
    expect(result.assets[0].chapterSource).toBe('track');
  });

  it('expands consecutive point anchors with end = next start - 1ms', () => {
    const input = buildInput({
      mutateWorkbook: (workbook) => {
        const lps = workbook.sheets['Learning Points'];
        lps.rows = [
          ...lps.rows,
          ['lesson-01', 'lp-02', 'en-GB', 'State variables'],
          ['lesson-01', 'lp-02', 'zh-CN', '状态变量'],
        ];
        removeMediaRow(workbook, 'asset-sub-en');
        removeMediaRow(workbook, 'asset-sub-zh');
      },
      removeResources: ['asset-sub-en', 'asset-sub-zh'],
      replaceResources: [
        [
          'asset-video-en',
          buildMp4WithChapterTrack(DURATION_MS, [
            { startMs: 0, title: 'Intro' },
            { startMs: 5000, title: 'Why models matter' },
            { startMs: 20000, title: 'State variables' },
          ]),
        ],
        [
          'asset-video-zh',
          buildMp4WithChapterTrack(DURATION_MS, [
            { startMs: 0, title: '介绍' },
            { startMs: 5000, title: '为什么模型重要' },
            { startMs: 20000, title: '状态变量' },
          ]),
        ],
      ],
      documents: documentsWithoutMarkers([
        {
          ...buildDocuments()[0],
          headings: [
            { headingCode: '1.1', title: 'Why models matter', offset: 120 },
            { headingCode: '1.2', title: 'State variables', offset: 400 },
          ],
        },
        {
          ...buildDocuments()[1],
          headings: [
            { headingCode: '1.1', title: '为什么模型重要', offset: 100 },
            { headingCode: '1.2', title: '状态变量', offset: 380 },
          ],
        },
      ]),
    });
    const result = deriveTiming(input);
    const en = result.coordinates
      .filter(
        (coordinate) =>
          coordinate.kind === 'lp' &&
          coordinate.language === 'en-GB' &&
          coordinate.carrierType === 'asset',
      )
      .sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
    expect(
      en.map((coordinate) => [
        coordinate.code,
        coordinate.startMs,
        coordinate.endMs,
      ]),
    ).toEqual([
      ['lp-01', 5000, 19999],
      ['lp-02', 20000, DURATION_MS],
    ]);
  });

  it('rejects a below-minimum expanded window (rule parameter)', () => {
    const input = buildInput({
      mutateWorkbook: (workbook) => {
        const lps = workbook.sheets['Learning Points'];
        lps.rows = [
          ...lps.rows,
          ['lesson-01', 'lp-02', 'en-GB', 'State variables'],
          ['lesson-01', 'lp-02', 'zh-CN', '状态变量'],
        ];
        removeMediaRow(workbook, 'asset-sub-en');
        removeMediaRow(workbook, 'asset-sub-zh');
      },
      removeResources: ['asset-sub-en', 'asset-sub-zh'],
      replaceResources: [
        [
          'asset-video-en',
          buildMp4WithChapterTrack(DURATION_MS, [
            { startMs: 5000, title: 'Why models matter' },
            { startMs: 5200, title: 'State variables' },
          ]),
        ],
        [
          'asset-video-zh',
          buildMp4WithChapterTrack(DURATION_MS, [
            { startMs: 5000, title: '为什么模型重要' },
            { startMs: 5200, title: '状态变量' },
          ]),
        ],
      ],
      documents: documentsWithoutMarkers([
        {
          ...buildDocuments()[0],
          headings: [
            { headingCode: '1.1', title: 'Why models matter', offset: 120 },
            { headingCode: '1.2', title: 'State variables', offset: 200 },
          ],
        },
        {
          ...buildDocuments()[1],
          headings: [
            { headingCode: '1.1', title: '为什么模型重要', offset: 100 },
            { headingCode: '1.2', title: '状态变量', offset: 180 },
          ],
        },
      ]),
    });
    const result = deriveTiming(input);
    const issue = result.issues.find(
      (candidate) =>
        candidate.code === 'TIMING_RANGE_INVALID' &&
        (candidate.details as { windowMs?: number })?.windowMs === 199,
    );
    expect(issue).toBeDefined();
    expect(TIMING_RULE_PARAMETERS.minWindowMs).toBe(500);
  });

  it('derives document-only coordinates for text lessons without video', () => {
    const input = buildInput({
      removeResources: [
        'asset-video-en',
        'asset-video-zh',
        'asset-sub-en',
        'asset-sub-zh',
      ],
      mutateWorkbook: (workbook) => {
        removeMediaRow(workbook, 'asset-video-en');
        removeMediaRow(workbook, 'asset-video-zh');
        removeMediaRow(workbook, 'asset-sub-en');
        removeMediaRow(workbook, 'asset-sub-zh');
      },
      documents: documentsWithoutMarkers(buildDocuments()),
    });
    const result = deriveTiming(input);
    expect(result.issues).toEqual([]);
    expect(result.coordinates).toHaveLength(2);
    expect(
      result.coordinates.every(
        (coordinate) =>
          coordinate.carrierType === 'document' &&
          coordinate.anchorSource === 'doc-structure',
      ),
    ).toBe(true);
  });

  it('reports unknown exhibit markers and duplicate trigger truth keys', () => {
    const input = buildInput({
      documents: buildDocuments().map((document) => ({
        ...document,
        triggerMarkers:
          document.language === 'en-GB'
            ? [
                { exhibitCode: 'ghost-exhibit', lineText: 'Here is a model.' },
                { exhibitCode: 'ex-01', lineText: 'Here is a model.' },
                { exhibitCode: 'ex-01', lineText: 'Here is a model.' },
              ]
            : document.triggerMarkers,
      })),
    });
    const result = deriveTiming(input);
    expect(
      result.issues.some((issue) => issue.code === 'TRIGGER_EXHIBIT_UNKNOWN'),
    ).toBe(true);
    expect(
      result.issues.some(
        (issue) =>
          issue.code === 'TIMING_AMBIGUOUS' &&
          (issue.details as { startMs?: number })?.startMs === 10000,
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ASR 默认兜底 / 强制对齐 / 时间源 provenance（C5 P3 / C7 ③④ / ALN-7 / C10.6）
// ---------------------------------------------------------------------------

const ASR_PINS = {
  modelVersion: 'asr-model-v1',
  params: { beamSize: 5, languageModel: 'general', vad: true },
  ruleVersion: 'asr-rules-v1',
} as const;

const FORCED_ALIGNMENT_PINS = {
  modelVersion: 'forced-aligner-v1',
  params: { mode: 'script', phoneSet: 'ipa' },
  ruleVersion: 'forced-alignment-rules-v1',
} as const;

function transcriptCues(language: 'en-GB' | 'zh-CN') {
  const source = language === 'en-GB' ? EN_CUES : ZH_CUES;
  return source.map((cue) => ({
    startMs: cue.startMs,
    endMs: cue.endMs,
    text: cue.text,
    confidence: 0.92,
  }));
}

function asrTranscript(
  language: 'en-GB' | 'zh-CN',
  overrides: Partial<TranscriptArtifactInput> = {},
): TranscriptArtifactInput {
  const assetKey = language === 'en-GB' ? 'asset-video-en' : 'asset-video-zh';
  return {
    sourceKind: 'asr',
    assetKey,
    language,
    sourceArtifact: `asr:${assetKey}:${language}`,
    ...ASR_PINS,
    params: ASR_PINS.params,
    cues: transcriptCues(language),
    ...overrides,
  };
}

function forcedAlignmentArtifact(
  language: 'en-GB' | 'zh-CN',
): TranscriptArtifactInput {
  const assetKey = language === 'en-GB' ? 'asset-video-en' : 'asset-video-zh';
  return {
    sourceKind: 'forced-alignment',
    assetKey,
    language,
    documentAssetKey: language === 'en-GB' ? 'asset-doc-en' : 'asset-doc-zh',
    sourceArtifact: `forced-alignment:${assetKey}:${language}`,
    ...FORCED_ALIGNMENT_PINS,
    params: FORCED_ALIGNMENT_PINS.params,
    cues: transcriptCues(language),
  };
}

function withoutSubtitles() {
  return {
    removeResources: ['asset-sub-en', 'asset-sub-zh'],
    mutateWorkbook: (workbook: MutableWorkbook): void => {
      removeMediaRow(workbook, 'asset-sub-en');
      removeMediaRow(workbook, 'asset-sub-zh');
    },
  };
}

function findCoordinate(
  result: TimingResult,
  predicate: (coordinate: TimingResult['coordinates'][number]) => boolean,
) {
  return result.coordinates.find(predicate);
}

describe('P3 ASR 默认兜底（C5 P3 / C7 ③ / ALN-7）', () => {
  it('derives per-language ASR anchors/triggers when no subtitle or chapter exists', () => {
    const input = buildInput({
      ...withoutSubtitles(),
      transcripts: [asrTranscript('en-GB'), asrTranscript('zh-CN')],
    });
    const result = deriveTiming(input);

    expect(result.issues).toEqual([]);
    const lpEn = findCoordinate(
      result,
      (coordinate) =>
        coordinate.kind === 'lp' &&
        coordinate.language === 'en-GB' &&
        coordinate.carrierType === 'asset',
    );
    expect(lpEn).toMatchObject({
      code: 'lp-01',
      startMs: 5000,
      endMs: 9500,
      anchorSource: 'asr',
      confidence: 0.92,
      provenance: {
        sourceKind: 'asr',
        sourceArtifact: 'asr:asset-video-en:en-GB',
        modelVersion: 'asr-model-v1',
        ruleVersion: 'asr-rules-v1',
      },
    });
    const triggerZh = findCoordinate(
      result,
      (coordinate) =>
        coordinate.kind === 'trigger' && coordinate.language === 'zh-CN',
    );
    expect(triggerZh).toMatchObject({
      code: 'ex-01',
      startMs: 10000,
      endMs: 12000,
      anchorSource: 'asr',
      provenance: { sourceArtifact: 'asr:asset-video-zh:zh-CN' },
    });

    // 审计报告含 sourceKind/sourceArtifact/modelVersion/params/ruleVersion
    const audit = result.audit.find(
      (entry) =>
        entry.kind === 'lp' &&
        entry.language === 'en-GB' &&
        entry.anchorSource === 'asr',
    );
    expect(audit).toMatchObject({
      sourceKind: 'asr',
      sourceArtifact: 'asr:asset-video-en:en-GB',
      modelVersion: 'asr-model-v1',
      params: ASR_PINS.params,
      ruleVersion: 'asr-rules-v1',
      startFormatted: '00:05.000',
      endFormatted: '00:09.500',
      confidence: 0.92,
    });

    // 派生源 pin 汇总（导出/快照 provenance 携带）
    expect(result.provenance).toContainEqual({
      sourceKind: 'asr',
      sourceArtifact: 'asr:asset-video-en:en-GB',
      modelVersion: 'asr-model-v1',
      params: ASR_PINS.params,
      ruleVersion: 'asr-rules-v1',
    });

    // 同输入重复派生逐条一致（确定性）
    expect(deriveTiming(input)).toEqual(result);
  });

  it('keeps subtitle cues ahead of ASR (priority ① > ③)', () => {
    const result = deriveTiming(
      buildInput({
        transcripts: [asrTranscript('en-GB'), asrTranscript('zh-CN')],
      }),
    );
    const lpEn = findCoordinate(
      result,
      (coordinate) =>
        coordinate.kind === 'lp' &&
        coordinate.language === 'en-GB' &&
        coordinate.carrierType === 'asset',
    );
    expect(lpEn?.anchorSource).toBe('subtitle');
    expect(lpEn?.provenance.sourceKind).toBe('subtitle');
    expect(result.provenance.every((pin) => pin.sourceKind !== 'asr')).toBe(
      true,
    );
  });

  it('keeps chapter-track anchors ahead of ASR (priority ② > ③)', () => {
    const result = deriveTiming(
      buildInput({
        ...withoutSubtitles(),
        replaceResources: [
          [
            'asset-video-en',
            buildMp4WithChapterTrack(DURATION_MS, [
              { startMs: 0, title: 'Intro' },
              { startMs: 5000, title: 'Why models matter' },
            ]),
          ],
          [
            'asset-video-zh',
            buildMp4WithChapterTrack(DURATION_MS, [
              { startMs: 0, title: '介绍' },
              { startMs: 5000, title: '为什么模型重要' },
            ]),
          ],
        ],
        documents: documentsWithoutMarkers(buildDocuments()),
        transcripts: [asrTranscript('en-GB'), asrTranscript('zh-CN')],
      }),
    );
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual(
      [],
    );
    const lpEn = findCoordinate(
      result,
      (coordinate) =>
        coordinate.kind === 'lp' &&
        coordinate.language === 'en-GB' &&
        coordinate.carrierType === 'asset',
    );
    expect(lpEn).toMatchObject({
      anchorSource: 'chapter',
      provenance: {
        sourceKind: 'chapter',
        sourceArtifact: 'asset:asset-video-en#chapter-track',
        ruleVersion: TIMING_RULE_VERSION,
      },
    });
  });

  it('derives ASR per language: a missing transcript blocks only that language', () => {
    const result = deriveTiming(
      buildInput({
        ...withoutSubtitles(),
        documents: documentsWithoutMarkers(buildDocuments()),
        transcripts: [asrTranscript('en-GB')],
      }),
    );
    const en = result.coordinates.find(
      (coordinate) =>
        coordinate.language === 'en-GB' && coordinate.carrierType === 'asset',
    );
    expect(en?.anchorSource).toBe('asr');
    expect(
      result.coordinates.filter(
        (coordinate) =>
          coordinate.language === 'zh-CN' && coordinate.carrierType === 'asset',
      ),
    ).toEqual([]);
    expect(
      result.issues.some(
        (issue) =>
          issue.code === 'TIMING_SOURCE_MISSING' &&
          issue.severity === 'incomplete' &&
          issue.details?.language === 'zh-CN' &&
          issue.details?.reason === 'no-timing-source',
      ),
    ).toBe(true);
  });

  it('low-confidence ASR → ALIGNMENT_LOW_CONFIDENCE (incomplete) with source coordinates', () => {
    const lowConfidence = asrTranscript('en-GB', {
      cues: transcriptCues('en-GB').map((cue) => ({
        ...cue,
        confidence: 0.4,
      })),
    });
    const result = deriveTiming(
      buildInput({
        ...withoutSubtitles(),
        mutateWorkbook: (workbook) => {
          removeMediaRow(workbook, 'asset-sub-en');
          removeMediaRow(workbook, 'asset-sub-zh');
        },
        transcripts: [lowConfidence, asrTranscript('zh-CN')],
      }),
    );
    const low = result.issues.find(
      (issue) => issue.code === 'ALIGNMENT_LOW_CONFIDENCE',
    );
    expect(low?.severity).toBe('incomplete');
    expect(low?.details).toMatchObject({
      sourceKind: 'asr',
      sourceArtifact: 'asr:asset-video-en:en-GB',
      modelVersion: 'asr-model-v1',
      confidence: 0.4,
      threshold: TIMING_RULE_PARAMETERS.minTranscriptConfidence,
    });
    expect(low?.source).toBeDefined();
    // 坐标仍产出供 Sandbox 播放复核；置信度进审计
    const lpEn = findCoordinate(
      result,
      (coordinate) =>
        coordinate.kind === 'lp' &&
        coordinate.language === 'en-GB' &&
        coordinate.carrierType === 'asset',
    );
    expect(lpEn?.confidence).toBe(0.4);
    expect(
      result.issues.some(
        (issue) =>
          issue.code === 'ALIGNMENT_LOW_CONFIDENCE' &&
          issue.details?.language === 'zh-CN',
      ),
    ).toBe(false);
  });
});

describe('P3 强制对齐（C7 ④：仅显式声明「文本稿=口播稿」）', () => {
  it('uses forced alignment only when the lesson explicitly declares the spoken script', () => {
    const declarations: ForcedAlignmentDeclaration[] = [
      {
        lessonCode: 'lesson-01',
        language: 'en-GB',
        documentAssetKey: 'asset-doc-en',
      },
      {
        lessonCode: 'lesson-01',
        language: 'zh-CN',
        documentAssetKey: 'asset-doc-zh',
      },
    ];
    const result = deriveTiming(
      buildInput({
        ...withoutSubtitles(),
        transcripts: [
          forcedAlignmentArtifact('en-GB'),
          forcedAlignmentArtifact('zh-CN'),
        ],
        forcedAlignmentDeclarations: declarations,
      }),
    );
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual(
      [],
    );
    const lpEn = findCoordinate(
      result,
      (coordinate) =>
        coordinate.kind === 'lp' &&
        coordinate.language === 'en-GB' &&
        coordinate.carrierType === 'asset',
    );
    expect(lpEn).toMatchObject({
      anchorSource: 'forced-alignment',
      startMs: 5000,
      endMs: 9500,
      provenance: {
        sourceKind: 'forced-alignment',
        sourceArtifact: 'forced-alignment:asset-video-en:en-GB',
        modelVersion: 'forced-aligner-v1',
        ruleVersion: 'forced-alignment-rules-v1',
      },
    });
    expect(result.provenance.map((pin) => pin.sourceKind)).toContain(
      'forced-alignment',
    );
  });

  it('rejects forced-alignment artifacts without an explicit declaration', () => {
    const result = deriveTiming(
      buildInput({
        ...withoutSubtitles(),
        transcripts: [
          forcedAlignmentArtifact('en-GB'),
          forcedAlignmentArtifact('zh-CN'),
        ],
      }),
    );
    const rejected = result.issues.filter(
      (issue) =>
        issue.code === 'TRANSCRIPT_INVALID' &&
        issue.details?.reason === 'forced-alignment-not-declared',
    );
    expect(rejected.length).toBe(2);
    expect(rejected.every((issue) => issue.severity === 'error')).toBe(true);
    expect(
      result.coordinates.filter(
        (coordinate) => coordinate.anchorSource === 'forced-alignment',
      ),
    ).toEqual([]);
  });
});

describe('P3 转写工件校验与 provenance 一致性（C10.6/T4）', () => {
  it('rejects transcripts for unknown assets and wrong languages', () => {
    const unknownAsset = asrTranscript('en-GB', { assetKey: 'ghost-asset' });
    const wrongLanguage = asrTranscript('en-GB', {
      assetKey: 'asset-video-en',
      language: 'zh-CN',
    });
    const result = deriveTiming(
      buildInput({
        transcripts: [unknownAsset, wrongLanguage],
      }),
    );
    expect(issueReasons(result)).toContain('unknown-asset');
    expect(issueReasons(result)).toContain('language-mismatch');
  });

  it('rejects duplicate ASR artifacts for the same video/language', () => {
    const result = deriveTiming(
      buildInput({
        transcripts: [asrTranscript('en-GB'), asrTranscript('en-GB')],
      }),
    );
    expect(issueReasons(result)).toContain('duplicate-asr');
    expect(
      result.issues.find((issue) => issue.code === 'TIMING_AMBIGUOUS')
        ?.severity,
    ).toBe('error');
  });

  it('rejects invalid cue ranges and confidences with source paths', () => {
    const outOfRange = asrTranscript('en-GB', {
      cues: [
        {
          startMs: 5000,
          endMs: DURATION_MS + 1000,
          text: 'Why models matter',
          confidence: 0.9,
        },
      ],
    });
    const badConfidence = asrTranscript('zh-CN', {
      cues: [{ startMs: 0, endMs: 1000, text: 'x', confidence: 1.5 }],
    });
    const result = deriveTiming(
      buildInput({
        ...withoutSubtitles(),
        transcripts: [outOfRange, badConfidence],
      }),
    );
    const rangeIssue = result.issues.find(
      (issue) => issue.code === 'TIMING_RANGE_INVALID',
    );
    expect(rangeIssue?.source?.path).toBe('transcripts[0]');
    expect(rangeIssue?.details).toMatchObject({
      sourceKind: 'asr',
      endMs: DURATION_MS + 1000,
    });
    const confidenceIssue = result.issues.find(
      (issue) =>
        issue.code === 'TRANSCRIPT_INVALID' &&
        issue.details?.reason === 'invalid-confidence',
    );
    expect(confidenceIssue?.source?.path).toBe('transcripts[1].cues[0]');
  });

  it('marks an empty transcript as an incomplete missing source', () => {
    const empty = asrTranscript('en-GB', { cues: [] });
    const result = deriveTiming(
      buildInput({ ...withoutSubtitles(), transcripts: [empty] }),
    );
    expect(
      result.issues.some(
        (issue) =>
          issue.code === 'TIMING_SOURCE_MISSING' &&
          issue.severity === 'incomplete' &&
          issue.details?.reason === 'transcript-empty',
      ),
    ).toBe(true);
  });

  it('detects manifest.provenance.asr pins that disagree with the used artifact', () => {
    const provenance = {
      ...baseProvenance(),
      asr: {
        modelVersion: 'asr-model-v0',
        params: { beamSize: 5 },
        ruleVersion: 'asr-rules-v1',
      },
    };
    const result = deriveTiming(
      buildInput({
        ...withoutSubtitles(),
        provenance,
        transcripts: [asrTranscript('en-GB'), asrTranscript('zh-CN')],
      }),
    );
    const mismatch = result.issues.find(
      (issue) => issue.code === 'PROVENANCE_MISMATCH',
    );
    expect(mismatch?.severity).toBe('error');
    expect(mismatch?.source?.path).toBe('provenance.asr');
    expect(mismatch?.details).toMatchObject({
      declared: { modelVersion: 'asr-model-v0' },
    });
  });

  it('accepts manifest.provenance.asr pins that agree with the used artifact', () => {
    const provenance = {
      ...baseProvenance(),
      asr: {
        modelVersion: ASR_PINS.modelVersion,
        params: ASR_PINS.params,
        ruleVersion: ASR_PINS.ruleVersion,
      },
    };
    const result = deriveTiming(
      buildInput({
        ...withoutSubtitles(),
        provenance,
        transcripts: [asrTranscript('en-GB'), asrTranscript('zh-CN')],
      }),
    );
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual(
      [],
    );
  });
});

describe('P3 golden（ASR 输出确定性，同输入同字节）', () => {
  it('locks the golden ASR projection', () => {
    const result = deriveTiming(
      buildInput({
        ...withoutSubtitles(),
        transcripts: [asrTranscript('en-GB'), asrTranscript('zh-CN')],
      }),
    );
    const projection = {
      coordinates: result.coordinates.map((coordinate) => ({
        l: coordinate.lessonCode,
        lang: coordinate.language,
        k: coordinate.kind,
        code: coordinate.code,
        occ: coordinate.occurrenceKey,
        carrierType: coordinate.carrierType,
        carrier: coordinate.carrierKey,
        start: coordinate.startMs ?? null,
        end: coordinate.endMs ?? null,
        anchor: coordinate.anchorSource,
        source: coordinate.provenance.sourceKind,
        artifact: coordinate.provenance.sourceArtifact,
        model: coordinate.provenance.modelVersion ?? null,
        rule: coordinate.provenance.ruleVersion,
        conf: coordinate.confidence ?? null,
      })),
      audit: result.audit.map((entry) => ({
        l: entry.lessonCode,
        lang: entry.language,
        k: entry.kind,
        code: entry.code,
        start: entry.startFormatted ?? null,
        end: entry.endFormatted ?? null,
        source: entry.sourceKind,
        artifact: entry.sourceArtifact,
        model: entry.modelVersion ?? null,
        rule: entry.ruleVersion,
      })),
      provenance: result.provenance,
      issues: result.issues,
    };
    expect(canonicalJson(projection)).toBe(
      `{"audit":[{"artifact":"asr:asset-video-en:en-GB","code":"lp-01","end":"00:09.500","k":"lp","l":"lesson-01","lang":"en-GB","model":"asr-model-v1","rule":"asr-rules-v1","source":"asr","start":"00:05.000"},{"artifact":"asset-doc-en","code":"lp-01","end":null,"k":"lp","l":"lesson-01","lang":"en-GB","model":null,"rule":"timing-rules-v1","source":"doc-structure","start":null},{"artifact":"asr:asset-video-en:en-GB","code":"ex-01","end":"00:12.000","k":"trigger","l":"lesson-01","lang":"en-GB","model":"asr-model-v1","rule":"asr-rules-v1","source":"asr","start":"00:10.000"},{"artifact":"asr:asset-video-zh:zh-CN","code":"lp-01","end":"00:09.500","k":"lp","l":"lesson-01","lang":"zh-CN","model":"asr-model-v1","rule":"asr-rules-v1","source":"asr","start":"00:05.000"},{"artifact":"asset-doc-zh","code":"lp-01","end":null,"k":"lp","l":"lesson-01","lang":"zh-CN","model":null,"rule":"timing-rules-v1","source":"doc-structure","start":null},{"artifact":"asr:asset-video-zh:zh-CN","code":"ex-01","end":"00:12.000","k":"trigger","l":"lesson-01","lang":"zh-CN","model":"asr-model-v1","rule":"asr-rules-v1","source":"asr","start":"00:10.000"}],"coordinates":[{"anchor":"asr","artifact":"asr:asset-video-en:en-GB","carrier":"asset-video-en","carrierType":"asset","code":"lp-01","conf":0.92,"end":9500,"k":"lp","l":"lesson-01","lang":"en-GB","model":"asr-model-v1","occ":"lp.lp-01","rule":"asr-rules-v1","source":"asr","start":5000},{"anchor":"doc-structure","artifact":"asset-doc-en","carrier":"asset-doc-en","carrierType":"document","code":"lp-01","conf":null,"end":null,"k":"lp","l":"lesson-01","lang":"en-GB","model":null,"occ":"lp.lp-01","rule":"timing-rules-v1","source":"doc-structure","start":null},{"anchor":"asr","artifact":"asr:asset-video-en:en-GB","carrier":"asset-video-en","carrierType":"asset","code":"ex-01","conf":0.92,"end":12000,"k":"trigger","l":"lesson-01","lang":"en-GB","model":"asr-model-v1","occ":"trigger.1","rule":"asr-rules-v1","source":"asr","start":10000},{"anchor":"asr","artifact":"asr:asset-video-zh:zh-CN","carrier":"asset-video-zh","carrierType":"asset","code":"lp-01","conf":0.92,"end":9500,"k":"lp","l":"lesson-01","lang":"zh-CN","model":"asr-model-v1","occ":"lp.lp-01","rule":"asr-rules-v1","source":"asr","start":5000},{"anchor":"doc-structure","artifact":"asset-doc-zh","carrier":"asset-doc-zh","carrierType":"document","code":"lp-01","conf":null,"end":null,"k":"lp","l":"lesson-01","lang":"zh-CN","model":null,"occ":"lp.lp-01","rule":"timing-rules-v1","source":"doc-structure","start":null},{"anchor":"asr","artifact":"asr:asset-video-zh:zh-CN","carrier":"asset-video-zh","carrierType":"asset","code":"ex-01","conf":0.92,"end":12000,"k":"trigger","l":"lesson-01","lang":"zh-CN","model":"asr-model-v1","occ":"trigger.1","rule":"asr-rules-v1","source":"asr","start":10000}],"issues":[],"provenance":[{"modelVersion":"asr-model-v1","params":{"beamSize":5,"languageModel":"general","vad":true},"ruleVersion":"asr-rules-v1","sourceArtifact":"asr:asset-video-en:en-GB","sourceKind":"asr"},{"modelVersion":"asr-model-v1","params":{"beamSize":5,"languageModel":"general","vad":true},"ruleVersion":"asr-rules-v1","sourceArtifact":"asr:asset-video-zh:zh-CN","sourceKind":"asr"},{"ruleVersion":"timing-rules-v1","sourceArtifact":"asset-doc-en","sourceKind":"doc-structure"},{"ruleVersion":"timing-rules-v1","sourceArtifact":"asset-doc-zh","sourceKind":"doc-structure"}]}`,
    );
  });
});
