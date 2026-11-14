import { evaluatePlanInvariants } from './invariants';
import type { PlanInvariantInput, PlanInvariantReport } from './invariants';
import { FIXTURE_COURSE_KEY, buildPlanFixtureArrays } from './plan.fixtures';
import type { LooseRecord } from './plan.fixtures';

/**
 * P5 不变量与 σ 选择单元测试（设计 §14 C4 STR/ALN/TIM、C5 P5）。
 *
 * 断言口径：gate 通过与否、issue 的 code/severity/invariant、stage 级 gap 的
 * reason/status。内容缺陷一律 blocked（显式 gap），绝不静默跳过。
 */

type Fixture = ReturnType<typeof buildPlanFixtureArrays>;

function evaluate(mutate?: (fixture: Fixture) => void): {
  fixture: Fixture;
  report: PlanInvariantReport;
} {
  const fixture = buildPlanFixtureArrays();
  mutate?.(fixture);
  const input = {
    source: {
      courseKey: FIXTURE_COURSE_KEY,
      stages: fixture.stages,
      prerequisiteEdges: fixture.prerequisiteEdges,
      renditions: fixture.renditions,
      alignments: fixture.alignments,
      evidenceSpecs: fixture.evidenceSpecs,
      specPins: fixture.specPins,
      assetPins: fixture.assetPins,
    },
    target: fixture.target,
    mediaAssets: fixture.mediaAssets,
    timingSources: fixture.timingSources,
  } as unknown as PlanInvariantInput;
  return { fixture, report: evaluatePlanInvariants(input) };
}

function selectionOf(report: PlanInvariantReport, stageKey: string) {
  const selection = report.selections.find(
    (entry) => entry.stage.stageKey === stageKey,
  );
  expect(selection).toBeDefined();
  return selection as PlanInvariantReport['selections'][number];
}

function issuesOf(report: PlanInvariantReport, code: string) {
  return [...report.g1.issues, ...report.g2.issues].filter(
    (issue) => issue.code === code,
  );
}

describe('P5 不变量：happy fixture 全绿（G1/G2）', () => {
  it('passes gates and selects target-filtered renditions in canonical order', () => {
    const { report } = evaluate();
    expect(report.g1.passed).toBe(true);
    expect(report.g2.passed).toBe(true);
    expect(report.g1.issues).toEqual([]);
    expect(report.g2.issues).toEqual([]);
    expect(report.gaps).toEqual([]);
    expect(report.linearization.ok).toBe(true);
    expect(report.selections.map((entry) => entry.stage.stageKey)).toEqual([
      'step-1',
      'step-2',
      'step-3',
    ]);

    const step1 = selectionOf(report, 'step-1');
    expect(step1.gaps).toEqual([]);
    expect(step1.selected.map((entry) => entry.alignment.alignmentId)).toEqual([
      'a4',
      'a2',
      'a5',
    ]);
    // 语言显式回退链 [zh-CN, en-GB]：同槽位取 zh-CN，绝不静默留 en-GB。
    expect(step1.selected[0].placement).toEqual({
      type: 'document',
      documentKey: 'doc-lesson-zh',
      documentVersion: 1,
      headingCode: 'H1',
      offset: 0,
    });
    expect(step1.selected[1].placement).toEqual({
      type: 'media',
      assetKey: 'asset-video-zh',
      assetVersion: 1,
      startMs: 0,
      endMs: 61000,
    });
    expect(step1.selected[2].placement).toEqual({
      type: 'assessment',
      contentKey: 'lesson-1.knowledge-test',
      blockIds: ['q.1'],
    });

    const step2 = selectionOf(report, 'step-2');
    expect(step2.selected.map((entry) => entry.alignment.alignmentId)).toEqual([
      'a6',
      'a9',
    ]);
    expect(step2.selected[0].rendition.language).toBe('en-GB');
  });
});

