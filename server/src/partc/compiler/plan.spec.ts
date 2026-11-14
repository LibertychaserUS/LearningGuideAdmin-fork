import { planBodyBytes } from '../contracts';
import { PartCError } from '../errors';
import { compilePlan, PlanInputError } from './plan';
import type { CompilePlanResult } from './plan';
import {
  FIXTURE_COURSE_KEY,
  buildCompilePlanInput,
  buildPlanFixtureArrays,
} from './plan.fixtures';
import type { LooseRecord, PlanFixtureOverrides } from './plan.fixtures';

/**
 * P5 compilePlan 单元测试（设计 §14 C5 P5、C6、C4、PLN-1）。
 *
 * 覆盖：canonical bytes（golden 锁定 / 重编译字节相等 / 不同 ruleVersion 不同）、
 * λ+σ 物化为 PlanEntry、blocked 显式 gap、degraded 显式 warning、G1–G3 门、
 * choice 拒绝、标量契约。
 */

function compileFixture(
  overrides: PlanFixtureOverrides = {},
): CompilePlanResult {
  return compilePlan(buildCompilePlanInput(overrides));
}

function compileWith(
  mutate: (fixture: ReturnType<typeof buildPlanFixtureArrays>) => void,
): CompilePlanResult {
  const fixture = buildPlanFixtureArrays();
  mutate(fixture);
  return compilePlan({
    content: {
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
    contentVersionId: fixture.contentVersionId,
    planVersion: fixture.planVersion,
    structureRevision: fixture.structureRevision,
    alignmentSetVersion: fixture.alignmentSetVersion,
    mediaAssets: fixture.mediaAssets,
    timingSources: fixture.timingSources,
  } as never);
}

/** golden bytes（STR-3 金样锁定；改动编译规则/顺序必须显式更新本常量）。 */
const GOLDEN_BYTES =
  '{"compilerVersion":"plan-compiler-v1","contentVersionId":"cv-01","entries":[{"alignmentId":"a4","entryId":"entry:step-1:a4:main","orderKey":"000001.000001","placement":{"documentKey":"doc-lesson-zh","documentVersion":1,"headingCode":"H1","offset":0,"type":"document"},"stageKey":"step-1","status":"ok"},{"alignmentId":"a2","entryId":"entry:step-1:a2:main","orderKey":"000001.000002","placement":{"assetKey":"asset-video-zh","assetVersion":1,"endMs":61000,"startMs":0,"type":"media"},"stageKey":"step-1","status":"ok"},{"alignmentId":"a5","entryId":"entry:step-1:a5:main","orderKey":"000001.000003","placement":{"blockIds":["q.1"],"contentKey":"lesson-1.knowledge-test","type":"assessment"},"stageKey":"step-1","status":"ok"},{"alignmentId":"a6","entryId":"entry:step-2:a6:main","orderKey":"000002.000001","placement":{"assetKey":"asset-video-en","assetVersion":1,"endMs":60000,"startMs":0,"type":"media"},"stageKey":"step-2","status":"ok"},{"alignmentId":"a9","entryId":"entry:step-2:a9:main","orderKey":"000002.000002","placement":{"blockIds":["q.1"],"contentKey":"lesson-1.knowledge-test","type":"assessment"},"stageKey":"step-2","status":"ok"},{"alignmentId":"a7","entryId":"entry:step-3:a7:main","orderKey":"000003.000001","placement":{"assetKey":"asset-video-zh","assetVersion":1,"endMs":61000,"startMs":0,"type":"media"},"stageKey":"step-3","status":"ok"},{"alignmentId":"a8","entryId":"entry:step-3:a8:main","orderKey":"000003.000002","placement":{"blockIds":["q.1"],"contentKey":"lesson-1.knowledge-test","type":"assessment"},"stageKey":"step-3","status":"ok"}],"inputClosure":{"alignmentSetVersion":7,"assetPins":[{"assetKey":"asset-video-en","assetVersion":1},{"assetKey":"asset-video-zh","assetVersion":1}],"compilerVersion":"plan-compiler-v1","courseKey":"modeling-life","resolvedChoices":[],"ruleVersion":"plan-rules-v1","specPins":[{"contentKey":"lesson-1","version":1},{"contentKey":"lesson-1.knowledge-test","version":1}],"structureRevision":4,"targetId":"target-zh"},"planId":"plan/modeling-life/cv-01/target-zh/v1","planVersion":1,"ruleVersion":"plan-rules-v1","targetId":"target-zh","warnings":[{"code":"PREREQUISITE_RECOMMENDS","stageKey":"step-3"}]}';

describe('P5 compilePlan：canonical Plan（C6 / PLN-1）', () => {
  it('produces the golden canonical bytes (λ + σ locked)', () => {
    const result = compileFixture();
    expect(result.status).toBe('draft');
    expect(result.bytes).toBe(GOLDEN_BYTES);
    expect(planBodyBytes(result.body)).toBe(GOLDEN_BYTES);
    expect(result.body.planId).toBe('plan/modeling-life/cv-01/target-zh/v1');
    expect(result.body.planVersion).toBe(1);
    expect(result.entries).toHaveLength(7);
    expect(result.warnings).toEqual([
      { code: 'PREREQUISITE_RECOMMENDS', stageKey: 'step-3' },
    ]);
    expect(result.gates.map((gate) => [gate.gate, gate.passed])).toEqual([
      ['G1', true],
      ['G2', true],
      ['G3', true],
    ]);
    expect(result.gaps).toEqual([]);
    expect(
      result.entries.map((entry) => [
        entry.stageKey,
        entry.orderKey,
        entry.placement.type,
      ]),
    ).toEqual([
      ['step-1', '000001.000001', 'document'],
      ['step-1', '000001.000002', 'media'],
      ['step-1', '000001.000003', 'assessment'],
      ['step-2', '000002.000001', 'media'],
      ['step-2', '000002.000002', 'assessment'],
      ['step-3', '000003.000001', 'media'],
      ['step-3', '000003.000002', 'assessment'],
    ]);
  });

  it('keeps plan status, wall-clock, random and locale out of the canonical bytes', () => {
    const result = compileFixture();
    const parsed = JSON.parse(result.bytes) as Record<string, unknown>;
    // Plan 级 status 外置（C6）；entry 的 status（ok/degraded/blocked）是
    // PlanEntry 契约字段，属于 canonical 内容。
    expect(parsed.status).toBeUndefined();
    expect(result.bytes).not.toContain('"status":"draft"');
    expect(result.bytes).not.toContain('"status":"approved"');
    expect(result.bytes).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(Object.keys(parsed).sort()).toEqual([
      'compilerVersion',
      'contentVersionId',
      'entries',
      'inputClosure',
      'planId',
      'planVersion',
      'ruleVersion',
      'targetId',
      'warnings',
    ]);
  });

  it('recompiling the same input closure yields byte-identical output (PLN-1)', () => {
    const first = compileFixture();
    const second = compileFixture();
    expect(second.bytes).toBe(first.bytes);
    expect(second.body).toEqual(first.body);
  });

  it('a different ruleVersion yields different bytes (pinned in inputClosure)', () => {
    const withRule = (ruleVersion: string): CompilePlanResult =>
      compilePlan({
        ...(buildCompilePlanInput() as unknown as Record<string, unknown>),
        ruleVersion,
      } as never);
    const v1 = withRule('plan-rules-v1');
    const v2 = withRule('plan-rules-v2');
    expect(v2.bytes).not.toBe(v1.bytes);
    expect(v2.body.planId).toBe(v1.body.planId);
  });

  it('changing the language fallback chain changes the selected renditions and bytes', () => {
    const base = compileFixture();
    const englishFirst = compileWith((fixture) => {
      (fixture.target as LooseRecord).languages = ['en-GB', 'zh-CN'];
    });
    expect(englishFirst.bytes).not.toBe(base.bytes);
    const step1 = englishFirst.entries.filter(
      (entry) => entry.stageKey === 'step-1',
    );
    expect(step1[0].placement).toMatchObject({
      type: 'document',
      documentKey: 'doc-lesson-en',
      documentVersion: 2,
    });
    expect(step1[1].placement).toMatchObject({
      type: 'media',
      assetKey: 'asset-video-en',
    });
  });
});

describe('P5 compilePlan：输入契约与 v1 拒绝（C5 P5）', () => {
  it('rejects non-empty resolvedChoices with UNSUPPORTED_ORDERING', () => {
    const input = {
      ...(buildCompilePlanInput() as unknown as Record<string, unknown>),
      resolvedChoices: ['choice-a'],
    };
    let error: unknown;
    try {
      compilePlan(input as never);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PartCError);
    expect((error as PartCError).code).toBe('UNSUPPORTED_ORDERING');
  });

  it('rejects choice container markers in the content tree with UNSUPPORTED_ORDERING', () => {
    const input = buildCompilePlanInput() as unknown as LooseRecord;
    const stages = (input.content as LooseRecord).stages as LooseRecord[];
    stages[0].choiceFrom = ['step-1', 'step-2'];
    let error: unknown;
    try {
      compilePlan(input as never);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PartCError);
    expect((error as PartCError).code).toBe('UNSUPPORTED_ORDERING');
    expect((error as PartCError).details).toMatchObject({
      choicePaths: ['content.stages[0].choiceFrom'],
    });
  });

  it('rejects malformed scalar inputs with PlanInputError', () => {
    expect(() =>
      compilePlan({
        ...(buildCompilePlanInput() as unknown as Record<string, unknown>),
        planVersion: 0,
      } as never),
    ).toThrow(PlanInputError);
    expect(() =>
      compilePlan({
        ...(buildCompilePlanInput() as unknown as Record<string, unknown>),
        target: { targetId: 'target-zh', languages: [], modalities: ['video'] },
      } as never),
    ).toThrow(PlanInputError);
  });
});

describe('P5 compilePlan：blocked 时输出显式 gap（C4）', () => {
  it('STR-1: an empty stage tree is blocked (no zero-entry draft plan)', () => {
    const result = compileFixture({ stages: [], prerequisiteEdges: [] });
    expect(result.status).toBe('blocked');
    expect(result.entries).toEqual([]);
    expect(result.gates.find((gate) => gate.gate === 'G2')?.passed).toBe(false);
    expect(
      result.issues.some(
        (issue) =>
          issue.code === 'STAGE_INVALID' &&
          issue.invariant === 'STR-1' &&
          issue.message.includes('at least one stage'),
      ),
    ).toBe(true);
  });

  it('ALN-1: a leaf with no verified alignment is blocked with a gap entry', () => {
    const result = compileWith((fixture) => {
      fixture.alignments = (fixture.alignments as LooseRecord[]).filter(
        (alignment) => alignment.stageKey !== 'step-2',
      );
    });
    expect(result.status).toBe('blocked');
    expect(result.gates.find((gate) => gate.gate === 'G2')?.passed).toBe(false);
    const gapEntry = result.entries.find(
      (entry) => entry.stageKey === 'step-2' && entry.placement.type === 'gap',
    );
    expect(gapEntry).toBeDefined();
    expect(gapEntry).toMatchObject({
      entryId: 'entry:step-2:gap:ALN-1',
      status: 'blocked',
      placement: { type: 'gap', reason: 'ALN-1' },
    });
    expect(result.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          invariant: 'ALN-1',
          status: 'blocked',
          stageKey: 'step-2',
          entryId: 'entry:step-2:gap:ALN-1',
        }),
      ]),
    );
    // gap entry 的 orderKey 仍在线性名次内且 entries 严格升序。
    const orderKeys = result.entries.map((entry) => entry.orderKey);
    expect(orderKeys).toEqual([...orderKeys].sort());
    expect(new Set(orderKeys).size).toBe(orderKeys.length);
  });

  it('a requires cycle blocks the whole plan with no entries (no misleading extension)', () => {
    const result = compileWith((fixture) => {
      (fixture.prerequisiteEdges as LooseRecord[]).push({
        fromStageKey: 'step-2',
        toStageKey: 'step-1',
        kind: 'requires',
      });
    });
    expect(result.status).toBe('blocked');
    expect(result.entries).toEqual([]);
    expect(result.linearization.ok).toBe(false);
    expect(
      result.issues.some(
        (issue) =>
          issue.code === 'PREREQUISITE_INVALID' && issue.invariant === 'STR-7',
      ),
    ).toBe(true);
    expect(result.gates.find((gate) => gate.gate === 'G2')?.passed).toBe(false);
  });

  it('G1: unpinned references block the plan at contract closure', () => {
    const result = compileWith((fixture) => {
      fixture.assetPins = (fixture.assetPins as LooseRecord[]).filter(
        (pin) => pin.assetKey !== 'asset-video-en',
      );
    });
    expect(result.status).toBe('blocked');
    expect(result.gates.find((gate) => gate.gate === 'G1')?.passed).toBe(false);
    expect(
      result.issues.some(
        (issue) =>
          issue.code === 'REFERENCE_UNRESOLVED' &&
          issue.details?.renditionKey === 'r-video-en',
      ),
    ).toBe(true);
  });

  it('G3: media placements exceeding durationBudget block publication', () => {
    const result = compileWith((fixture) => {
      const stage = (fixture.stages as LooseRecord[]).find(
        (entry) => entry.stageKey === 'step-1',
      ) as LooseRecord;
      stage.durationBudget = 60000;
    });
    expect(result.status).toBe('blocked');
    expect(result.gates.find((gate) => gate.gate === 'G3')?.passed).toBe(false);
    expect(
      result.issues.some(
        (issue) =>
          issue.invariant === 'G3' && issue.code === 'CONTENT_INCOMPLETE',
      ),
    ).toBe(true);
    expect(result.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          invariant: 'G3',
          status: 'blocked',
          stageKey: 'step-1',
        }),
      ]),
    );
  });
});

describe('P5 compilePlan：多模态缺失是显式 degraded', () => {
  it('emits a degraded gap entry + DEGRADED_PLACEMENT warning but keeps gates green', () => {
    const result = compileWith((fixture) => {
      fixture.alignments = (fixture.alignments as LooseRecord[]).filter(
        (alignment) => alignment.alignmentId !== 'a8',
      );
    });
    expect(result.status).toBe('degraded');
    expect(result.gates.every((gate) => gate.passed)).toBe(true);
    const gapEntry = result.entries.find(
      (entry) => entry.stageKey === 'step-3' && entry.placement.type === 'gap',
    );
    expect(gapEntry).toMatchObject({
      entryId: 'entry:step-3:gap:ALN-1',
      status: 'degraded',
      placement: { type: 'gap', reason: 'ALN-1' },
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        {
          code: 'DEGRADED_PLACEMENT',
          stageKey: 'step-3',
          entryId: 'entry:step-3:gap:ALN-1',
        },
      ]),
    );
    expect(result.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          invariant: 'ALN-1',
          status: 'degraded',
          stageKey: 'step-3',
        }),
      ]),
    );
  });
});
