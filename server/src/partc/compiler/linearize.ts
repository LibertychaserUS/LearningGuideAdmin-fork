import type { PrerequisiteEdge, Stage } from '../contracts';
import type { CompilerIssue } from './parse';

/**
 * Part C 编译器 P5：线性化 λ（设计 §14 C4 STR-2/STR-3、C2「Plan = 幂集截面」）。
 *
 * λ 把「交付叶偏序」映到唯一规范线性延伸：
 * - 偏序边 = ① sequence 投影：同级兄弟按 orderKey 升序，前一兄弟的叶子集全部先于
 *   后一兄弟的叶子集（与 validate.ts 的交付序图同语义）；② requires 先修：
 *   from 的叶子集先于 to 的叶子集（容器多父投影到叶，DAG 不是树）；
 *   recommends 只出 warning，不进交付序。
 * - choice 容器属 v1.1，本阶段不在此处理（parse 在 P1 以 UNSUPPORTED_ORDERING 拒绝；
 *   plan 对 resolvedChoices 非空同样拒绝）。
 * - 线性延伸唯一算法（STR-3）：Kahn 拓扑排序，就绪集合中按 orderKey 路径字典序
 *   取最小者，orderKey 相同按 stageKey 升序 tie-break。零填充数值路径段的字典序
 *   等于数值路径序（STAGE_ORDER_KEY_PATTERN 固定每段 6 位）。
 * - 交付序无环（STR-2）与 requires∪sequence 无环（STR-7）在此检查：SCC 均为单点。
 *   纯 sequence 投影的环 → DELIVERY_ORDER_CYCLE（STR-2）；只在加入 requires 后
 *   出现的环 → PREREQUISITE_INVALID（STR-7）。
 *
 * 纯函数：不读时钟、不发 IO、不依赖 locale（字符串比较按 UTF-16 码元）。
 * 前置条件：stageKey/orderKey 的唯一性由 invariants 的 G1 契约闭合检查负责；
 * 本模块对重复键取首次出现的索引（确定性），不静默改写输入。
 */

/** 交付序边：sequence = 兄弟链投影，requires = 先修。 */
export interface DeliveryOrderEdge {
  readonly fromStageKey: string;
  readonly toStageKey: string;
  readonly kind: 'sequence' | 'requires';
}

export interface LinearizedLeaf {
  readonly stageKey: string;
  readonly orderKey: string;
  /** 1 基线性化名次；PlanEntry.orderKey 的第一段即此值。 */
  readonly rank: number;
}

export interface LinearizeResult {
  /** 无交付序环、requires 端点完整时为 true。false 时不产出线性延伸。 */
  readonly ok: boolean;
  /** 交付叶按 λ 名次排序；!ok 时为空数组。 */
  readonly leaves: readonly LinearizedLeaf[];
  /** 交付叶 stage（!ok 时为空），顺序与 leaves 一致。 */
  readonly leafStages: readonly Stage[];
  /** 去重后的偏序边（确定性排序）。 */
  readonly edges: readonly DeliveryOrderEdge[];
  readonly issues: readonly CompilerIssue[];
  /** recommends 只出 warning（STR-7）。 */
  readonly warnings: readonly CompilerIssue[];
}

export interface LinearizeInput {
  readonly courseKey: string;
  readonly stages: readonly Stage[];
  readonly prerequisiteEdges: readonly PrerequisiteEdge[];
}

function makeIssue(
  severity: 'error' | 'warning',
  code: CompilerIssue['code'],
  message: string,
  invariant: string,
  details?: Record<string, unknown>,
): CompilerIssue {
  return { severity, code, message, invariant, details };
}

function compareOrderKeyThenStageKey(
  left: { readonly orderKey: string; readonly stageKey: string },
  right: { readonly orderKey: string; readonly stageKey: string },
): number {
  if (left.orderKey < right.orderKey) return -1;
  if (left.orderKey > right.orderKey) return 1;
  if (left.stageKey < right.stageKey) return -1;
  if (left.stageKey > right.stageKey) return 1;
  return 0;
}

/** 确定性二叉最小堆（就绪叶按 orderKey 路径 + stageKey 排序）。 */
class LeafHeap {
  private readonly items: Array<{ orderKey: string; stageKey: string }> = [];

  get size(): number {
    return this.items.length;
  }

