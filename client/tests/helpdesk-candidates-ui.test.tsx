import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'

import type {
  CandidateRevision,
  EnquiryDetail,
  FaqCandidate,
  FaqCandidateDraft,
  FaqNodeSummary,
  FlywheelJobRun,
  PortalJobRun,
} from '../src/backoffice/contracts/helpdesk'
import {
  absent,
  candidate,
  deferred,
  detail,
  faq,
  installFakeServer,
  type Call,
  type FakeServer,
  type Reply,
} from './support/helpdesk-fake'
import { location, renderHelpDesk } from './support/helpdesk-render'

/**
 * v5 Part G4「FAQ 候选」（待视觉验收）：队列（条数多的在前，按状态 / 建议 / 来源筛选）、详情（脱敏例句、
 * 原因构成、相关 / 上一级节点、审计记录）、动作（新 FAQ → 预填的 FAQ 编辑器、加问法、加成追问、驳回）、
 * 「立即运行」缺口挖掘与 Portal 的保留任务，以及工单里的「转成 FAQ 候选」。
 * 走真实路由与 RBAC（FULL = ADMIN，VIEW = COURSE_CREATOR），fetch 换成假的 BackOffice Server。
 */

const LIST = '/api/helpdesk/faq-candidates'
const ONE = /^\/api\/helpdesk\/faq-candidates\/[^/]+$/
const DRAFT = /^\/api\/helpdesk\/faq-candidates\/[^/]+\/draft$/
const ACCEPT = /^\/api\/helpdesk\/faq-candidates\/[^/]+\/accept$/
const DISMISS = /^\/api\/helpdesk\/faq-candidates\/[^/]+\/dismiss$/
const MINING_RUNS = '/api/helpdesk/flywheel/jobs/gap_mining/runs'
const MINING_RUN = /^\/api\/helpdesk\/flywheel\/jobs\/gap_mining\/runs\/[^/]+$/
const MINING_NOW = '/api/helpdesk/flywheel/jobs/gap_mining/run'
const RETENTION = '/api/helpdesk/jobs/assist-retention'
const RETENTION_NOW = '/api/helpdesk/jobs/assist-retention/run'
const FAQS = '/api/helpdesk/faqs'

const REFUND = '11111111-1111-4111-8111-111111111111'
const PARENT = '22222222-2222-4222-8222-222222222222'
const NEW_FAQ = '33333333-3333-4333-8333-333333333333'

let server: FakeServer
let rows: FaqCandidate[]

function node(id: string, patch: Partial<FaqNodeSummary> = {}): FaqNodeSummary {
  return {
    id,
    key: `key-${id.slice(0, 4)}`,
    type: 'answer',
    entry: true,
    category: 'payments_subscriptions',
    questionEn: `Node ${id.slice(0, 4)}?`,
    questionZh: `节点 ${id.slice(0, 4)}？`,
    status: 'published',
    ...patch,
  }
}

const NODES = [
  node(REFUND, { questionEn: 'How do I get a refund?', questionZh: '怎么退款？' }),
  node(PARENT, { questionEn: 'My payment failed', questionZh: '付款失败' }),
]

const refundGroup = candidate('c1', {
  topic: 'Refund timing',
  proposedQuestion: 'How long does a refund take?',
  turnCount: 7,
  suggestion: 'add_phrasing',
  relatedNodeId: REFUND,
  relatedScore: 0.62,
  sourceMix: { no_match: 5, handover: 2 },
  examples: [
    { turnId: 't1', text: 'how long for my refund', locale: 'en-GB', reasons: ['no_match'] },
    { turnId: 't2', text: 'refund to <email> when', locale: 'en-GB', reasons: ['handover'] },
    { turnId: 't3', text: '退款要多久', locale: 'zh-CN', reasons: ['no_match'] },
  ],
})

const cardGroup = candidate('c2', {
  topic: 'Card declined twice',
  proposedQuestion: 'Why was my card declined?',
  turnCount: 3,
  suggestion: 'follow_up',
  parentNodeId: PARENT,
  sourceMix: { not_helpful: 3 },
  examples: [{ turnId: 't9', text: 'card declined again', locale: 'en-GB', reasons: ['not_helpful'] }],
})

const revisions: CandidateRevision[] = [
  { id: 'r1', candidateId: 'c1', action: 'create', before: null, after: null, employeeId: null, at: '2026-10-20T18:05:00Z' },
  { id: 'r2', candidateId: 'c1', action: 'grow', before: null, after: null, employeeId: null, at: '2026-10-27T18:05:00Z' },
]

function miningRun(patch: Partial<FlywheelJobRun> = {}): FlywheelJobRun {
  return {
    id: 'run-1',
    job: 'gap_mining',
    day: '2026-10-28',
    trigger: 'schedule',
    status: 'succeeded',
    attempts: 1,
    instance: 'i-1',
    startedAt: '2026-10-28T18:02:00Z',
    heartbeatAt: '2026-10-28T18:03:00Z',
    finishedAt: '2026-10-28T18:03:00Z',
    durationMs: 60_000,
    stats: { pull: { status: 'pulled', received: 120 }, mine: { created: 2, grown: 1 } },
    moreDue: false,
    errorCode: null,
    requestedBy: null,
    ...patch,
  }
}