describe('P5 不变量：ALN-1/2/4/6 纤维与 verified 约束', () => {
  it('ALN-1: a delivery leaf without any target-admitted verified alignment is blocked', () => {
    const { report } = evaluate((fixture) => {
      fixture.alignments = (fixture.alignments as LooseRecord[]).filter(
        (alignment) => alignment.stageKey !== 'step-2',
      );
    });
    expect(report.g2.passed).toBe(false);
    const step2 = selectionOf(report, 'step-2');
    expect(step2.selected).toEqual([]);
    expect(step2.gaps).toEqual([
      expect.objectContaining({ reason: 'ALN-1', status: 'blocked' }),
    ]);
    expect(
      issuesOf(report, 'ALIGNMENT_UNBOUND').some(
        (issue) => issue.invariant === 'ALN-1',
      ),
    ).toBe(true);
  });

  it('ALN-1: a target language chain with no matching rendition is blocked, not silently substituted', () => {
    const { report } = evaluate((fixture) => {
      (fixture.target as LooseRecord).languages = ['fr-FR'];
    });
    expect(report.g2.passed).toBe(false);
    for (const stageKey of ['step-1', 'step-2', 'step-3']) {
      expect(selectionOf(report, stageKey).gaps).toEqual([
        expect.objectContaining({ reason: 'ALN-1', status: 'blocked' }),
      ]);
    }
  });

  it('ALN-2: proposed-only coverage is blocked (only verified may enter a plan)', () => {
    const { report } = evaluate((fixture) => {
      for (const alignment of fixture.alignments as LooseRecord[]) {
        if (alignment.stageKey !== 'step-2') continue;
        alignment.status = 'proposed';
        delete alignment.verifiedBy;
        delete alignment.verifiedAt;
        delete alignment.verifiedAgainst;
      }
    });
    const step2 = selectionOf(report, 'step-2');
    expect(step2.gaps).toEqual([
      expect.objectContaining({ reason: 'ALN-2', status: 'blocked' }),
    ]);
    expect(
      issuesOf(report, 'ALIGNMENT_UNBOUND').some(
        (issue) => issue.invariant === 'ALN-2',
      ),
    ).toBe(true);
  });

  it('ALN-6: stale audit tuples block the stage and surface a stale warning', () => {
    const { report } = evaluate((fixture) => {
      for (const alignment of fixture.alignments as LooseRecord[]) {
        if (alignment.stageKey !== 'step-2') continue;
        (alignment.verifiedAgainst as Record<string, number>).carrierVersion =
          9;
      }
    });
    expect(report.g2.passed).toBe(false);
    const step2 = selectionOf(report, 'step-2');
    expect(step2.gaps).toEqual([
      expect.objectContaining({ reason: 'ALN-6', status: 'blocked' }),
    ]);
    expect(
      issuesOf(report, 'ALIGNMENT_CONFLICT').some(
        (issue) => issue.invariant === 'ALN-6' && issue.severity === 'warning',
      ),
    ).toBe(true);
  });

  it('ALN-4: an objective without a target-admitted verified primary is blocked', () => {
    const { report } = evaluate((fixture) => {
      const primary = (fixture.alignments as LooseRecord[]).find(
        (alignment) => alignment.alignmentId === 'a6',
      ) as LooseRecord;
      primary.role = 'support';
    });
    const step2 = selectionOf(report, 'step-2');
    expect(step2.gaps).toEqual([
      expect.objectContaining({
        reason: 'ALN-4',
        status: 'blocked',
        details: { objectiveKeys: ['obj-1'] },
      }),
    ]);
    expect(
      issuesOf(report, 'ALIGNMENT_UNBOUND').some(
        (issue) => issue.invariant === 'ALN-4',
      ),
    ).toBe(true);
  });
});