  push(item: { orderKey: string; stageKey: string }): void {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (
        compareOrderKeyThenStageKey(this.items[index], this.items[parent]) >= 0
      ) {
        break;
      }
      [this.items[index], this.items[parent]] = [
        this.items[parent],
        this.items[index],
      ];
      index = parent;
    }
  }

  pop(): { orderKey: string; stageKey: string } | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop() as { orderKey: string; stageKey: string };
    if (this.items.length > 0) {
      this.items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (
          left < this.items.length &&
          compareOrderKeyThenStageKey(this.items[left], this.items[smallest]) <
            0
        ) {
          smallest = left;
        }
        if (
          right < this.items.length &&
          compareOrderKeyThenStageKey(this.items[right], this.items[smallest]) <
            0
        ) {
          smallest = right;
        }
        if (smallest === index) break;
        [this.items[index], this.items[smallest]] = [
          this.items[smallest],
          this.items[index],
        ];
        index = smallest;
      }
    }
    return top;
  }
}

interface StageGraphIndex {
  readonly stageByKey: Map<string, Stage>;
  /** parentStageKey（含缺失父视作根）→ 子 stageKey 列表（按 orderKey,tageKey 排序）。 */
  readonly childrenByParent: Map<string, string[]>;
  readonly rootStageKeys: string[];
}

function buildStageIndex(stages: readonly Stage[]): StageGraphIndex {
  const stageByKey = new Map<string, Stage>();
  for (const stage of stages) {
    if (!stageByKey.has(stage.stageKey)) {
      stageByKey.set(stage.stageKey, stage);
    }
  }
  const childrenByParent = new Map<string, string[]>();
  const rootStageKeys: string[] = [];
  for (const stage of stages) {
    const parentKey = stage.parentStageKey;
    if (parentKey === null || !stageByKey.has(parentKey)) {
      rootStageKeys.push(stage.stageKey);
      continue;
    }
    const list = childrenByParent.get(parentKey) ?? [];
    list.push(stage.stageKey);
    childrenByParent.set(parentKey, list);
  }
  const byOrder = (a: string, b: string): number =>
    compareOrderKeyThenStageKey(
      stageByKey.get(a) as Stage,
      stageByKey.get(b) as Stage,
    );
  for (const list of childrenByParent.values()) list.sort(byOrder);
  rootStageKeys.sort(byOrder);
  return { stageByKey, childrenByParent, rootStageKeys };
}

/** 子树交付叶（无子节点的 stage）；seen 防御包含环，重复引用不重复展开。 */
function leafStageKeysOf(
  rootStageKey: string,
  index: StageGraphIndex,
): string[] {
  const leaves: string[] = [];
  const stack = [rootStageKey];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const children = index.childrenByParent.get(current);
    if (children === undefined || children.length === 0) {
      leaves.push(current);
      continue;
    }
    // 逆序压栈，保证按兄弟顺序弹出（叶子集合最终会排序，不依赖此顺序）。
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push(children[i]);
    }
  }
  return leaves.sort((a, b) =>
    compareOrderKeyThenStageKey(
      index.stageByKey.get(a) as Stage,
      index.stageByKey.get(b) as Stage,
    ),
  );
}

/** 交付叶集合（整棵包含森林）。 */
export function deliveryLeafStageKeys(stages: readonly Stage[]): string[] {
  const index = buildStageIndex(stages);
  const leaves = new Set<string>();
  for (const rootKey of index.rootStageKeys) {
    for (const leafKey of leafStageKeysOf(rootKey, index)) {
      leaves.add(leafKey);
    }
  }
  return [...leaves].sort((a, b) =>
    compareOrderKeyThenStageKey(
      index.stageByKey.get(a) as Stage,
      index.stageByKey.get(b) as Stage,
    ),
  );
}

/** Tarjan SCC；返回 SCC 列表（节点按字符串排序，顺序确定）。 */
function stronglyConnectedComponents(
  nodes: readonly string[],
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  let counter = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  const visit = (node: string): void => {
    indices.set(node, counter);
    lowlink.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        lowlink.set(
          node,
          Math.min(lowlink.get(node) as number, lowlink.get(next) as number),
        );
      } else if (onStack.has(next)) {
        lowlink.set(
          node,
          Math.min(lowlink.get(node) as number, indices.get(next) as number),
        );
      }
    }
    if (lowlink.get(node) === indices.get(node)) {
      const component: string[] = [];
      let current: string;
      do {
        current = stack.pop() as string;
        onStack.delete(current);
        component.push(current);
      } while (current !== node);
      components.push(component.sort());
    }
  };

  for (const node of nodes) {
    if (!indices.has(node)) visit(node);
  }
  return components;
}