function retentionRun(patch: Partial<PortalJobRun> = {}): PortalJobRun {
  return {
    id: 'p-1',
    job: 'assist_retention',
    day: '2026-10-28',
    trigger: 'schedule',
    status: 'succeeded',
    attempts: 1,
    startedAt: '2026-10-28T03:00:00Z',
    finishedAt: '2026-10-28T03:00:05Z',
    cutoff: '2026-05-01T03:00:00Z',
    rowsScrubbed: 42,
    moreDue: false,
    requestedBy: null,
    errorCode: null,
    ...patch,
  }
}

function serve(...items: FaqCandidate[]) {
  rows = items
  server.on('GET', LIST, (call) => {
    const status = call.query.get('status')
    const shown = rows.filter((row) => !status || row.status === status)
    return {
      data: {
        candidates: shown,
        total: shown.length,
        counts: { new: rows.filter((r) => r.status === 'new').length, accepted: 4, dismissed: 1, merged: 0 },
        page: Number(call.query.get('page') ?? 1),
        pageSize: 20,
        nodes: NODES,
      },
    }
  })
  server.on('GET', ONE, (call) => {
    const found = rows.find((row) => row.id === call.path.split('/')[4])
    return found ? { data: { candidate: found, revisions, nodes: NODES } } : { status: 404, error: 'CANDIDATE_NOT_FOUND' }
  })
  server.on('GET', MINING_RUNS, { data: { runs: [miningRun()] } })
  server.on('GET', RETENTION, { data: { job: 'assist_retention', retentionDays: 180, runs: [retentionRun()] } })
  server.on('GET', FAQS, { data: { faqs: [], total: 0, page: 1, pageSize: 10 } })
  server.on('GET', '/api/helpdesk/tickets', { data: { tickets: [], nextCursor: null, counts: {} } })
}

/** 决定成功：内存里的候选换成新状态并返回。 */
function decide(patch: Partial<FaqCandidate>, extra: Record<string, unknown> = {}): (call: Call) => Reply {
  return (call) => {
    const id = call.path.split('/')[4]
    const index = rows.findIndex((row) => row.id === id)
    const next = { ...rows[index], ...patch, version: rows[index].version + 1 }
    rows = rows.map((row, at) => (at === index ? next : row))
    return { data: { candidate: next, replayed: false, ...extra } }
  }
}

async function openQueue(options: { role?: 'ADMIN' | 'COURSE_CREATOR'; locale?: 'en-GB' | 'zh-CN'; query?: string } = {}) {
  await renderHelpDesk(server, {
    role: options.role,
    path: `/${options.locale ?? 'en-GB'}/help-desk?tab=candidates${options.query ?? ''}`,
  })
  await waitFor(() => assert.ok(server.callsTo('GET', LIST).length >= 1))
}

function lastListQuery(): Record<string, string> {
  return Object.fromEntries((server.callsTo('GET', LIST).at(-1) as Call).query)
}

function tableRow(text: string): HTMLElement {
  const element = screen.getByText(text).closest('tr')
  assert.ok(element, `row containing ${text}`)
  return element as HTMLElement
}

async function openCandidate(topic: string): Promise<HTMLElement> {
  const rowElement = await waitFor(() => tableRow(topic))
  fireEvent.click(within(rowElement).getByRole('button', { name: `Review ${topic}` }))
  return screen.findByRole('dialog', { name: 'FAQ candidate' })
}

beforeEach(() => {
  server = installFakeServer()
})

afterEach(() => {
  cleanup()
  server.restore()
})

