import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import enGB from '../src/backoffice/messages/en-GB.json'
import zhCN from '../src/backoffice/messages/zh-CN.json'
import {
  FAQ_RELEASE_STATUSES,
  GRAPH_RULES,
  type FaqGraphPreview,
  type FaqRelease,
  type FaqSnapshotDiff,
  type FaqTreeNode,
} from '../src/backoffice/contracts/helpdesk'
import {
  CLICK_TEMPLATES,
  allPaths,
  diffTotal,
  evalRecall,
  initialExpanded,
  labelBody,
  labelDraftOf,
  moveItem,
  outlineRows,
  previewGraph,
  previewStarts,
  previewTurn,
  releaseActions,
  releaseStatusKey,
  modelReport,
  validateLabelDraft,
  validatePhrasing,
} from '../src/backoffice/lib/helpdeskGraph'

/**
 * v5 问题树员工端（graph design §5）的纯逻辑：子节点重排、覆盖文字与问法校验、树视图的展开、
 * 对话预览（与 Portal 点击时同样的三段式与固定模板、≤ 4 个追问、A/B/C/D 选项）、发布页的可用操作。
 */

describe('children order and labels', () => {
  test('moves an item, clamping the target; out of range changes nothing', () => {
    assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a'])
    assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b'])
    assert.deepEqual(moveItem(['a', 'b', 'c'], 1, 9), ['a', 'c', 'b'])
    assert.deepEqual(moveItem(['a', 'b', 'c'], 1, 1), ['a', 'b', 'c'])
    assert.deepEqual(moveItem(['a', 'b', 'c'], 5, 0), ['a', 'b', 'c'])
  })

  test('label override: both languages or neither; options ≤ 24 zh / 40 en, follow-ups ≤ 200 (code points)', () => {
    assert.equal(validateLabelDraft('option', { en: '', zh: '  ' }), null)
    assert.equal(validateLabelDraft('option', { en: 'Failed', zh: '' }), 'both')
    assert.equal(validateLabelDraft('option', { en: '', zh: '失败' }), 'both')
    assert.equal(validateLabelDraft('option', { en: 'x'.repeat(40), zh: '字'.repeat(24) }), null)
    assert.equal(validateLabelDraft('option', { en: 'x'.repeat(41), zh: '失败' }), 'tooLongEn')
    assert.equal(validateLabelDraft('option', { en: 'Failed', zh: '字'.repeat(25) }), 'tooLongZh')
    // an emoji is one code point, as on the server
    assert.equal(validateLabelDraft('option', { en: 'ok', zh: '😀'.repeat(24) }), null)
    assert.equal(validateLabelDraft('follow_up', { en: 'x'.repeat(200), zh: '字'.repeat(200) }), null)
    assert.equal(validateLabelDraft('follow_up', { en: 'x'.repeat(201), zh: '字' }), 'tooLongEn')
  })

  test('label body: trimmed, inner spaces collapsed, empty = no override (null)', () => {
    assert.deepEqual(labelBody({ en: '  Card   declined ', zh: ' 卡被拒 ' }), { labelEn: 'Card declined', labelZh: '卡被拒' })
    assert.deepEqual(labelBody({ en: ' ', zh: '' }), { labelEn: null, labelZh: null })
  })

  test('the label draft starts from the override, or empty when the child question is used', () => {
    assert.deepEqual(labelDraftOf({ labelEn: 'A', labelZh: '甲' }), { en: 'A', zh: '甲' })
    assert.deepEqual(labelDraftOf({ labelEn: null, labelZh: null }), { en: '', zh: '' })
  })

  test('phrasing: 1–200 code points after trimming', () => {
    assert.equal(validatePhrasing('   '), 'required')
    assert.equal(validatePhrasing('字'.repeat(200)), null)
    assert.equal(validatePhrasing(` ${'字'.repeat(201)} `), 'tooLong')
  })
})

/* ---------------------------------- 树视图 ---------------------------------- */

function treeNode(id: string, children: FaqTreeNode[] = [], patch: Partial<FaqTreeNode> = {}): FaqTreeNode {
  return {
    node: {
      id,
      key: id,
      type: 'answer',
      entry: false,
      category: 'payments_subscriptions',
      questionEn: `Q ${id}`,
      questionZh: `问 ${id}`,
      status: 'published',
    },
    edge: null,
    label: null,
    depth: 0,
    parentCount: 1,
    alsoAppearsIn: [],
    warnings: [],
    cycle: false,
    truncated: false,
    children,
    ...patch,
  }
}