describe('P5 不变量：ALN-7 / TIM-1 机器时间源', () => {
  it('ALN-7: a video rendition with a non-machine anchorSource is TIMING_SOURCE_MISSING', () => {
    const { report } = evaluate((fixture) => {
      const rendition = (fixture.renditions as LooseRecord[]).find(
        (entry) => entry.renditionKey === 'r-video-zh',
      ) as LooseRecord;
      rendition.anchorSource = 'import-legacy';
    });
    const issue = issuesOf(report, 'TIMING_SOURCE_MISSING').find(
      (entry) => entry.invariant === 'ALN-7',
    );
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('incomplete');
    expect(issue?.details).toMatchObject({ renditionKey: 'r-video-zh' });
    expect(report.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          invariant: 'ALN-7',
          status: 'blocked',
          renditionKey: 'r-video-zh',
        }),
      ]),
    );
    const step1 = selectionOf(report, 'step-1');
    expect(
      step1.selected.find(
        (entry) => entry.rendition.renditionKey === 'r-video-zh',
      )?.placement,
    ).toEqual({ type: 'gap', reason: 'TIM-1' });
    expect(step1.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'TIM-1', status: 'blocked' }),
      ]),
    );
  });

  it('ALN-7: ASR confidence below the rule threshold is ALIGNMENT_LOW_CONFIDENCE', () => {
    const { report } = evaluate((fixture) => {
      const rendition = (fixture.renditions as LooseRecord[]).find(
        (entry) => entry.renditionKey === 'r-video-zh',
      ) as LooseRecord;
      rendition.anchorSource = 'asr';
      const pin = (fixture.timingSources as LooseRecord[]).find(
        (entry) => entry.renditionKey === 'r-video-zh',
      ) as LooseRecord;
      Object.assign(pin, {
        sourceKind: 'asr',
        sourceArtifact: 'asr:asset-video-zh:zh-CN',
        confidence: 0.4,
        modelVersion: 'asr-x1',
        params: { language: 'zh-CN' },
        ruleVersion: 'asr-rules-v1',
      });
    });
    const issue = issuesOf(report, 'ALIGNMENT_LOW_CONFIDENCE')[0];
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('incomplete');
    expect(issue?.invariant).toBe('ALN-7');
    expect(issue?.details).toMatchObject({
      renditionKey: 'r-video-zh',
      confidence: 0.4,
    });
  });

  it('ALN-7: ASR renditions without provenance pins have no machine source', () => {
    const { report } = evaluate((fixture) => {
      const rendition = (fixture.renditions as LooseRecord[]).find(
        (entry) => entry.renditionKey === 'r-video-zh',
      ) as LooseRecord;
      rendition.anchorSource = 'asr';
      fixture.timingSources = (fixture.timingSources as LooseRecord[]).filter(
        (entry) => entry.renditionKey !== 'r-video-zh',
      );
    });
    expect(
      issuesOf(report, 'TIMING_SOURCE_MISSING').some(
        (issue) => issue.details?.renditionKey === 'r-video-zh',
      ),
    ).toBe(true);
  });

  it('TIM-1: an asset without a probed duration cannot pass range validation', () => {
    const { report } = evaluate((fixture) => {
      fixture.mediaAssets = (fixture.mediaAssets as LooseRecord[]).filter(
        (entry) => entry.assetKey !== 'asset-video-en',
      );
    });
    const issue = issuesOf(report, 'TIMING_SOURCE_MISSING').find(
      (entry) => entry.details?.renditionKey === 'r-video-en',
    );
    expect(issue).toBeDefined();
    expect(issue?.message).toContain('duration');
  });

  it('TIM-1: endMs beyond the probed duration is a range error (no clamp)', () => {
    const { report } = evaluate((fixture) => {
      const asset = (fixture.mediaAssets as LooseRecord[]).find(
        (entry) => entry.assetKey === 'asset-video-zh',
      ) as LooseRecord;
      asset.durationMs = 60000;
    });
    const issue = issuesOf(report, 'TIMING_RANGE_INVALID')[0];
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('incomplete');
    expect(issue?.invariant).toBe('TIM-1');
    expect(issue?.details).toMatchObject({
      renditionKey: 'r-video-zh',
      endMs: 61000,
      durationMs: 60000,
    });
  });

  it('ALN-7: every video rendition needs a verified alignment, even outside the target', () => {
    const { report } = evaluate((fixture) => {
      fixture.renditions = [
        ...(fixture.renditions as LooseRecord[]),
        {
          renditionKey: 'r-video-extra',
          contentKey: 'lesson-1',
          blockId: 'video-extra',
          language: 'en-GB',
          modality: 'video',
          occurrenceKey: 'extra',
          carrierType: 'asset',
          carrierKey: 'asset-video-extra',
          carrierVersion: 1,
          startMs: 0,
          endMs: 5000,
          anchorSource: 'subtitle',
          revision: 1,
        },
      ];
      fixture.assetPins = [
        ...(fixture.assetPins as LooseRecord[]),
        { assetKey: 'asset-video-extra', assetVersion: 1 },
      ];
      fixture.mediaAssets = [
        ...(fixture.mediaAssets as LooseRecord[]),
        { assetKey: 'asset-video-extra', assetVersion: 1, durationMs: 5000 },
      ];
      fixture.timingSources = [
        ...(fixture.timingSources as LooseRecord[]),
        {
          renditionKey: 'r-video-extra',
          sourceKind: 'subtitle',
          sourceArtifact: 'media/extra.srt',
          ruleVersion: 'timing-rules-v1',
        },
      ];
    });
    const issue = issuesOf(report, 'ALIGNMENT_UNBOUND').find(
      (entry) => entry.invariant === 'ALN-7',
    );
    expect(issue).toBeDefined();
    expect(issue?.details).toMatchObject({ renditionKey: 'r-video-extra' });
    expect(report.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          invariant: 'ALN-7',
          status: 'blocked',
          renditionKey: 'r-video-extra',
        }),
      ]),
    );
  });
});