describe('FAQ candidates queue (G4)', () => {
  test('five tabs; the queue is sorted by count with the source mix, suggestion and status counts', async () => {
    serve(refundGroup, cardGroup)
    await openQueue()
    assert.deepEqual(
      screen.getAllByRole('tab').map((tab) => [tab.textContent, tab.getAttribute('aria-selected')]),
      [
        ['Enquiries', 'false'],
        ['FAQs', 'false'],
        ['FAQ candidates', 'true'],
        ['HelpDesk data', 'false'],
        ['Change Log', 'false'],
      ],
    )
    assert.deepEqual(lastListQuery(), { status: 'new', page: '1', pageSize: '20' })
    const first = await waitFor(() => tableRow('Refund timing'))
    assert.deepEqual(
      within(first.closest('table') as HTMLElement)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
      ['Topic / proposed question', 'Suggestion', 'Why the AI missed', 'Count', 'Last seen', 'Action'],
    )
    assert.ok(within(first).getByText('How long does a refund take?'))
    assert.ok(within(first).getByText('Add phrasing'))
    assert.ok(within(first).getByText('No match 5'))
    assert.ok(within(first).getByText('Asked for a person 2'))
    assert.ok(within(first).getByText('7'))
    assert.ok(within(first).getByText('28 Oct 2026'))
    const rowsInOrder = screen.getAllByRole('button', { name: /^Review / }).map((b) => b.getAttribute('aria-label'))
    assert.deepEqual(rowsInOrder, ['Review Refund timing', 'Review Card declined twice'])
    assert.ok(screen.getByText('2 new · 4 accepted · 1 dismissed · 0 merged'))
  })

  test('filters by status, suggestion, source and text live in the address bar', async () => {
    serve(refundGroup)
    await openQueue()
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'all' } })
    await waitFor(() => assert.deepEqual(lastListQuery(), { page: '1', pageSize: '20' }))
    assert.match(location.current, /status=all/)
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'ticket' } })
    await waitFor(() => assert.equal(lastListQuery().origin, 'ticket'))
    fireEvent.change(screen.getByLabelText('Suggestion'), { target: { value: 'follow_up' } })
    await waitFor(() => assert.equal(lastListQuery().suggestion, 'follow_up'))
    fireEvent.change(screen.getByLabelText('Search topics, questions or examples...'), { target: { value: 'refund' } })
    await waitFor(() => assert.equal(lastListQuery().q, 'refund'))
    assert.match(location.current, /tab=candidates/)
  })

  test('empty queue and a load error', async () => {
    serve()
    await openQueue()
    assert.ok(await screen.findByText('No open candidates. The nightly mining adds new ones.'))
    server.on('GET', LIST, { status: 503, error: 'HELPDESK_UNAVAILABLE' })
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'all' } })
    assert.equal((await screen.findByRole('alert')).textContent, 'HelpDesk is unavailable right now. Please try again.')
  })

  test('zh-CN copy: FAQ 候选 tab, columns and the source mix', async () => {
    serve(refundGroup)
    await openQueue({ locale: 'zh-CN' })
    assert.equal(screen.getByRole('tab', { name: 'FAQ 候选' }).getAttribute('aria-selected'), 'true')
    assert.ok(screen.getByRole('tab', { name: 'HelpDesk 数据' }))
    const first = await waitFor(() => tableRow('Refund timing'))
    assert.ok(within(first).getByText('没有匹配 5'))
    assert.ok(within(first).getByText('加问法'))
    assert.ok(within(first).getByRole('button', { name: '查看 Refund timing' }))
  })
})