describe('tree outline', () => {
  // a → b → d, a → c → d (d is shared and shows under both)
  const root = treeNode('a', [treeNode('b', [treeNode('d')], { depth: 1 }), treeNode('c', [treeNode('d')], { depth: 1 })])

  test('paths are unique per appearance, so a shared node can be expanded in one place only', () => {
    assert.deepEqual([...allPaths(root)].sort(), ['a', 'a/b', 'a/b/d', 'a/c', 'a/c/d'])
  })

  test('rows follow the expanded set; a collapsed node hides its whole branch', () => {
    const all = outlineRows(root, new Set(['a', 'a/b', 'a/c']))
    assert.deepEqual(
      all.map((row) => [row.path, row.level, row.hasChildren, row.expanded]),
      [
        ['a', 0, true, true],
        ['a/b', 1, true, true],
        ['a/b/d', 2, false, false],
        ['a/c', 1, true, true],
        ['a/c/d', 2, false, false],
      ],
    )
    assert.deepEqual(
      outlineRows(root, new Set(['a', 'a/c'])).map((row) => row.path),
      ['a', 'a/b', 'a/c', 'a/c/d'],
    )
    assert.deepEqual(outlineRows(root, new Set()).map((row) => row.path), ['a'])
    // the position among siblings gives the option letter
    assert.deepEqual(all.map((row) => row.index), [0, 0, 0, 1, 0])
  })

  test('opens with the entry and its children expanded', () => {
    assert.deepEqual([...initialExpanded(root)].sort(), ['a', 'a/b', 'a/c'])
  })
})

/* -------------------------------- 对话预览 -------------------------------- */

const PREVIEW: FaqGraphPreview = {
  source: 'working',
  published: null,
  locale: 'zh-CN',
  nodes: [
    { id: 'pay', key: 'pay', type: 'choice', entry: true, category: 'payments_subscriptions', popular: true, question: '付款有问题？', answer: '你遇到的是哪种情况？', blocks: [], signals: [] },
    { id: 'failed', key: 'failed', type: 'answer', entry: false, category: 'payments_subscriptions', popular: false, question: '付款失败怎么办', answer: '换一张卡再试。\n\n1. 打开账单\n2. 换卡', blocks: [{ id: 'b1', text: '换一张卡再试。' }, { id: 'b2', text: '1. 打开账单\n2. 换卡' }], signals: ['payment_failed'] },
    { id: 'refund', key: 'refund', type: 'answer', entry: true, category: 'payments_subscriptions', popular: false, question: '如何申请退款', answer: '在账单页申请。', blocks: [{ id: 'b1', text: '在账单页申请。' }], signals: [] },
    { id: 'contact', key: 'contact', type: 'answer', entry: true, category: 'other', popular: true, question: '如何联系客服', answer: '点击联系人工。', blocks: [{ id: 'b1', text: '点击联系人工。' }], signals: [] },
    ...['f1', 'f2', 'f3', 'f4'].map((id) => ({ id, key: id, type: 'answer' as const, entry: false, category: 'other' as const, popular: false, question: `追问 ${id}`, answer: `答 ${id}`, blocks: [{ id: 'b1', text: `答 ${id}` }], signals: [] })),
  ],
  edges: [
    { parentId: 'pay', childId: 'refund', kind: 'option', position: 1, label: '想退款' },
    { parentId: 'pay', childId: 'failed', kind: 'option', position: 0, label: '付款失败' },
    // failed has 6 follow-ups: one to a node not in the preview, then 5 real ones; 4 are shown
    { parentId: 'failed', childId: 'gone', kind: 'follow_up', position: 0, label: '已删除' },
    { parentId: 'failed', childId: 'contact', kind: 'follow_up', position: 1, label: '如何联系客服' },
    { parentId: 'failed', childId: 'f1', kind: 'follow_up', position: 2, label: '追问 f1' },
    { parentId: 'failed', childId: 'f2', kind: 'follow_up', position: 3, label: '追问 f2' },
    { parentId: 'failed', childId: 'f3', kind: 'follow_up', position: 4, label: '追问 f3' },
    { parentId: 'failed', childId: 'f4', kind: 'follow_up', position: 5, label: '追问 f4' },
  ],
}