describe('P5 不变量：G1 契约闭合 / STR 结构', () => {
  it('G1: a rendition referencing an unpinned asset fails contract closure', () => {
    const { report } = evaluate((fixture) => {
      fixture.assetPins = (fixture.assetPins as LooseRecord[]).filter(
        (pin) => pin.assetKey !== 'asset-video-en',
      );
    });
    expect(report.g1.passed).toBe(false);
    expect(report.g2.passed).toBe(true);
    const issue = issuesOf(report, 'REFERENCE_UNRESOLVED')[0];
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
    expect(issue?.details).toMatchObject({ renditionKey: 'r-video-en' });
  });

  it('STR-1: a leaf without objectives is a structural error', () => {
    const { report } = evaluate((fixture) => {
      const stage = (fixture.stages as LooseRecord[]).find(
        (entry) => entry.stageKey === 'step-2',
      ) as LooseRecord;
      stage.objectiveKeys = [];
    });
    expect(report.g2.passed).toBe(false);
    expect(
      issuesOf(report, 'STAGE_INVALID').some(
        (issue) => issue.invariant === 'STR-1',
      ),
    ).toBe(true);
  });

  it('STR-1: a stage kind not deeper than its parent is rejected', () => {
    const { report } = evaluate((fixture) => {
      const stage = (fixture.stages as LooseRecord[]).find(
        (entry) => entry.stageKey === 'step-1',
      ) as LooseRecord;
      stage.kind = 'program';
    });
    expect(
      issuesOf(report, 'STAGE_INVALID').some((issue) =>
        issue.message.includes('strictly deeper'),
      ),
    ).toBe(true);
  });

  it('STR-5: exitEvidence without an EvidenceSpec blocks publishing', () => {
    const { report } = evaluate((fixture) => {
      fixture.evidenceSpecs = (fixture.evidenceSpecs as LooseRecord[]).filter(
        (spec) => spec.evidenceKey !== 'ev-2',
      );
    });
    expect(report.g2.passed).toBe(false);
    const issue = issuesOf(report, 'EVIDENCE_INCOMPLETE').find(
      (entry) => entry.details?.evidenceKey === 'ev-2',
    );
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('incomplete');
    expect(issue?.invariant).toBe('STR-5');
  });

  it('STR-5: assessment evidence needs a verified assessment alignment', () => {
    const { report } = evaluate((fixture) => {
      const assessment = (fixture.alignments as LooseRecord[]).find(
        (alignment) => alignment.alignmentId === 'a9',
      ) as LooseRecord;
      assessment.role = 'support';
    });
    expect(
      issuesOf(report, 'EVIDENCE_INCOMPLETE').some(
        (issue) =>
          issue.invariant === 'STR-5' && issue.details?.stageKey === 'step-2',
      ),
    ).toBe(true);
  });
});