describe('queue paging', () => {
  test('a page past the end (the queue shrank, or a stale link) goes back to the last page instead of an empty table', async () => {
    const many = Array.from({ length: 21 }, (_, i) => candidate(`p${i}`, { topic: `Topic ${i}`, turnCount: 30 - i }))
    rows = many
    server.on('GET', LIST, (call) => {
      const page = Number(call.query.get('page') ?? 1)
      const open = rows.filter((row) => row.status === 'new')
      return {
        data: {
          candidates: open.slice((page - 1) * 20, page * 20),
          total: open.length,
          counts: { new: open.length, accepted: 0, dismissed: 0, merged: 0 },
          page,
          pageSize: 20,
          nodes: NODES,
        },
      }
    })
    server.on('GET', MINING_RUNS, { data: { runs: [] } })
    server.on('GET', RETENTION, { data: { job: 'assist_retention', retentionDays: 180, runs: [] } })
    server.on('GET', '/api/helpdesk/tickets', { data: { tickets: [], nextCursor: null, counts: {} } })
    server.on('GET', ONE, (call) => {
      const found = rows.find((row) => row.id === call.path.split('/')[4])
      return found ? { data: { candidate: found, revisions, nodes: NODES } } : { status: 404, error: 'CANDIDATE_NOT_FOUND' }
    })
    server.on('POST', DISMISS, decide({ status: 'dismissed', reason: 'spam' }))
    await openQueue({ query: '&page=2' })
    assert.ok(await screen.findByText('Topic 20'))
    // 第 2 页唯一的一个处理掉了：队列只剩 20 个，第 2 页空了 → 回到第 1 页
    const dialog = await openCandidate('Topic 20')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Dismiss' }))
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), { target: { value: 'spam' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss candidate' }))
    await within(dialog).findByRole('status')
    await waitFor(() => assert.equal(lastListQuery().page, '1'))
    assert.ok(await screen.findByText('Topic 0'))
    absent(screen.queryByText('No open candidates. The nightly mining adds new ones.'))
  })
})

describe('candidate detail', () => {
  test('the history names the staff member; a merged candidate links to the one it went into', async () => {
    const merged = candidate('c7', { topic: 'Refund again', status: 'merged', mergedInto: 'c1', decidedAt: '2026-10-29T09:00:00Z', decidedBy: 'e1' })
    serve(refundGroup, merged)
    server.on('GET', ONE, (call) => {
      const id = call.path.split('/')[4]
      const found = rows.find((row) => row.id === id)
      const history: CandidateRevision[] = [
        { id: 'r1', candidateId: id, action: 'create', before: null, after: null, employeeId: null, employeeName: null, at: '2026-10-20T18:05:00Z' },
        { id: 'r2', candidateId: id, action: 'merge', before: null, after: null, employeeId: '0192abcd-0000-7000-8000-000000000001', employeeName: 'Mei Staff', at: '2026-10-29T09:00:00Z' },
        { id: 'r3', candidateId: id, action: 'grow', before: null, after: null, employeeId: '0192abcd-0000-7000-8000-000000000002', at: '2026-10-29T10:00:00Z' },
      ]
      return found ? { data: { candidate: found, revisions: history, nodes: NODES } } : { status: 404, error: 'CANDIDATE_NOT_FOUND' }
    })
    await openQueue({ query: '&status=all&candidate=c7' })
    const dialog = await screen.findByRole('dialog', { name: 'FAQ candidate' })
    await waitFor(() => assert.ok(within(dialog).getByRole('heading', { name: 'Refund again' })))
    const history = within(dialog).getByRole('list', { name: 'History' })
    const items = within(history).getAllByRole('listitem').map((li) => li.textContent ?? '')
    assert.match(items[1], /by Mei Staff/)
    assert.match(items[2], /by staff 0192abcd/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open the candidate it was merged into' }))
    await waitFor(() => assert.match(location.current, /candidate=c1/))
    assert.ok(await screen.findByRole('heading', { name: 'Refund timing' }))
  })

  test('Escape while a decision is being sent does not close the drawer, so its result is still shown', async () => {
    serve(refundGroup)
    const pending = deferred<Reply>()
    server.on('POST', DISMISS, () => pending.promise)
    await openQueue()
    const dialog = await openCandidate('Refund timing')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss' }))
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), { target: { value: 'spam' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss candidate' }))
    await waitFor(() => assert.equal(server.callsTo('POST', DISMISS).length, 1))
    fireEvent.keyDown(document, { key: 'Escape' })
    assert.ok(screen.getByRole('dialog', { name: 'FAQ candidate' }))
    pending.resolve(decide({ status: 'dismissed', reason: 'spam' })(server.callsTo('POST', DISMISS)[0]))
    assert.equal((await within(dialog).findByRole('status')).textContent, 'Candidate dismissed.')
  })

  test('Escape while the draft for a new FAQ is loading keeps the drawer, and the editor does not open on its own later', async () => {
    serve(refundGroup)
    const pending = deferred<Reply>()
    server.on('GET', DRAFT, () => pending.promise)
    await openQueue()
    const dialog = await openCandidate('Refund timing')
    fireEvent.click(within(dialog).getByRole('button', { name: 'New FAQ' }))
    await waitFor(() => assert.equal(server.callsTo('GET', DRAFT).length, 1))
    fireEvent.keyDown(document, { key: 'Escape' })
    assert.ok(screen.getByRole('dialog', { name: 'FAQ candidate' }))
  })

  test('scrubbed examples (hidden details marked), source mix, the closest FAQ and the audit history', async () => {
    serve(refundGroup)
    await openQueue()
    const dialog = await openCandidate('Refund timing')
    assert.ok(within(dialog).getByRole('heading', { name: 'Refund timing' }))
    assert.ok(within(dialog).getByText('How long does a refund take?'))
    assert.ok(within(dialog).getByText('7 learner questions'))
    // 例句：可勾选成问法；含隐藏信息的不能勾
    const clean = within(dialog).getByRole('checkbox', { name: 'how long for my refund' }) as HTMLInputElement
    assert.equal(clean.checked, true)
    const hidden = within(dialog).getByRole('checkbox', { name: /refund to <email> when/ }) as HTMLInputElement
    assert.equal(hidden.checked, false)
    assert.equal(hidden.disabled, true)
    assert.ok(within(dialog).getAllByText('hidden personal detail').length >= 1)
    assert.ok(within(dialog).getByText('Closest FAQ'))
    assert.ok(within(dialog).getByText('How do I get a refund?'))
    assert.ok(within(dialog).getByText('similarity 0.62'))
    const history = within(dialog).getByRole('list', { name: 'History' })
    assert.deepEqual(
      within(history)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
      ['Created by the nightly job · 20 Oct 2026 18:05', 'More questions added by the nightly job · 27 Oct 2026 18:05'],
    )
  })

  test('a deep link (?candidate=) opens the detail; Escape closes it and clears the link', async () => {
    serve(refundGroup)
    await openQueue({ query: '&candidate=c1' })
    const dialog = await screen.findByRole('dialog', { name: 'FAQ candidate' })
    assert.ok(within(dialog).getByRole('heading', { name: 'Refund timing' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => absent(screen.queryByRole('dialog')))
    assert.doesNotMatch(location.current, /candidate=/)
  })

  test('VIEW sees the queue and the detail but no actions and no run now', async () => {
    serve(refundGroup)
    await openQueue({ role: 'COURSE_CREATOR' })
    await waitFor(() => tableRow('Refund timing'))
    absent(screen.queryByRole('button', { name: /^Run .* now$/ }))
    const dialog = await openCandidate('Refund timing')
    for (const name of ['New FAQ', 'Add phrasing', 'Add as follow-up', 'Dismiss'])
      absent(within(dialog).queryByRole('button', { name }), name)
    absent(within(dialog).queryByRole('checkbox'))
  })

  test('a decided candidate shows the decision and has no actions', async () => {
    serve(
      candidate('c3', {
        topic: 'Spam group',
        status: 'dismissed',
        reason: 'spam',
        reasonNote: 'bot traffic',
        decidedBy: 'emp-9',
        decidedAt: '2026-10-29T09:00:00Z',
      }),
    )
    await openQueue({ query: '&status=dismissed' })
    const dialog = await openCandidate('Spam group')
    assert.ok(within(dialog).getByText('Dismissed: Spam · 29 Oct 2026 09:00'))
    assert.ok(within(dialog).getByText('bot traffic'))
    absent(within(dialog).queryByRole('button', { name: 'Dismiss' }))
  })
})

describe('candidate actions (FULL)', () => {
  test('add phrasing: the ticked examples go to the closest FAQ, with the version and an Idempotency-Key', async () => {
    serve(refundGroup)
    server.on('POST', ACCEPT, decide({ status: 'accepted', acceptedAs: 'add_phrasing', acceptedFaqId: REFUND }, { phrasingsAdded: 1, phrasingsSkipped: 0, evalCasesAdded: 1, heldOut: 1, edgeId: null }))
    await openQueue()
    const dialog = await openCandidate('Refund timing')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add phrasing' }))
    const target = within(dialog).getByRole('radio', { name: 'How do I get a refund?' }) as HTMLInputElement
    assert.equal(target.checked, true)
    // 勾了 2 句：一句加成问法、一句只当发布检查题（服务端 splitForEval），按钮照实写 1 条
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 1 phrasing' }))
    await waitFor(() => assert.equal(server.callsTo('POST', ACCEPT).length, 1))
    const call = server.callsTo('POST', ACCEPT)[0]
    assert.equal(call.path, '/api/helpdesk/faq-candidates/c1/accept')
    assert.deepEqual(call.body, { as: 'add_phrasing', faqId: REFUND, phrasings: [0, 2], version: 1 })
    assert.match(call.idempotencyKey ?? '', /^[0-9a-f-]{36}$/)
    assert.equal((await within(dialog).findByRole('status')).textContent, 'Added 1 phrasing (0 skipped). 1 more kept only as release-check questions, not as phrasings.')
    // 列表刷新：接受了的候选离开待处理队列
    await waitFor(() => absent(document.querySelector('.hdFaqTable tbody tr td button[aria-label="Review Refund timing"]')))
  })

  test('a failed decision retried as is keeps its Idempotency-Key; a stale version reloads the candidate', async () => {
    serve(refundGroup)
    server.on('POST', ACCEPT, { status: 500, error: 'HELPDESK_UNAVAILABLE' })
    await openQueue()
    const dialog = await openCandidate('Refund timing')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add phrasing' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '退款要多久' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 1 phrasing' }))
    assert.equal((await within(dialog).findByRole('alert')).textContent, 'HelpDesk is unavailable right now. Please try again.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 1 phrasing' }))
    await waitFor(() => assert.equal(server.callsTo('POST', ACCEPT).length, 2))
    const [first, second] = server.callsTo('POST', ACCEPT)
    assert.equal(second.idempotencyKey, first.idempotencyKey)
    assert.deepEqual(second.body, { as: 'add_phrasing', faqId: REFUND, phrasings: [0], version: 1 })
    const reads = server.callsTo('GET', ONE).length
    server.on('POST', ACCEPT, { status: 409, error: 'CANDIDATE_CHANGED' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 1 phrasing' }))
    assert.equal(
      (await within(dialog).findByText(/Someone else changed this candidate/)).textContent,
      'Someone else changed this candidate. It has been reloaded; check it and try again.',
    )
    await waitFor(() => assert.ok(server.callsTo('GET', ONE).length > reads))
  })

  test('add phrasing to another FAQ found by search; nothing ticked is refused before sending', async () => {
    serve(refundGroup)
    server.on('GET', FAQS, (call) => ({
      data: {
        faqs: call.query.get('q') === 'subscription' ? [faq(NEW_FAQ, { questionEn: 'Cancel my subscription' })] : [],
        total: 1,
        page: 1,
        pageSize: 10,
      },
    }))
    server.on('POST', ACCEPT, decide({ status: 'accepted' }, { phrasingsAdded: 1, phrasingsSkipped: 1, evalCasesAdded: 3, edgeId: null }))
    await openQueue()
    const dialog = await openCandidate('Refund timing')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add phrasing' }))
    fireEvent.change(within(dialog).getByLabelText('Search FAQs'), { target: { value: 'subscription' } })
    fireEvent.click(await within(dialog).findByRole('radio', { name: 'Cancel my subscription' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'how long for my refund' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '退款要多久' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 0 phrasings' }))
    assert.ok(within(dialog).getByText('Tick at least one example.'))
    assert.equal(server.callsTo('POST', ACCEPT).length, 0)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '退款要多久' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 1 phrasing' }))
    await waitFor(() => assert.equal(server.callsTo('POST', ACCEPT).length, 1))
    assert.deepEqual(server.callsTo('POST', ACCEPT)[0].body, { as: 'add_phrasing', faqId: NEW_FAQ, phrasings: [2], version: 1 })
    assert.equal((await within(dialog).findByRole('status')).textContent, 'Added 1 phrasing (1 skipped).')
  })

  test('dismiss needs a reason; "Other" needs a note', async () => {
    serve(refundGroup)
    server.on('POST', DISMISS, decide({ status: 'dismissed', reason: 'other', reasonNote: 'covered by the help centre' }))
    await openQueue()
    const dialog = await openCandidate('Refund timing')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss' }))
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), { target: { value: 'other' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss candidate' }))
    assert.ok(within(dialog).getByText('Say why in the note.'))
    assert.equal((within(dialog).getByLabelText(/^Note/) as HTMLTextAreaElement).getAttribute('aria-invalid'), 'true')
    assert.equal(server.callsTo('POST', DISMISS).length, 0)
    fireEvent.change(within(dialog).getByLabelText(/^Note/), { target: { value: '  covered by the help centre ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss candidate' }))
    await waitFor(() => assert.equal(server.callsTo('POST', DISMISS).length, 1))
    const call = server.callsTo('POST', DISMISS)[0]
    assert.deepEqual(call.body, { reason: 'other', note: 'covered by the help centre', version: 1 })
    assert.ok(call.idempotencyKey)
    assert.equal((await within(dialog).findByRole('status')).textContent, 'Candidate dismissed.')
  })

  test('new FAQ: the editor opens prefilled (answer empty), the 草稿 待核实 panel drafts from a human reply, save then accept', async () => {
    const withDraft = { ...refundGroup, suggestion: 'new_faq' as const, relatedNodeId: null, answerSources: ['Refunds take 5 to 10 working days.'] }
    serve(withDraft)
    const draft: FaqCandidateDraft = {
      candidateId: 'c1',
      version: 1,
      suggestion: 'new_faq',
      faq: {
        type: 'answer',
        entry: true,
        category: 'payments_subscriptions',
        questionEn: 'How long does a refund take?',
        questionZh: '退款要多久',
        answerEn: '',
        answerZh: '',
        keywords: [],
      },
      parentId: null,
      relatedNodeId: null,
      phrasings: [{ index: 0, locale: 'en-GB', text: 'how long for my refund' }],
      answerDraft: { label: { en: 'Draft, to be verified', zh: '草稿 待核实' }, sources: ['Refunds take 5 to 10 working days.'] },
    }
    server.on('GET', DRAFT, { data: draft })
    server.on('POST', FAQS, (call) => ({ status: 201, data: faq(NEW_FAQ, call.body as object) }))
    server.on('POST', ACCEPT, decide({ status: 'accepted', acceptedAs: 'new_faq', acceptedFaqId: NEW_FAQ }, { phrasingsAdded: 2, phrasingsSkipped: 0, evalCasesAdded: 3, edgeId: null }))
    await openQueue()
    const candidateDialog = await openCandidate('Refund timing')
    fireEvent.click(within(candidateDialog).getByRole('button', { name: 'New FAQ' }))
    const editor = await screen.findByRole('dialog', { name: 'Add FAQ' })
    assert.ok(within(editor).getByText('From FAQ candidate: Refund timing. Write the answer yourself; the ticked examples become phrasings when you save.'))
    assert.equal((within(editor).getByLabelText(/^Question \(English\)/) as HTMLInputElement).value, 'How long does a refund take?')
    assert.equal((within(editor).getByLabelText(/^Question \(Chinese\)/) as HTMLInputElement).value, '退款要多久')
    assert.equal((within(editor).getByLabelText(/^Answer \(English\)/) as HTMLTextAreaElement).value, '')
    assert.equal((within(editor).getByLabelText(/^Category/) as HTMLSelectElement).value, 'payments_subscriptions')
    const panel = within(editor).getByRole('region', { name: 'Draft, to be verified' })
    assert.ok(within(panel).getByText('Refunds take 5 to 10 working days.'))
    fireEvent.click(within(panel).getByRole('button', { name: 'Draft the English answer from reply 1' }))
    assert.equal((within(editor).getByLabelText(/^Answer \(English\)/) as HTMLTextAreaElement).value, 'Refunds take 5 to 10 working days.')
    assert.ok(within(editor).getByText('Draft, to be verified: check every fact before you save. Saving publishes the FAQ.'))
    fireEvent.change(within(editor).getByLabelText(/^Answer \(Chinese\)/), { target: { value: '退款一般 5 到 10 个工作日。' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Save FAQ' }))
    await waitFor(() => assert.equal(server.callsTo('POST', ACCEPT).length, 1))
    const saved = server.callsTo('POST', FAQS)[0].body as Record<string, unknown>
    assert.equal(saved.questionEn, 'How long does a refund take?')
    assert.equal(saved.entry, true)
    const accept = server.callsTo('POST', ACCEPT)[0]
    assert.deepEqual(accept.body, { as: 'new_faq', faqId: NEW_FAQ, phrasings: [0, 2], version: 1 })
    assert.ok(accept.idempotencyKey)
    assert.ok(await screen.findByText('FAQ saved and the candidate accepted.'))
  })

  test('add as follow-up: under the parent the learners were on; the new card is not an entry and the edge is made on accept', async () => {
    serve(cardGroup)
    server.on('GET', DRAFT, {
      data: {
        candidateId: 'c2',
        version: 1,
        suggestion: 'follow_up',
        faq: {
          type: 'answer',
          entry: false,
          category: 'payments_subscriptions',
          questionEn: 'Why was my card declined?',
          questionZh: '',
          answerEn: '',
          answerZh: '',
          keywords: [],
        },
        parentId: PARENT,
        relatedNodeId: null,
        phrasings: [],
        answerDraft: null,
      } satisfies FaqCandidateDraft,
    })
    server.on('POST', FAQS, (call) => ({ status: 201, data: faq(NEW_FAQ, call.body as object) }))
    server.on('POST', ACCEPT, decide({ status: 'accepted', acceptedAs: 'follow_up' }, { phrasingsAdded: 1, phrasingsSkipped: 0, evalCasesAdded: 1, edgeId: 'e1' }))
    await openQueue()
    const dialog = await openCandidate('Card declined twice')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add as follow-up' }))
    const parent = within(dialog).getByRole('radio', { name: 'My payment failed' }) as HTMLInputElement
    assert.equal(parent.checked, true)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Write the follow-up' }))
    const editor = await screen.findByRole('dialog', { name: 'Add FAQ' })
    // 卡片类型 / 入口在「Follow-ups & phrasings」页签（Figma 草案 2.9）
    fireEvent.click(within(editor).getByRole('tab', { name: 'Follow-ups & phrasings' }))
    assert.equal((within(editor).getByRole('checkbox', { name: 'Entry question' }) as HTMLInputElement).checked, false)
    fireEvent.click(within(editor).getByRole('tab', { name: 'Details' }))
    absent(within(editor).queryByRole('region', { name: 'Draft, to be verified' }))
    fireEvent.change(within(editor).getByLabelText(/^Answer \(English\)/), { target: { value: 'Check the card details.' } })
    fireEvent.change(within(editor).getByLabelText(/^Question \(Chinese\)/), { target: { value: '为什么卡被拒？' } })
    fireEvent.change(within(editor).getByLabelText(/^Answer \(Chinese\)/), { target: { value: '请核对卡片信息。' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Save FAQ' }))
    await waitFor(() => assert.equal(server.callsTo('POST', ACCEPT).length, 1))
    assert.equal((server.callsTo('POST', FAQS)[0].body as Record<string, unknown>).entry, false)
    assert.deepEqual(server.callsTo('POST', ACCEPT)[0].body, {
      as: 'follow_up',
      faqId: NEW_FAQ,
      parentId: PARENT,
      phrasings: [0],
      version: 1,
    })
  })

  test('if accepting fails after the FAQ was saved, staff are told the FAQ is saved and why the candidate is not', async () => {
    serve({ ...refundGroup, suggestion: 'new_faq', relatedNodeId: null })
    server.on('GET', DRAFT, {
      data: {
        candidateId: 'c1',
        version: 1,
        suggestion: 'new_faq',
        faq: { type: 'answer', entry: true, category: 'payments_subscriptions', questionEn: 'Q?', questionZh: '问？', answerEn: '', answerZh: '', keywords: [] },
        parentId: null,
        relatedNodeId: null,
        phrasings: [],
        answerDraft: null,
      } satisfies FaqCandidateDraft,
    })
    server.on('POST', FAQS, (call) => ({ status: 201, data: faq(NEW_FAQ, call.body as object) }))
    server.on('POST', ACCEPT, { status: 409, error: 'CANDIDATE_CHANGED' })
    await openQueue()
    const dialog = await openCandidate('Refund timing')
    fireEvent.click(within(dialog).getByRole('button', { name: 'New FAQ' }))
    const editor = await screen.findByRole('dialog', { name: 'Add FAQ' })
    fireEvent.change(within(editor).getByLabelText(/^Answer \(English\)/), { target: { value: 'A.' } })
    fireEvent.change(within(editor).getByLabelText(/^Answer \(Chinese\)/), { target: { value: '答。' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Save FAQ' }))
    assert.ok(
      await screen.findByText(
        'FAQ saved, but the candidate was not accepted: Someone else changed this candidate. It has been reloaded; check it and try again.',
      ),
    )
  })
})

describe('jobs: run now (gap mining and Portal retention)', () => {
  test('the last runs are listed; run now starts mining in the background, polls the run and reloads the queue', async () => {
    serve(refundGroup)
    const running = miningRun({ id: 'run-2', trigger: 'manual', status: 'running', finishedAt: null, durationMs: null, stats: {} })
    server.on('POST', MINING_NOW, { status: 201, data: running })
    let polls = 0
    server.on('GET', MINING_RUN, () => {
      polls += 1
      return polls < 2
        ? { data: running }
        : { data: { ...running, status: 'succeeded', stats: { pull: { status: 'pulled', received: 30 }, mine: { created: 4, grown: 1 } } } }
    })
    await openQueue()
    const jobs = await screen.findByRole('table', { name: 'Jobs' })
    const mining = await waitFor(() => within(jobs).getByText('Nightly gap mining').closest('tr') as HTMLElement)
    await waitFor(() => assert.ok(within(mining).getByText('120 turns pulled, 2 new, 1 grown')))
    const retention = within(jobs).getByText('Raw text retention (Portal, 180 days)').closest('tr') as HTMLElement
    assert.ok(within(retention).getByText('42 rows scrubbed'))
    const before = server.callsTo('GET', LIST).length
    fireEvent.click(within(mining).getByRole('button', { name: 'Run Nightly gap mining now' }))
    await waitFor(() => assert.equal(server.callsTo('POST', MINING_NOW).length, 1))
    assert.match(server.callsTo('POST', MINING_NOW)[0].idempotencyKey ?? '', /^[0-9a-f-]{36}$/)
    assert.equal(
      (await screen.findByText(/^Gap mining finished/, undefined, { timeout: 8000 })).textContent,
      'Gap mining finished: 4 new candidates, 1 grown.',
    )
    assert.ok(polls >= 2)
    await waitFor(() => assert.ok(server.callsTo('GET', LIST).length > before))
  })

  test('already running is explained; Portal retention runs now and reports what it scrubbed', async () => {
    serve(refundGroup)
    server.on('POST', MINING_NOW, { status: 409, error: 'JOB_ALREADY_RUNNING' })
    const pending = deferred<Reply>()
    server.on('POST', RETENTION_NOW, () => pending.promise)
    await openQueue()
    const jobs = await screen.findByRole('table', { name: 'Jobs' })
    fireEvent.click(await within(jobs).findByRole('button', { name: 'Run Nightly gap mining now' }))
    assert.ok(await screen.findByText('This job is already running. Try again when it has finished.'))
    const retentionButton = within(jobs).getByRole('button', { name: 'Run Raw text retention (Portal, 180 days) now' })
    fireEvent.click(retentionButton)
    await waitFor(() => assert.equal((retentionButton as HTMLButtonElement).disabled, true))
    pending.resolve({ data: { outcome: 'completed', run: retentionRun({ id: 'p-2', trigger: 'manual', rowsScrubbed: 7 }) } })
    assert.ok(await screen.findByText('Retention finished: 7 rows scrubbed.'))
    assert.ok(server.callsTo('POST', RETENTION_NOW)[0].idempotencyKey)
  })

  test('Portal not connected shows on the retention row only', async () => {
    serve(refundGroup)
    server.on('GET', RETENTION, { status: 503, error: 'HELPDESK_NOT_CONNECTED' })
    await openQueue()
    const jobs = await screen.findByRole('table', { name: 'Jobs' })
    await waitFor(() => assert.ok(within(jobs).getByText('HelpDesk is not connected yet.')))
    await waitFor(() => assert.ok(within(jobs).getByText('120 turns pulled, 2 new, 1 grown')))
  })
})

describe('"转成 FAQ 候选" from a resolved ticket', () => {
  const TICKET = /^\/api\/helpdesk\/tickets\/[^/]+$/
  const TO_CANDIDATE = /^\/api\/helpdesk\/tickets\/[^/]+\/faq-candidate$/

  function serveTicket(ticket: EnquiryDetail) {
    server.on('GET', '/api/helpdesk/tickets', { data: { tickets: [ticket], nextCursor: null, counts: {} } })
    server.on('GET', TICKET, { data: ticket })
  }

  const closed = (patch: Partial<EnquiryDetail> = {}) =>
    detail('t1', {
      status: 'CLOSED',
      closeReason: 'user_confirmed',
      available: { claim: false, reply: false, internalNote: true, proposeResolution: false, tag: true, markRead: false, flag: true },
      ...patch,
    })

  test('a resolved ticket can be turned into a candidate; the notice links to it; a second time says it already is', async () => {
    serveTicket(closed())
    server.on('POST', TO_CANDIDATE, { status: 201, data: { candidate: candidate('c9'), created: true, similarCandidateId: null } })
    await renderHelpDesk(server, { path: '/en-GB/help-desk/t1' })
    const button = await screen.findByRole('button', { name: 'Turn into FAQ candidate' })
    fireEvent.click(button)
    await waitFor(() => assert.equal(server.callsTo('POST', TO_CANDIDATE).length, 1))
    assert.equal(server.callsTo('POST', TO_CANDIDATE)[0].path, '/api/helpdesk/tickets/t1/faq-candidate')
    assert.ok(await screen.findByText('Turned into an FAQ candidate. The text was scrubbed first.'))
    const link = screen.getByRole('link', { name: 'Open it in FAQ candidates' })
    assert.equal(link.getAttribute('href'), '/en-GB/help-desk?tab=candidates&status=all&candidate=c9')
    server.on('POST', TO_CANDIDATE, { status: 200, data: { candidate: candidate('c9'), created: false, similarCandidateId: null } })
    fireEvent.click(button)
    assert.ok(await screen.findByText('This ticket is already an FAQ candidate.'))
  })

  test('not on an open or cancelled ticket, and never for VIEW', async () => {
    serveTicket(detail('t1', { status: 'ASSIGNED' }))
    await renderHelpDesk(server, { path: '/en-GB/help-desk/t1' })
    await screen.findByRole('article', { name: 'Subject t1' })
    absent(screen.queryByRole('button', { name: 'Turn into FAQ candidate' }))
    cleanup()
    serveTicket(closed({ closeReason: 'cancelled' }))
    await renderHelpDesk(server, { path: '/en-GB/help-desk/t1' })
    await screen.findByRole('article', { name: 'Subject t1' })
    absent(screen.queryByRole('button', { name: 'Turn into FAQ candidate' }))
    cleanup()
    serveTicket(closed())
    await renderHelpDesk(server, { role: 'COURSE_CREATOR', path: '/en-GB/help-desk/t1' })
    await screen.findByRole('article', { name: 'Subject t1' })
    absent(screen.queryByRole('button', { name: 'Turn into FAQ candidate' }))
  })

  test('zh-CN: 转成 FAQ 候选; an unresolved ticket error is shown on the card', async () => {
    serveTicket(closed())
    server.on('POST', TO_CANDIDATE, { status: 409, error: 'TICKET_NOT_RESOLVED' })
    await renderHelpDesk(server, { path: '/zh-CN/help-desk/t1' })
    fireEvent.click(await screen.findByRole('button', { name: '转成 FAQ 候选' }))
    assert.ok(await screen.findByText('只有已解决的工单能转成 FAQ 候选。'))
  })
})