describe('chat preview (as Portal renders a click)', () => {
  const graph = previewGraph(PREVIEW)

  test('a choice node: its prompt and the options in order, lettered A, B…; no opening or closing', () => {
    const turn = previewTurn(graph, 'pay', 'zh-CN')
    assert.equal(turn.kind, 'choice')
    if (turn.kind !== 'choice') return
    assert.equal(turn.prompt, '你遇到的是哪种情况？')
    assert.deepEqual(
      turn.steps.map((step) => [step.letter, step.label, step.nodeId]),
      [
        ['A', '付款失败', 'failed'],
        ['B', '想退款', 'refund'],
      ],
    )
  })

  test('an answer node: fixed opening, the whole answer verbatim with its source, fixed closing, then at most 4 follow-ups', () => {
    const turn = previewTurn(graph, 'failed', 'zh-CN')
    assert.equal(turn.kind, 'answer')
    if (turn.kind !== 'answer') return
    assert.equal(turn.opening, '好的，这个问题可以这样处理：')
    assert.equal(turn.closing, '还有不清楚的，接着问我就好。')
    assert.equal(turn.question, '付款失败怎么办')
    assert.equal(turn.answer, '换一张卡再试。\n\n1. 打开账单\n2. 换卡')
    // the edge to a node that is not in the preview is skipped, as Portal does
    assert.deepEqual(
      turn.steps.map((step) => step.nodeId),
      ['contact', 'f1', 'f2', 'f3'],
    )
    assert.equal(turn.hiddenSteps, 1)
  })

  test('English uses the English templates (the same strings as Portal and the Admin guard)', () => {
    assert.deepEqual(CLICK_TEMPLATES['en-GB'], { opening: "Here's how to sort this out:", closing: "If anything's unclear, just ask." })
    const turn = previewTurn(graph, 'refund', 'en-GB')
    assert.equal(turn.kind === 'answer' && turn.opening, "Here's how to sort this out:")
    assert.equal(turn.kind === 'answer' && turn.steps.length, 0)
  })

  test('a node that is not in the preview (archived, or not saved yet) is reported, not guessed', () => {
    assert.deepEqual(previewTurn(graph, 'gone', 'zh-CN'), { kind: 'missing', nodeId: 'gone' })
  })

  test('start points: entry nodes, popular first, then by key', () => {
    assert.deepEqual(
      previewStarts(PREVIEW).map((node) => node.id),
      ['contact', 'pay', 'refund'],
    )
  })
})

/* ---------------------------------- 发布页 ---------------------------------- */

function release(version: number, patch: Partial<FaqRelease> = {}): FaqRelease {
  return {
    id: `r${version}`,
    version,
    status: 'draft',
    checks: null,
    evalReport: null,
    sourceVersion: null,
    createdBy: null,
    createdAt: '2026-10-29T10:00:00Z',
    publishedBy: null,
    publishedAt: null,
    publishable: false,
    ...patch,
  }
}

