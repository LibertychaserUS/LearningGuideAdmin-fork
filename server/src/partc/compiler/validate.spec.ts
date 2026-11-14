import { validatePackage, hasBlockingErrors, hasIncomplete } from './validate';
import type { ValidationResult } from './validate';
import { parsePackage } from './parse';
import type { PackageIR } from './parse';
import { buildPackageFixture } from './parse.fixtures';

/**
 * P2 validate 单元测试（设计 §14 C5 P2 / C4）。
 * 断言口径：issue 的 code + severity + 源坐标；stage 不变量断言 invariant 编号。
 * 部分 STR 负例直接构造 IR（schema 层已拒绝的形状）以验证 validate 的防御性检查。
 */

function parsedIR(): PackageIR {
  const { pkg } = buildPackageFixture();
  return parsePackage(pkg);
}

function run(mutate?: (ir: PackageIR) => void): ValidationResult {
  const ir = parsedIR();
  if (mutate !== undefined) mutate(ir);
  return validatePackage(ir);
}

function findIssue(
  result: ValidationResult,
  code: string,
  severity?: string,
): ValidationResult['issues'][number] | undefined {
  return result.issues.find(
    (issue) =>
      issue.code === code &&
      (severity === undefined || issue.severity === severity),
  );
}

interface MutableSheetRow {
  rowNumber: number;
  values: Record<string, unknown>;
}

function sheetRows(ir: PackageIR, sheet: string): MutableSheetRow[] {
  return (ir.template.sheets as unknown as Record<string, MutableSheetRow[]>)[
    sheet
  ];
}

describe('P2 validate：合法包零 issue（C3/C4 全部不变量通过）', () => {
  it('produces no errors, no incompletes and no warnings on the happy fixture', () => {
    const result = run();
    expect(result.issues).toEqual([]);
    expect(hasBlockingErrors(result.issues)).toBe(false);
    expect(hasIncomplete(result.issues)).toBe(false);
    expect(result.rows.lessons).toHaveLength(2);
    expect(result.rows.media).toHaveLength(9);
    expect(result.rows.meta.studyMode).toBe('both');
  });
});

describe('P2 行级 schema/枚举（TEMPLATE_ROW_INVALID，带源坐标）', () => {
  it('reports invalid enum values with sheet/row/column', () => {
    const result = run((ir) => {
      sheetRows(ir, 'Learning Points')[0].values.language = 'english';
    });
    const issue = findIssue(result, 'TEMPLATE_ROW_INVALID', 'error');
    expect(issue).toBeDefined();
    expect(issue?.source).toMatchObject({
      sheet: 'Learning Points',
      row: 2,
      column: 'language',
    });
    expect(hasBlockingErrors(result.issues)).toBe(true);
  });

  it('rejects invalid order values and missing required cells', () => {
    const result = run((ir) => {
      sheetRows(ir, 'Lessons')[0].values.order = -3;
      sheetRows(ir, 'Application Test')[0].values.question = null;
    });
    expect(
      result.issues.filter((issue) => issue.code === 'TEMPLATE_ROW_INVALID'),
    ).toHaveLength(2);
  });
});