describe('P5 σ：多模态缺失是显式 degraded（机器报告，不静默）', () => {
  it('emits a degraded ALN-1 gap when a multi-modality target lacks one modality', () => {
    const { report } = evaluate((fixture) => {
      // step-3 只剩 video 材料：去掉 assessment alignment。
      fixture.alignments = (fixture.alignments as LooseRecord[]).filter(
        (alignment) => alignment.alignmentId !== 'a8',
      );
    });
    const step3 = selectionOf(report, 'step-3');
    expect(step3.selected).toHaveLength(1);
    expect(step3.gaps).toEqual([
      expect.objectContaining({
        reason: 'ALN-1',
        status: 'degraded',
        details: { modality: 'text' },
      }),
    ]);
    // degraded 只出 warning，不使 G2 失败。
    expect(report.g2.passed).toBe(true);
    expect(
      issuesOf(report, 'ALIGNMENT_UNBOUND').some(
        (issue) => issue.severity === 'warning' && issue.invariant === 'ALN-1',
      ),
    ).toBe(true);
  });
});

describe('P5 σ：occurrence 与 renditionKey tie-break', () => {
  it('keeps distinct occurrences as separate entries and breaks same-slot ties by renditionKey', () => {
    const { report } = evaluate((fixture) => {
      const renditions = fixture.renditions as LooseRecord[];
      const alignments = fixture.alignments as LooseRecord[];
      const base = renditions.find(
        (rendition) => rendition.renditionKey === 'r-doc-zh',
      ) as LooseRecord;
      // 同一 occurrence + 同一语言 + 同一角色的第二载体：同槽位，tie-break 取
      // renditionKey 升序的 r-doc-zh（较短的稳定键）。
      renditions.push({
        ...base,
        renditionKey: 'r-doc-zh-tie',
        carrierKey: 'doc-lesson-zh-tie',
      });
      alignments.push({
        alignmentId: 'a10',
        stageKey: 'step-1',
        renditionKey: 'r-doc-zh-tie',
        objectiveKey: 'obj-1',
        role: 'primary',
        status: 'verified',
        provenance: 'human',
        verifiedBy: 'editor-1',
        verifiedAt: '2026-11-10T09:10:00Z',
        verifiedAgainst: {
          renditionRevision: 1,
          carrierVersion: 1,
          specVersion: 1,
        },
      });
      // 不同 occurrenceKey = 内容事实，不是重复：保留为独立 entry。
      renditions.push({
        ...base,
        renditionKey: 'r-doc-zh-alt',
        occurrenceKey: 'alt',
        carrierKey: 'doc-lesson-zh-alt',
      });
      alignments.push({
        alignmentId: 'a11',
        stageKey: 'step-1',
        renditionKey: 'r-doc-zh-alt',
        objectiveKey: 'obj-1',
        role: 'primary',
        status: 'verified',
        provenance: 'human',
        verifiedBy: 'editor-1',
        verifiedAt: '2026-11-10T09:11:00Z',
        verifiedAgainst: {
          renditionRevision: 1,
          carrierVersion: 1,
          specVersion: 1,
        },
      });
    });
    const step1 = selectionOf(report, 'step-1');
    expect(step1.selected.map((entry) => entry.alignment.alignmentId)).toEqual([
      'a11',
      'a4',
      'a2',
      'a5',
    ]);
    expect(
      step1.selected.some((entry) => entry.alignment.alignmentId === 'a10'),
    ).toBe(false);
    expect(step1.selected[0].rendition.occurrenceKey).toBe('alt');
    expect(step1.selected[1].rendition.renditionKey).toBe('r-doc-zh');
  });
});