describe('release actions', () => {
  test('publish only a publishable draft; re-check draft / rejected / evaluating that are not rollbacks', () => {
    assert.deepEqual(releaseActions(release(3, { publishable: true }), null), { publish: true, recheck: true, rollback: false })
    assert.deepEqual(releaseActions(release(3, { status: 'rejected' }), 2), { publish: false, recheck: true, rollback: false })
    assert.deepEqual(releaseActions(release(3, { status: 'evaluating' }), 2), { publish: false, recheck: true, rollback: false })
    assert.deepEqual(releaseActions(release(3, { status: 'rejected', sourceVersion: 1 }), 2), { publish: false, recheck: false, rollback: false })
  })

  test('a check running in the background cannot be started again; an interrupted one can (owner 2026-11-03)', () => {
    const running = release(3, { status: 'evaluating', evaluation: { state: 'running', startedAt: null, progress: { stage: 'model', done: 120, total: 300 } } })
    const stopped = release(4, { status: 'evaluating', evaluation: { state: 'interrupted', startedAt: null, progress: null } })
    assert.equal(releaseActions(running, 2).recheck, false)
    assert.equal(releaseActions(stopped, 2).recheck, true)
    assert.equal(releaseStatusKey(running), 'evaluating')
    assert.equal(releaseStatusKey(stopped), 'interrupted')
    for (const messages of [enGB, zhCN]) {
      const releases = (messages as unknown as { helpDesk: { releases: Record<string, unknown> } }).helpDesk.releases
      assert.equal(typeof (releases.status as Record<string, string>).interrupted, 'string')
      assert.equal(typeof (releases.progress as Record<string, string>).model, 'string')
    }
    assert.equal(zhCN.helpDesk.releases.create, '生成新版本', 'the button only creates a version (en: Create new version)')
    assert.doesNotMatch(JSON.stringify(zhCN.helpDesk.releases), /学员/)
  })

  test('the live-pipeline check report is found inside a combined report', () => {
    const model = { kind: 'model', passed: true, summary: 'ok', ranAt: '', metrics: { wrongRate: 0.006, cases: 312, costUsd: 0.13 }, misses: [] }
    const combined = { kind: 'combined', passed: true, summary: '', ranAt: '', metrics: { recallAt8: 0.97 }, misses: [], parts: [{ ...model, kind: 'retrieval' }, model] }
    assert.equal(modelReport(combined), model)
    assert.equal(modelReport(model), model)
    assert.equal(modelReport({ ...model, kind: 'retrieval' }), null)
    assert.equal(modelReport(null), null)
  })

  test('roll back to a release that was live before, unless what is live now is that one or a copy of it', () => {
    const live = release(4, { status: 'published', sourceVersion: 1 })
    assert.deepEqual(releaseActions(release(2, { status: 'superseded' }), 4, live), { publish: false, recheck: false, rollback: true })
    assert.deepEqual(releaseActions(release(1, { status: 'superseded' }), 4, live), { publish: false, recheck: false, rollback: false })
    assert.deepEqual(releaseActions(live, 4, live), { publish: false, recheck: false, rollback: false })
  })

  test('diff total and the recall@8 of a report', () => {
    const diff: FaqSnapshotDiff = {
      nodes: { added: [{ id: 'a', key: 'a', questionEn: 'A', questionZh: '甲' }], removed: [], changed: [] },
      edges: { added: [], removed: [], changed: [] },
      phrasings: { added: 2, removed: 1 },
      same: false,
    }
    assert.equal(diffTotal(diff), 4)
    assert.equal(evalRecall({ kind: 'retrieval', passed: true, summary: '', ranAt: '', metrics: { recallAt8: 0.9871 }, misses: [] }), 0.9871)
    assert.equal(evalRecall(null), null)
    assert.equal(evalRecall({ kind: 'skipped', passed: false, summary: '', ranAt: '', metrics: {}, misses: [] }), null)
  })
})

describe('copy for every rule and status (en-GB and zh-CN)', () => {
  const get = (source: unknown, path: string) =>
    path.split('.').reduce<unknown>((cursor, part) => (cursor as Record<string, unknown> | undefined)?.[part], source)

  test('each graph check rule and release status has a label in both languages', () => {
    for (const messages of [enGB, zhCN]) {
      for (const rule of GRAPH_RULES) assert.ok(get(messages, `helpDesk.graph.rules.${rule}`), `rule ${rule}`)
      for (const status of FAQ_RELEASE_STATUSES) assert.ok(get(messages, `helpDesk.releases.status.${status}`), `status ${status}`)
    }
  })

  test('the zh-CN section title is the spec wording 追问与选项; creating a version is 生成新版本', () => {
    assert.equal(get(zhCN, 'helpDesk.graph.title'), '追问与选项')
    assert.equal(get(zhCN, 'helpDesk.graph.addExisting'), '添加已有问题')
    assert.equal(get(zhCN, 'helpDesk.graph.addNew'), '新建追问')
    assert.equal(get(zhCN, 'helpDesk.tree.alsoIn'), '也出现在 {count} 处')
    assert.equal(get(zhCN, 'helpDesk.chatPreview.title'), '对话预览')
    assert.equal(get(zhCN, 'helpDesk.releases.create'), '生成新版本')
    assert.equal(get(zhCN, 'helpDesk.releases.rollback'), '回滚到此版本')
  })
})
