import { linearizeDeliveryOrder } from './linearize';
import type { LinearizeInput } from './linearize';
import { FIXTURE_COURSE_KEY, buildPlanFixtureArrays } from './plan.fixtures';
import type { LooseRecord } from './plan.fixtures';

/**
 * P5 λ 线性化单元测试（设计 §14 C4 STR-2/STR-3/C2）。
 *
 * 断言口径：交付叶名次（rank）、偏序边、环的归属（STR-2 sequence vs STR-7
 * requires）、以及同序兄弟的 stageKey tie-break 确定性。
 */

function linearizeFixture(
  mutate?: (fixture: ReturnType<typeof buildPlanFixtureArrays>) => void,
): ReturnType<typeof linearizeDeliveryOrder> {
  const fixture = buildPlanFixtureArrays();
  mutate?.(fixture);
  const input = {
    courseKey: FIXTURE_COURSE_KEY,
    stages: fixture.stages,
    prerequisiteEdges: fixture.prerequisiteEdges,
  } as unknown as LinearizeInput;
  return linearizeDeliveryOrder(input);
}

describe('P5 λ：交付叶唯一规范线性延伸（STR-3）', () => {
  it('linearizes the fixture forest into strict tree order with contiguous ranks', () => {
    const result = linearizeFixture();
    expect(result.ok).toBe(true);
    expect(result.leaves.map((leaf) => leaf.stageKey)).toEqual([
      'step-1',
      'step-2',
      'step-3',
    ]);
    expect(result.leaves.map((leaf) => leaf.rank)).toEqual([1, 2, 3]);
    expect(result.leaves.map((leaf) => leaf.orderKey)).toEqual([
      '000001.000001',
      '000001.000002',
      '000002.000001',
    ]);
    expect(result.issues).toEqual([]);
    // requires step-1 → step-3 与树序一致：边存在且不改变线性延伸。
    expect(result.edges).toEqual(
      expect.arrayContaining([
        {
          fromStageKey: 'step-1',
          toStageKey: 'step-3',
          kind: 'requires',
        },
        {
          fromStageKey: 'step-2',
          toStageKey: 'step-3',
          kind: 'sequence',
        },
      ]),
    );
  });

  it('is deterministic: the same input produces byte-identical leaves and edges', () => {
    const first = linearizeFixture();
    const second = linearizeFixture();
    expect(JSON.stringify(second.leaves)).toBe(JSON.stringify(first.leaves));
    expect(JSON.stringify(second.edges)).toBe(JSON.stringify(first.edges));
  });

  it('breaks sibling orderKey ties by stageKey (canonical, never input order)', () => {
    const fixture = buildPlanFixtureArrays({
      stages: [
        {
          courseKey: FIXTURE_COURSE_KEY,
          stageKey: 'zeta',
          parentStageKey: null,
          orderKey: '000001',
          kind: 'step',
          goal: 'z',
          objectiveKeys: ['obj-z'],
          exitEvidence: ['ev-z'],
          exitRollup: { kind: 'all' },
          status: 'active',
        },
        {
          courseKey: FIXTURE_COURSE_KEY,
          stageKey: 'alpha',
          parentStageKey: null,
          orderKey: '000001',
          kind: 'step',
          goal: 'a',
          objectiveKeys: ['obj-a'],
          exitEvidence: ['ev-a'],
          exitRollup: { kind: 'all' },
          status: 'active',
        },
      ],
      prerequisiteEdges: [],
    });
    const result = linearizeDeliveryOrder({
      courseKey: FIXTURE_COURSE_KEY,
      stages: fixture.stages,
      prerequisiteEdges: fixture.prerequisiteEdges,
    } as unknown as LinearizeInput);
    expect(result.ok).toBe(true);
    expect(result.leaves.map((leaf) => leaf.stageKey)).toEqual([
      'alpha',
      'zeta',
    ]);
  });
});

describe('P5 λ：交付序无环（STR-2 / STR-7）', () => {
  it('rejects a requires edge that contradicts the sibling sequence (combined cycle)', () => {
    const result = linearizeFixture((fixture) => {
      (fixture.prerequisiteEdges as LooseRecord[]).push({
        fromStageKey: 'step-2',
        toStageKey: 'step-1',
        kind: 'requires',
      });
    });
    expect(result.ok).toBe(false);
    expect(result.leaves).toEqual([]);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'PREREQUISITE_INVALID',
          severity: 'error',
          invariant: 'STR-7',
        }),
      ]),
    );
  });

  it('reports requires endpoints that do not exist (STR-7) and yields no extension', () => {
    const result = linearizeFixture((fixture) => {
      (fixture.prerequisiteEdges as LooseRecord[]).push({
        fromStageKey: 'step-1',
        toStageKey: 'missing-stage',
        kind: 'requires',
      });
    });
    expect(result.ok).toBe(false);
    const issue = result.issues.find(
      (entry) => entry.code === 'PREREQUISITE_INVALID',
    );
    expect(issue).toBeDefined();
    expect(issue?.invariant).toBe('STR-7');
    expect(issue?.details).toMatchObject({
      fromStageKey: 'step-1',
      toStageKey: 'missing-stage',
      fromExists: true,
      toExists: false,
    });
  });

  it('treats recommends as warning only: no delivery edge, order unchanged', () => {
    const result = linearizeFixture((fixture) => {
      (fixture.prerequisiteEdges as LooseRecord[]).push({
        fromStageKey: 'step-3',
        toStageKey: 'step-2',
        kind: 'recommends',
      });
    });
    expect(result.ok).toBe(true);
    expect(result.leaves.map((leaf) => leaf.stageKey)).toEqual([
      'step-1',
      'step-2',
      'step-3',
    ]);
    expect(
      result.edges.some(
        (edge) =>
          edge.fromStageKey === 'step-3' && edge.toStageKey === 'step-2',
      ),
    ).toBe(false);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'PREREQUISITE_WARNING',
          severity: 'warning',
          invariant: 'STR-7',
        }),
      ]),
    );
  });
});