describe('P2 code 唯一（CODE_DUPLICATE）', () => {
  it('detects duplicate lesson / lp / exhibit / media / test codes', () => {
    const result = run((ir) => {
      const lessons = sheetRows(ir, 'Lessons');
      lessons.push({
        rowNumber: 99,
        values: { ...lessons[0].values },
      });
      const lps = sheetRows(ir, 'Learning Points');
      lps.push({ rowNumber: 90, values: { ...lps[0].values } });
      const exhibits = sheetRows(ir, 'Exhibits');
      exhibits.push({ rowNumber: 91, values: { ...exhibits[0].values } });
      const media = sheetRows(ir, 'Media');
      media.push({ rowNumber: 92, values: { ...media[0].values } });
      const kt = sheetRows(ir, 'Knowledge Test');
      kt.push({ rowNumber: 93, values: { ...kt[0].values } });
      const at = sheetRows(ir, 'Application Test');
      at.push({ rowNumber: 94, values: { ...at[0].values } });
    });
    const duplicates = result.issues.filter(
      (issue) => issue.code === 'CODE_DUPLICATE',
    );
    expect(duplicates.length).toBeGreaterThanOrEqual(6);
    expect(duplicates.every((issue) => issue.severity === 'error')).toBe(true);
    expect(duplicates[0].source?.sheet).toBeDefined();
  });

  it('rejects exhibit codes that collide with compiler-reserved blockIds', () => {
    const result = run((ir) => {
      const exhibits = sheetRows(ir, 'Exhibits');
      for (const row of exhibits) row.values.exhibit_code = 'body';
    });
    const issue = findIssue(result, 'CODE_RESERVED', 'error');
    expect(issue?.source).toMatchObject({
      sheet: 'Exhibits',
      column: 'exhibit_code',
    });
  });

  it('detects inconsistent media_type for one exhibit code across languages', () => {
    const result = run((ir) => {
      sheetRows(ir, 'Exhibits')[1].values.media_type = 'video';
    });
    expect(findIssue(result, 'REFERENCE_UNRESOLVED', 'error')).toBeDefined();
  });
});