function cyclicComponents(
  nodes: readonly string[],
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  const cycles: string[][] = [];
  for (const component of stronglyConnectedComponents(nodes, edges)) {
    if (component.length > 1) {
      cycles.push(component);
    } else {
      const only = component[0];
      if (edges.get(only)?.has(only)) cycles.push(component);
    }
  }
  return cycles;
}

interface DeliveryGraph {
  readonly nodes: readonly string[];
  readonly edges: readonly DeliveryOrderEdge[];
  readonly outEdges: ReadonlyMap<string, ReadonlySet<string>>;
  readonly issues: readonly CompilerIssue[];
  readonly warnings: readonly CompilerIssue[];
}

function buildDeliveryGraph(input: LinearizeInput): DeliveryGraph {
  const index = buildStageIndex(input.stages);
  const nodes = deliveryLeafStageKeys(input.stages);
  const nodeSet = new Set(nodes);
  const edgeMap = new Map<string, DeliveryOrderEdge>();
  const sequenceOut = new Map<string, Set<string>>();

  const addEdge = (
    fromStageKey: string,
    toStageKey: string,
    kind: DeliveryOrderEdge['kind'],
  ): void => {
    if (!nodeSet.has(fromStageKey) || !nodeSet.has(toStageKey)) return;
    const key = `${kind}\u0000${fromStageKey}\u0000${toStageKey}`;
    if (edgeMap.has(key)) return;
    edgeMap.set(key, { fromStageKey, toStageKey, kind });
    if (kind === 'sequence') {
      const set = sequenceOut.get(fromStageKey) ?? new Set<string>();
      set.add(toStageKey);
      sequenceOut.set(fromStageKey, set);
    }
  };

  const projectSiblings = (siblingKeys: readonly string[]): void => {
    for (let i = 0; i + 1 < siblingKeys.length; i += 1) {
      const leftLeaves = leafStageKeysOf(siblingKeys[i], index);
      const rightLeaves = leafStageKeysOf(siblingKeys[i + 1], index);
      for (const left of leftLeaves) {
        for (const right of rightLeaves) {
          addEdge(left, right, 'sequence');
        }
      }
    }
  };

  projectSiblings(index.rootStageKeys);
  // childrenByParent 的键序来自输入插入序，先排序保证确定性。
  for (const parentKey of [...index.childrenByParent.keys()].sort()) {
    projectSiblings(index.childrenByParent.get(parentKey) as string[]);
  }

  const issues: CompilerIssue[] = [];
  const warnings: CompilerIssue[] = [];

  for (const edge of input.prerequisiteEdges) {
    const fromExists = index.stageByKey.has(edge.fromStageKey);
    const toExists = index.stageByKey.has(edge.toStageKey);
    if (!fromExists || !toExists) {
      issues.push(
        makeIssue(
          'error',
          'PREREQUISITE_INVALID',
          'prerequisite edge endpoints must exist in this content version',
          'STR-7',
          {
            fromStageKey: edge.fromStageKey,
            toStageKey: edge.toStageKey,
            fromExists,
            toExists,
          },
        ),
      );
      continue;
    }
    if (edge.kind === 'recommends') {
      warnings.push(
        makeIssue(
          'warning',
          'PREREQUISITE_WARNING',
          'recommends edge does not enter the delivery order (warning only)',
          'STR-7',
          { fromStageKey: edge.fromStageKey, toStageKey: edge.toStageKey },
        ),
      );
      continue;
    }
    const fromLeaves = leafStageKeysOf(edge.fromStageKey, index);
    const toLeaves = leafStageKeysOf(edge.toStageKey, index);
    for (const from of fromLeaves) {
      for (const to of toLeaves) {
        addEdge(from, to, 'requires');
      }
    }
  }

  const outEdges = new Map<string, Set<string>>();
  for (const edge of edgeMap.values()) {
    const set = outEdges.get(edge.fromStageKey) ?? new Set<string>();
    set.add(edge.toStageKey);
    outEdges.set(edge.fromStageKey, set);
  }

  // STR-2：纯 sequence 投影环。STR-7：只在 requires 加入后出现的环。
  const sequenceCycles = cyclicComponents(nodes, sequenceOut);
  const sequenceCycleKeys = new Set(
    sequenceCycles.map((cycle) => cycle.join('\u0000')),
  );
  for (const cycle of sequenceCycles) {
    issues.push(
      makeIssue(
        'error',
        'DELIVERY_ORDER_CYCLE',
        'sequence sibling chains project to a cycle over delivery leaves',
        'STR-2',
        { stageKeys: cycle },
      ),
    );
  }
  for (const cycle of cyclicComponents(nodes, outEdges)) {
    if (sequenceCycleKeys.has(cycle.join('\u0000'))) continue;
    issues.push(
      makeIssue(
        'error',
        'PREREQUISITE_INVALID',
        'requires edges combined with sequence order contain a cycle',
        'STR-7',
        { stageKeys: cycle },
      ),
    );
  }

  const edges = [...edgeMap.values()].sort((a, b) => {
    if (a.fromStageKey !== b.fromStageKey) {
      return a.fromStageKey < b.fromStageKey ? -1 : 1;
    }
    if (a.toStageKey !== b.toStageKey) {
      return a.toStageKey < b.toStageKey ? -1 : 1;
    }
    return a.kind < b.kind ? -1 : 1;
  });

  return { nodes, edges, outEdges, issues, warnings };
}

