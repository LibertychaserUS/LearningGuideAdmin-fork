import {
  FAQ_GRAPH_LIMITS,
  type FaqEdgeKind,
  type FaqGraphEdge,
  type FaqGraphNode,
  type FaqGraphPreview,
  type FaqRelease,
  type FaqReleaseEvalReport,
  type FaqSnapshotDiff,
  type FaqTreeNode,
  type HelpdeskLocale,
} from '../contracts/helpdesk'

/**
 * v5 问题树员工端（helpdesk-v5-faq-graph-design §5）的纯逻辑：「追问与选项」的重排与覆盖文字、问法校验、
 * 树视图的展开、对话预览（与 Portal 点击时一样：固定模板 + 原文答案 + ≤ 4 个追问；choice 的 A/B/C/D），
 * 发布页每个版本能做什么。上限与服务端 faqContracts.ts 一致；单测在 client/tests/helpdesk-graph.test.ts。
 */

/** 按码点算长度（与服务端一致：一个 emoji 算 1）。 */
export function codePoints(text: string): number {
  return [...text].length
}

const tidy = (text: string) => text.trim().replace(/\s+/g, ' ')

/** 把 from 的那一项挪到 to（越界的 to 取边界；from 越界不变）。 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length) return [...items]
  const target = Math.max(0, Math.min(items.length - 1, to))
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(target, 0, item)
  return next
}

/* ---------------------------------- 覆盖文字 ---------------------------------- */

export type LabelDraft = { en: string; zh: string }
export type LabelError = 'both' | 'tooLongEn' | 'tooLongZh'

export function labelLimits(kind: FaqEdgeKind): { en: number; zh: number } {
  return kind === 'option'
    ? { en: FAQ_GRAPH_LIMITS.optionLabelMaxEn, zh: FAQ_GRAPH_LIMITS.optionLabelMaxZh }
    : { en: FAQ_GRAPH_LIMITS.followUpLabelMax, zh: FAQ_GRAPH_LIMITS.followUpLabelMax }
}

/** 两种语言要么都给、要么都空（= 用子节点的问题）；选项 ≤ 24 中文字 / 40 英文字符，追问 ≤ 200。 */
export function validateLabelDraft(kind: FaqEdgeKind, draft: LabelDraft): LabelError | null {
  const en = tidy(draft.en)
  const zh = tidy(draft.zh)
  if ((en === '') !== (zh === '')) return 'both'
  const max = labelLimits(kind)
  if (codePoints(en) > max.en) return 'tooLongEn'
  if (codePoints(zh) > max.zh) return 'tooLongZh'
  return null
}

export function labelBody(draft: LabelDraft): { labelEn: string | null; labelZh: string | null } {
  const en = tidy(draft.en)
  const zh = tidy(draft.zh)
  return { labelEn: en || null, labelZh: zh || null }
}

export function labelDraftOf(edge: { labelEn: string | null; labelZh: string | null }): LabelDraft {
  return { en: edge.labelEn ?? '', zh: edge.labelZh ?? '' }
}

export function validatePhrasing(text: string): 'required' | 'tooLong' | null {
  const value = tidy(text)
  if (value === '') return 'required'
  return codePoints(value) > FAQ_GRAPH_LIMITS.phrasingMax ? 'tooLong' : null
}

/* ---------------------------------- 树视图 ---------------------------------- */

/** 一行大纲：path 是从根到这里的节点 id（DAG 的共享节点每次出现各有一个 path）。 */
export type OutlineRow = {
  path: string
  item: FaqTreeNode
  level: number
  /** 在兄弟节点里的位置（选项的 A/B/C/D）。 */
  index: number
  hasChildren: boolean
  expanded: boolean
}

function walk(node: FaqTreeNode, path: string, visit: (node: FaqTreeNode, path: string) => boolean): void {
  if (!visit(node, path)) return
  for (const child of node.children) walk(child, `${path}/${child.node.id}`, visit)
}

export function allPaths(root: FaqTreeNode): Set<string> {
  const out = new Set<string>()
  walk(root, root.node.id, (_node, path) => {
    out.add(path)
    return true
  })
  return out
}

/** 展开的节点下面的子节点可见；收起的节点整支藏起来。 */
export function outlineRows(root: FaqTreeNode, expanded: ReadonlySet<string>): OutlineRow[] {
  const rows: OutlineRow[] = []
  const visit = (node: FaqTreeNode, path: string, level: number, index: number) => {
    const open = expanded.has(path) && node.children.length > 0
    rows.push({ path, item: node, level, index, hasChildren: node.children.length > 0, expanded: open })
    if (open) node.children.forEach((child, at) => visit(child, `${path}/${child.node.id}`, level + 1, at))
  }
  visit(root, root.node.id, 0, 0)
  return rows
}

/** 打开时：根与它的子节点展开（看得到孙节点）。 */
export function initialExpanded(root: FaqTreeNode): Set<string> {
  const out = new Set<string>()
  if (root.children.length > 0) out.add(root.node.id)
  for (const child of root.children) if (child.children.length > 0) out.add(`${root.node.id}/${child.node.id}`)
  return out
}

/* -------------------------------- 对话预览 -------------------------------- */

/**
 * 点击（追问 chip、选项按钮、starter）时的固定模板（v5 Part H：点击不问模型）。与 Portal
 * assistantTurn.ts TURN_TEMPLATES、Admin guard.ts TEMPLATES 的 opening / closing 一字不差。
 */