describe('P2 引用双向覆盖（REFERENCE_UNRESOLVED / MEDIA_BINDING_MISSING）', () => {
  it('detects unknown lesson references across sheets', () => {
    const result = run((ir) => {
      sheetRows(ir, 'Learning Points')[0].values.lesson_code = 'ghost-lesson';
      sheetRows(ir, 'Reading List')[0].values.lesson_code = 'ghost-lesson';
      sheetRows(ir, 'Knowledge Test')[0].values.lesson_code = 'ghost-lesson';
      sheetRows(ir, 'Application Test')[0].values.lesson_code = 'ghost-lesson';
      sheetRows(ir, 'Media')[1].values.lesson_code = 'ghost-lesson';
    });
    const unresolved = result.issues.filter(
      (issue) =>
        issue.code === 'REFERENCE_UNRESOLVED' &&
        issue.severity === 'error' &&
        (issue.details as { lesson_code?: string } | undefined)?.lesson_code ===
          'ghost-lesson',
    );
    expect(unresolved.length).toBeGreaterThanOrEqual(5);
  });

  it('detects unknown assets in exhibits and thumbnail_of', () => {
    const result = run((ir) => {
      sheetRows(ir, 'Exhibits')[0].values.asset_key = 'ghost-asset';
      sheetRows(ir, 'Media')[8].values.thumbnail_of = 'ghost-asset';
    });
    const unresolved = result.issues.filter(
      (issue) => issue.code === 'REFERENCE_UNRESOLVED',
    );
    expect(unresolved.length).toBeGreaterThanOrEqual(2);
  });

  it('requires lesson/language binding for lesson-bound media kinds', () => {
    const result = run((ir) => {
      const video = sheetRows(ir, 'Media')[1];
      video.values.lesson_code = null;
      video.values.language = null;
    });
    const missing = result.issues.filter(
      (issue) => issue.code === 'MEDIA_BINDING_MISSING',
    );
    expect(missing.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects more than one carrier in the same (kind, lesson, language) slot', () => {
    const result = run((ir) => {
      sheetRows(ir, 'Media').push({
        rowNumber: 95,
        values: {
          asset_key: 'asset-video-en-2',
          kind: 'video',
          lesson_code: 'lesson-01',
          language: 'en-GB',
          relative_path: 'media/lesson-01.en.2.mp4',
          thumbnail_of: null,
        },
      });
    });
    expect(findIssue(result, 'MEDIA_AMBIGUOUS', 'error')).toBeDefined();
  });

  it('flags asset pins that the package does not deliver', () => {
    const result = run((ir) => {
      (ir.content as { assetPins: unknown[] }).assetPins = [
        { assetKey: 'ghost-asset', assetVersion: 1 },
      ];
    });
    expect(findIssue(result, 'REFERENCE_UNRESOLVED', 'error')).toBeDefined();
  });

  it('warns about spec pins that this package payload does not derive', () => {
    const result = run((ir) => {
      (ir.content as { specPins: unknown[] }).specPins = [
        { contentKey: 'legacy-spec', version: 4 },
      ];
    });
    const issue = findIssue(result, 'SPEC_PIN_UNKNOWN', 'warning');
    expect(issue).toBeDefined();
  });
});

describe('P2 语言完整性（B2.4/B2.6）', () => {
  it('requires en-GB + zh-CN lesson rows and course info fields (incomplete)', () => {
    const result = run((ir) => {
      const lessons = sheetRows(ir, 'Lessons');
      (ir.template.sheets as unknown as Record<string, unknown>).Lessons =
        lessons.filter((row) => row.values.language !== 'zh-CN');
      const courseInfo = sheetRows(ir, 'Course Info');
      (ir.template.sheets as unknown as Record<string, unknown>)[
        'Course Info'
      ] = courseInfo.filter(
        (row) =>
          !(row.values.field === 'overview' && row.values.language === 'zh-CN'),
      );
    });
    const missing = result.issues.filter(
      (issue) =>
        issue.code === 'LANGUAGE_MISSING' && issue.severity === 'incomplete',
    );
    expect(missing.length).toBeGreaterThanOrEqual(2);
    expect(hasIncomplete(result.issues)).toBe(true);
    expect(hasBlockingErrors(result.issues)).toBe(false);
    expect(missing.some((issue) => issue.source?.sheet === 'Course Info')).toBe(
      true,
    );
  });

  it('requires bilingual assessment pairs (incomplete)', () => {
    const result = run((ir) => {
      const kt = sheetRows(ir, 'Knowledge Test');
      (ir.template.sheets as unknown as Record<string, unknown>)[
        'Knowledge Test'
      ] = kt.filter((row) => row.values.language !== 'zh-CN');
    });
    expect(
      result.issues.some(
        (issue) =>
          issue.code === 'LANGUAGE_MISSING' &&
          issue.severity === 'incomplete' &&
          issue.source?.sheet === 'Knowledge Test',
      ),
    ).toBe(true);
  });

  it('rejects undeclared learning languages and non-metadata course info locales', () => {
    const result = run((ir) => {
      sheetRows(ir, 'Lessons')[1].values.language = 'fr-FR';
      sheetRows(ir, 'Course Info')[0].values.language = 'fr-FR';
    });
    const undeclared = result.issues.filter(
      (issue) => issue.code === 'LANGUAGE_UNDECLARED',
    );
    expect(undeclared.length).toBeGreaterThanOrEqual(2);
    expect(undeclared.every((issue) => issue.severity === 'error')).toBe(true);
  });

  it('requires the course titleLocalized to carry en-GB and zh-CN', () => {
    const result = run((ir) => {
      (
        ir.course as { titleLocalized: Record<string, unknown> }
      ).titleLocalized = {
        'en-GB': { title: 'Only English' },
      };
    });
    expect(
      result.issues.some(
        (issue) =>
          issue.code === 'LANGUAGE_MISSING' &&
          issue.source?.path === 'course.titleLocalized',
      ),
    ).toBe(true);
  });

  it('rejects Meta/course learningLanguages and studyMode drift', () => {
    const result = run((ir) => {
      (ir.template as { meta: Record<string, unknown> }).meta = {
        ...ir.template.meta,
        learningLanguages: ['en-GB'],
        studyMode: 'video',
      };
    });
    const drift = result.issues.filter(
      (issue) => issue.code === 'COURSE_META_MISMATCH',
    );
    expect(drift).toHaveLength(2);
    expect(drift[0].source?.sheet).toBe('Meta');
  });
});

describe('P2 STR-1 包含森林（C4）', () => {
  it('rejects unknown parents and invalid kind nesting', () => {
    const result = run((ir) => {
      const stages = (ir.content as { stages: Array<Record<string, unknown>> })
        .stages;
      stages[1].parentStageKey = 'ghost-parent';
    });
    const issue = result.issues.find(
      (candidate) => candidate.invariant === 'STR-1',
    );
    expect(issue?.code).toBe('STAGE_INVALID');
    expect(issue?.source?.path).toBe('content.stages[1].parentStageKey');
  });

  it('rejects a child whose kind is not strictly deeper than its parent', () => {
    const result = run((ir) => {
      const stages = (ir.content as { stages: Array<Record<string, unknown>> })
        .stages;
      stages.push({
        courseKey: 'modeling-life',
        stageKey: 'step-02',
        parentStageKey: 'step-01',
        orderKey: '000001.000001.000001',
        kind: 'stage',
        goal: 'nested stage',
        objectiveKeys: ['obj-01'],
        exitEvidence: ['ev-01'],
        exitRollup: { kind: 'all' },
        status: 'active',
      });
    });
    expect(
      result.issues.some(
        (issue) =>
          issue.invariant === 'STR-1' && issue.details?.stageKey === 'step-02',
      ),
    ).toBe(true);
  });

  it('rejects leaves without objectives/evidence and containers with exitEvidence', () => {
    const result = run((ir) => {
      const stages = (ir.content as { stages: Array<Record<string, unknown>> })
        .stages;
      stages[1].objectiveKeys = [];
      stages[0].exitEvidence = ['ev-01'];
    });
    const issues = result.issues.filter((issue) => issue.invariant === 'STR-1');
    expect(issues.length).toBeGreaterThanOrEqual(2);
    expect(
      issues.some((issue) => issue.source?.path?.endsWith('exitEvidence')),
    ).toBe(true);
  });

  it('detects containment cycles', () => {
    const result = run((ir) => {
      const stages = (ir.content as { stages: Array<Record<string, unknown>> })
        .stages;
      stages[0].parentStageKey = 'step-01';
    });
    expect(
      result.issues.some(
        (issue) =>
          issue.invariant === 'STR-1' &&
          Array.isArray(issue.details?.stageKeys) &&
          (issue.details?.stageKeys as string[]).includes('prog-01'),
      ),
    ).toBe(true);
  });
});

describe('P2 STR-2/STR-7 交付序与先修（C4）', () => {
  function twoLeafContent(ir: PackageIR): Array<Record<string, unknown>> {
    const stages = (ir.content as { stages: Array<Record<string, unknown>> })
      .stages;
    stages.push({
      courseKey: 'modeling-life',
      stageKey: 'step-02',
      parentStageKey: 'prog-01',
      orderKey: '000001.000002',
      kind: 'step',
      goal: 'second step',
      objectiveKeys: ['obj-01'],
      exitEvidence: ['ev-01'],
      exitRollup: { kind: 'all' },
      status: 'active',
    });
    return stages;
  }

  it('rejects a requires edge that reverses the sibling sequence (STR-7 cycle)', () => {
    const result = run((ir) => {
      twoLeafContent(ir);
      (ir.content as { prerequisiteEdges: unknown[] }).prerequisiteEdges = [
        { fromStageKey: 'step-02', toStageKey: 'step-01', kind: 'requires' },
      ];
    });
    const issue = result.issues.find(
      (candidate) =>
        candidate.invariant === 'STR-7' &&
        candidate.code === 'PREREQUISITE_INVALID',
    );
    expect(issue).toBeDefined();
    expect(issue?.details?.stageKeys).toEqual(['step-01', 'step-02']);
  });

  it('rejects a requires edge from a container to its own child (projected self-loop)', () => {
    const result = run((ir) => {
      (ir.content as { prerequisiteEdges: unknown[] }).prerequisiteEdges = [
        { fromStageKey: 'prog-01', toStageKey: 'step-01', kind: 'requires' },
      ];
    });
    expect(
      result.issues.some(
        (issue) =>
          issue.invariant === 'STR-7' && issue.details?.selfLoop === true,
      ),
    ).toBe(true);
  });

  it('warns on recommends and rejects unknown endpoints', () => {
    const result = run((ir) => {
      (ir.content as { prerequisiteEdges: unknown[] }).prerequisiteEdges = [
        { fromStageKey: 'step-01', toStageKey: 'step-02', kind: 'recommends' },
        { fromStageKey: 'ghost-a', toStageKey: 'step-01', kind: 'requires' },
      ];
    });
    expect(
      result.issues.some(
        (issue) =>
          issue.code === 'PREREQUISITE_WARNING' && issue.severity === 'warning',
      ),
    ).toBe(true);
    expect(
      result.issues.filter((issue) => issue.code === 'PREREQUISITE_INVALID')
        .length,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('P2 STR-4/STR-5 证据（C4）', () => {
  it('rejects an unsatisfiable atLeast rollup (STR-4)', () => {
    const result = run((ir) => {
      const stage = (ir.content as { stages: Array<Record<string, unknown>> })
        .stages[1];
      stage.exitRollup = { kind: 'atLeast', n: 2 };
    });
    const issue = findIssue(result, 'EVIDENCE_UNSUPPORTED', 'error');
    expect(issue?.invariant).toBe('STR-4');
  });

  it('reports missing evidence specs and uncovered objectives as incomplete (STR-5)', () => {
    const result = run((ir) => {
      (ir.content as { evidenceSpecs: unknown[] }).evidenceSpecs = [];
    });
    const issues = result.issues.filter((issue) => issue.invariant === 'STR-5');
    expect(issues.length).toBeGreaterThanOrEqual(2);
    expect(issues.every((issue) => issue.severity === 'incomplete')).toBe(true);
  });

  it('requires a verified assessment alignment for assessment evidence (STR-5)', () => {
    const result = run((ir) => {
      const content = ir.content as {
        stages: Array<Record<string, unknown>>;
        evidenceSpecs: unknown[];
        renditions: unknown[];
        alignments: unknown[];
        specPins: unknown[];
      };
      content.specPins = [
        { contentKey: 'lesson-01.knowledge-test', version: 1 },
      ];
      content.evidenceSpecs = [
        {
          evidenceKey: 'ev-01',
          version: 1,
          kind: 'assessment',
          objectiveKeys: ['obj-01'],
          measure: {
            kind: 'assessment',
            contentKey: 'lesson-01.knowledge-test',
            blockIds: ['q.1'],
          },
          scoring: 'points',
          threshold: 60,
          attempts: 1,
        },
      ];
      // 无 alignment → incomplete
    });
    expect(
      result.issues.some(
        (issue) =>
          issue.invariant === 'STR-5' &&
          issue.severity === 'incomplete' &&
          String(issue.message).includes('verified assessment alignment'),
      ),
    ).toBe(true);
  });

  it('accepts assessment evidence bound by a verified assessment alignment', () => {
    const result = run((ir) => {
      const content = ir.content as {
        stages: Array<Record<string, unknown>>;
        evidenceSpecs: unknown[];
        renditions: unknown[];
        alignments: unknown[];
        specPins: unknown[];
      };
      content.specPins = [
        { contentKey: 'lesson-01.knowledge-test', version: 1 },
      ];
      content.evidenceSpecs = [
        {
          evidenceKey: 'ev-01',
          version: 1,
          kind: 'assessment',
          objectiveKeys: ['obj-01'],
          measure: {
            kind: 'assessment',
            contentKey: 'lesson-01.knowledge-test',
            blockIds: ['q.1'],
          },
          scoring: 'points',
          threshold: 60,
          attempts: 1,
        },
      ];
      content.renditions = [
        {
          renditionKey: 'r-question',
          contentKey: 'lesson-01.knowledge-test',
          blockId: 'q.1',
          language: 'en-GB',
          modality: 'text',
          occurrenceKey: 'main',
          carrierType: 'document',
          carrierKey: 'asset-doc-en',
          carrierVersion: 1,
          headingCode: 'q1',
          anchorSource: 'doc-structure',
          revision: 1,
        },
      ];
      content.alignments = [
        {
          alignmentId: 'aln-assessment',
          stageKey: 'step-01',
          renditionKey: 'r-question',
          objectiveKey: 'obj-01',
          role: 'assessment',
          status: 'verified',
          provenance: 'human',
          verifiedBy: 'employee-1',
          verifiedAt: '2026-11-12T08:00:00Z',
          verifiedAgainst: {
            renditionRevision: 1,
            carrierVersion: 1,
            specVersion: 1,
          },
        },
      ];
    });
    expect(
      result.issues.filter((issue) => issue.invariant === 'STR-5'),
    ).toEqual([]);
  });
});