/**
 * λ：交付叶偏序 → 唯一规范线性延伸（STR-3）。
 *
 * 有交付序环或 requires 端点缺失时 ok=false 且不给出线性延伸（禁止产出
 * 误导性的部分计划；由 plan 层输出 blocked + 显式 gap）。
 */
export function linearizeDeliveryOrder(input: LinearizeInput): LinearizeResult {
  const graph = buildDeliveryGraph(input);
  const warnings = [...graph.warnings].sort((a, b) => {
    const left = JSON.stringify(a.details ?? {});
    const right = JSON.stringify(b.details ?? {});
    return left < right ? -1 : left > right ? 1 : 0;
  });
  if (graph.issues.length > 0) {
    return {
      ok: false,
      leaves: [],
      leafStages: [],
      edges: graph.edges,
      issues: graph.issues,
      warnings,
    };
  }

  const index = buildStageIndex(input.stages);
  const indegree = new Map<string, number>();
  for (const node of graph.nodes) indegree.set(node, 0);
  // 同一对叶可能同时被 sequence 与 requires 约束；偏序语义下只算一条边。
  for (const successors of graph.outEdges.values()) {
    for (const to of successors) {
      indegree.set(to, (indegree.get(to) ?? 0) + 1);
    }
  }

  const heap = new LeafHeap();
  for (const node of graph.nodes) {
    if ((indegree.get(node) ?? 0) === 0) {
      const stage = index.stageByKey.get(node) as Stage;
      heap.push({ orderKey: stage.orderKey, stageKey: node });
    }
  }

  const ordered: Array<{ orderKey: string; stageKey: string }> = [];
  while (heap.size > 0) {
    const next = heap.pop() as { orderKey: string; stageKey: string };
    ordered.push(next);
    for (const successor of graph.outEdges.get(next.stageKey) ?? []) {
      const remaining = (indegree.get(successor) as number) - 1;
      indegree.set(successor, remaining);
      if (remaining === 0) {
        const stage = index.stageByKey.get(successor) as Stage;
        heap.push({ orderKey: stage.orderKey, stageKey: successor });
      }
    }
  }

  if (ordered.length !== graph.nodes.length) {
    // 无环图不可能触发；出现即编译器缺陷，明确失败而不是产出半计划。
    throw new Error(
      `linearizeDeliveryOrder: internal error, ${ordered.length}/${graph.nodes.length} leaves ordered`,
    );
  }

  const leaves: LinearizedLeaf[] = ordered.map((node, index0) => ({
    stageKey: node.stageKey,
    orderKey: node.orderKey,
    rank: index0 + 1,
  }));
  const leafStages = leaves.map(
    (leaf) => index.stageByKey.get(leaf.stageKey) as Stage,
  );

  // 防御：线性延伸必须覆盖全部偏序边（Kahn + 环检测后恒成立）。
  const rankByKey = new Map(leaves.map((leaf) => [leaf.stageKey, leaf.rank]));
  for (const edge of graph.edges) {
    if (
      (rankByKey.get(edge.fromStageKey) as number) >=
      (rankByKey.get(edge.toStageKey) as number)
    ) {
      throw new Error(
        `linearizeDeliveryOrder: internal error, linear extension violates ${edge.kind} edge ${edge.fromStageKey}->${edge.toStageKey}`,
      );
    }
  }

  return {
    ok: true,
    leaves,
    leafStages,
    edges: graph.edges,
    issues: [],
    warnings,
  };
}