export const CLICK_TEMPLATES: Record<HelpdeskLocale, { opening: string; closing: string }> = {
  'en-GB': { opening: "Here's how to sort this out:", closing: "If anything's unclear, just ask." },
  'zh-CN': { opening: '好的，这个问题可以这样处理：', closing: '还有不清楚的，接着问我就好。' },
}

export type PreviewGraph = {
  node: (id: string) => FaqGraphNode | null
  children: (id: string) => FaqGraphEdge[]
}

export function previewGraph(preview: FaqGraphPreview): PreviewGraph {
  const nodes = new Map(preview.nodes.map((node) => [node.id, node]))
  const children = new Map<string, FaqGraphEdge[]>()
  for (const edge of preview.edges) children.set(edge.parentId, [...(children.get(edge.parentId) ?? []), edge])
  for (const list of children.values()) list.sort((a, b) => a.position - b.position)
  return { node: (id) => nodes.get(id) ?? null, children: (id) => children.get(id) ?? [] }
}

export type PreviewStep = { nodeId: string; label: string; letter: string }

export type PreviewTurn =
  | {
      kind: 'answer'
      nodeId: string
      question: string
      opening: string
      /** 整条答案原文（点击时不截取）。 */
      answer: string
      closing: string
      steps: PreviewStep[]
      /** 超过 4 条、学员看不到的追问条数。 */
      hiddenSteps: number
    }
  | { kind: 'choice'; nodeId: string; question: string; prompt: string; steps: PreviewStep[]; hiddenSteps: number }
  | { kind: 'missing'; nodeId: string }

const letter = (index: number) => String.fromCharCode(65 + index)

/** 学员点到这个节点时看到什么：与 Portal nextOf 同样的规则（边的种类要对、子节点要在、至多 4 个）。 */
export function previewTurn(graph: PreviewGraph, nodeId: string, locale: HelpdeskLocale): PreviewTurn {
  const node = graph.node(nodeId)
  if (!node) return { kind: 'missing', nodeId }
  const kind: FaqEdgeKind = node.type === 'choice' ? 'option' : 'follow_up'
  const real = graph.children(node.id).filter((edge) => edge.kind === kind && graph.node(edge.childId))
  const steps = real
    .slice(0, FAQ_GRAPH_LIMITS.followUpsShown)
    .map((edge, index) => ({ nodeId: edge.childId, label: edge.label, letter: letter(index) }))
  const hiddenSteps = real.length - steps.length
  if (node.type === 'choice') return { kind: 'choice', nodeId: node.id, question: node.question, prompt: node.answer, steps, hiddenSteps }
  const templates = CLICK_TEMPLATES[locale]
  return {
    kind: 'answer',
    nodeId: node.id,
    question: node.question,
    opening: templates.opening,
    answer: node.answer,
    closing: templates.closing,
    steps,
    hiddenSteps,
  }
}

/** 从哪里开始预览：入口节点，热门的在前，再按 key 排（与语言、排序规则无关，稳定）。 */
export function previewStarts(preview: FaqGraphPreview): FaqGraphNode[] {
  return preview.nodes
    .filter((node) => node.entry)
    .sort((a, b) => Number(b.popular) - Number(a.popular) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/* ---------------------------------- 发布页 ---------------------------------- */

export type ReleaseActions = { publish: boolean; recheck: boolean; rollback: boolean }

/**
 * 一个版本能做什么（服务端 faqReleaseService.ts 的同一套规则，按钮只在能成功时出现）：
 * - 发布：draft 且检查与评测都过了（publishable）；
 * - 重新检查：draft / rejected / evaluating，且不是回滚出来的版本；
 * - 回滚：曾经上线过（superseded），且当前上线的不是它、也不是从它回滚来的。
 */
export function releaseActions(release: FaqRelease, published: number | null, live?: FaqRelease | null): ReleaseActions {
  // 正在检查的不能再开一次（服务端 409）；中断了（或旧的服务端没报进度）才可以重新检查
  const reEvaluable =
    (['draft', 'rejected'].includes(release.status) || (release.status === 'evaluating' && release.evaluation?.state !== 'running')) &&
    release.sourceVersion === null
  const rollback =
    release.status === 'superseded' && release.version !== published && (live?.sourceVersion ?? null) !== release.version
  return { publish: release.publishable, recheck: reEvaluable, rollback }
}

export function diffTotal(diff: FaqSnapshotDiff): number {
  return (
    diff.nodes.added.length +
    diff.nodes.removed.length +
    diff.nodes.changed.length +
    diff.edges.added.length +
    diff.edges.removed.length +
    diff.edges.changed.length +
    diff.phrasings.added +
    diff.phrasings.removed +
    (diff.map?.added ?? 0) +
    (diff.map?.removed ?? 0)
  )
}

/** 评测报告的 recall@8（没有 → null）。 */
export function evalRecall(report: FaqReleaseEvalReport | null): number | null {
  const value = report?.metrics?.recallAt8
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 真流程检查那一份报告（combined 的 parts 里，或单独的 model 报告）；没跑 → null。 */
export function modelReport(report: FaqReleaseEvalReport | null): FaqReleaseEvalReport | null {
  if (!report) return null
  if (report.kind === 'model') return report
  return report.parts?.find((part) => part.kind === 'model') ?? null
}

/** 列表上的状态：evaluating 且心跳停了 → interrupted。 */
export function releaseStatusKey(release: FaqRelease): string {
  return release.status === 'evaluating' && release.evaluation?.state === 'interrupted' ? 'interrupted' : release.status
}

/** 美元 → 人民币（约数，界面显示「约 ¥」用）。 */
export const USD_TO_CNY = 7.2
