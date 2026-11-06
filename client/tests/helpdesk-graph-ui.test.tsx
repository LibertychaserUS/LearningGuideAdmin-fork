import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'

import type {
  FaqEdgeView,
  FaqGraphPreview,
  FaqPhrasing,
  FaqRelease,
  FaqTreeNode,
  FaqWorkingCopy,
  HelpdeskFaq,
} from '../src/backoffice/contracts/helpdesk'
import { absent, faq, installFakeServer, type FakeServer } from './support/helpdesk-fake'
import { renderHelpDesk } from './support/helpdesk-render'

/**
 * v5 问题树员工端（helpdesk-v5-faq-graph-design §5.1–§5.4），经 HelpDeskPage 渲染，fetch 换成假的 BackOffice
 * Server：FAQ 抽屉的「追问与选项」（类型、入口、情境、子节点的排序 / 文字 / 移除 / 添加、问法）、问题树（大纲、
 * 共享节点、提醒）、对话预览（三段式 + 追问 chip + A/B/C/D）、发布新版本（差异、检查、发布、回滚、VIEW 只读）。
 */

const LIST = '/api/helpdesk/faqs'
const ONE = /^\/api\/helpdesk\/faqs\/[^/]+$/
const PARENT = 'f-parent'

let server: FakeServer

function serveFaqs(...items: HelpdeskFaq[]) {
  server.on('GET', LIST, (call) => {
    const q = (call.query.get('q') ?? '').toLowerCase()
    const faqs = items.filter((item) => !q || item.questionEn.toLowerCase().includes(q))
    return { data: { faqs, total: faqs.length, page: 1, pageSize: 10 } }
  })
  server.on('GET', '/api/helpdesk/tickets', { data: { tickets: [], nextCursor: null, counts: {} } })
}

function edgeView(id: string, childId: string, patch: Partial<FaqEdgeView['edge']> = {}, question = `Question ${childId}?`): FaqEdgeView {
  return {
    edge: {
      id,
      parentId: PARENT,
      childId,
      kind: 'follow_up',
      position: 0,
      labelEn: null,
      labelZh: null,
      createdBy: null,
      createdAt: '2026-10-29T10:00:00Z',
      updatedAt: '2026-10-29T10:00:00Z',
      ...patch,
    },
    node: {
      id: childId,
      key: childId,
      type: 'answer',
      entry: false,
      category: 'payments_subscriptions',
      questionEn: question,
      questionZh: `问题 ${childId}？`,
      status: 'published',
    },
    label: { en: patch.labelEn ?? question, zh: patch.labelZh ?? `问题 ${childId}？` },
  }
}

function phrasing(id: string, patch: Partial<FaqPhrasing> = {}): FaqPhrasing {
  return { id, faqId: PARENT, locale: 'en-GB', text: `phrasing ${id}`, source: 'staff', createdBy: null, createdAt: '2026-10-29T10:00:00Z', ...patch }
}

let children: FaqEdgeView[]
let phrasings: FaqPhrasing[]

function serveGraph(options: { children?: FaqEdgeView[]; phrasings?: FaqPhrasing[] } = {}) {
  children = options.children ?? []
  phrasings = options.phrasings ?? []
  server.on('GET', /\/edges$/, () => ({ data: { children, parents: [] } }))
  server.on('GET', /\/phrasings$/, () => ({ data: { phrasings } }))
}

const PARENT_FAQ = faq(PARENT, {
  questionEn: 'My payment failed',
  questionZh: '付款失败了',
  category: 'payments_subscriptions',
  key: 'payment-failed',
  type: 'answer',
  entry: true,
  signals: ['payment_failed'],
  version: 3,
})

async function openEditor(item: HelpdeskFaq = PARENT_FAQ, extra: HelpdeskFaq[] = []) {
  serveFaqs(item, ...extra)
  await renderHelpDesk(server, { path: '/en-GB/help-desk?tab=faqs' })
  fireEvent.click(await screen.findByRole('button', { name: `Edit ${item.questionEn}` }))
  const dialog = await screen.findByRole('dialog', { name: 'Edit FAQ' })
  await waitFor(() => assert.ok(server.callsTo('GET', /\/phrasings$/).length >= 1))
  // 追问、选项与问法在抽屉的第二个页签（Figma 草案 2.9）
  fireEvent.click(within(dialog).getByRole('tab', { name: 'Follow-ups & phrasings' }))
  return dialog
}

beforeEach(() => {
  server = installFakeServer()
})

afterEach(() => {
  cleanup()
  server.restore()
})

describe('FAQ editor: 追问与选项 (graph design §5.1)', () => {
  test('card type, entry and situations load from the FAQ and are saved with it', async () => {
    serveGraph()
    server.on('PUT', ONE, (call) => ({ data: { ...PARENT_FAQ, ...(call.body as object), version: 4 } }))
    const dialog = await openEditor()
    assert.ok(within(dialog).getByRole('heading', { name: 'Follow-ups and options' }))
    assert.equal((within(dialog).getByLabelText('Answer card') as HTMLInputElement).checked, true)
    assert.equal((within(dialog).getByLabelText('Entry question') as HTMLInputElement).checked, true)
    assert.equal((within(dialog).getByLabelText('Payment failed') as HTMLInputElement).checked, true)
    assert.ok(within(dialog).getByText('Key: payment-failed'))
    fireEvent.click(within(dialog).getByLabelText('Entry question'))
    fireEvent.click(within(dialog).getByLabelText('Recent purchase'))
    fireEvent.click(within(dialog).getByLabelText('Payment failed'))
    fireEvent.click(within(dialog).getByLabelText('Asking about an order'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save FAQ' }))
    assert.ok(await screen.findByText('FAQ saved.'))
    const [call] = server.callsTo('PUT', ONE)
    assert.deepEqual(
      [(call.body as HelpdeskFaq).type, (call.body as HelpdeskFaq).entry, (call.body as HelpdeskFaq).signals],
      ['answer', false, ['recent_purchase', 'from_order']],
    )
  })

  test('a choice question cannot state facts: digits or links in its question are refused before saving', async () => {
    serveGraph()
    const dialog = await openEditor(faq(PARENT, { ...PARENT_FAQ, answerEn: 'Refund within 14 days.' }))
    fireEvent.click(within(dialog).getByLabelText('Choice question (A/B/C/D)'))
    assert.ok(within(dialog).getByText(/The answer box holds one short question/))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save FAQ' }))
    assert.ok(await within(dialog).findByText('The question of a choice card cannot contain digits, links or emails'))
    assert.equal(server.callsTo('PUT', ONE).length, 0)
  })

  test('a new FAQ: the fields are there; follow-ups and phrasings come after the first save', async () => {
    serveFaqs()
    await renderHelpDesk(server, { path: '/en-GB/help-desk?tab=faqs' })
    fireEvent.click(screen.getByRole('button', { name: '+ Add FAQ' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add FAQ' })
    assert.ok(within(dialog).getByText('Save this FAQ first, then add follow-ups and phrasings.'))
    assert.equal((within(dialog).getByLabelText('Entry question') as HTMLInputElement).checked, true)
    absent(within(dialog).queryByRole('button', { name: 'Add existing question' }))
    assert.equal(server.callsTo('GET', /\/edges$/).length, 0)
  })

  test('children: listed in order with their text; move down and drag both send the whole new order', async () => {
    serveGraph({
      children: [
        edgeView('e1', 'c1', { position: 0, labelEn: 'Try another card', labelZh: '换一张卡' }, 'Can I pay with another card?'),
        edgeView('e2', 'c2', { position: 1 }),
        edgeView('e3', 'c3', { position: 2 }),
      ],
    })
    server.on('PUT', /\/edges\/order$/, (call) => ({
      data: { children: (call.body as { childIds: string[] }).childIds.map((id) => children.find((c) => c.edge.childId === id)!).map((c, at) => ({ ...c, edge: { ...c.edge, position: at } })) },
    }))
    const dialog = await openEditor()
    const list = await within(dialog).findByRole('list', { name: /Follow-ups \(up to 6, the first 4 are shown\)/ })
    assert.deepEqual(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.querySelector('.hdGraphChildLabel')?.textContent),
      ['Try another card', 'Question c2?', 'Question c3?'],
    )
    // the custom text shows the question it replaces
    assert.ok(within(list).getByText('Can I pay with another card?'))
    assert.ok(within(list).getByText('Custom text'))
    assert.equal((within(list).getByRole('button', { name: 'Move Try another card up' }) as HTMLButtonElement).disabled, true)
    fireEvent.click(within(list).getByRole('button', { name: 'Move Try another card down' }))
    await waitFor(() => assert.equal(server.callsTo('PUT', /\/edges\/order$/).length, 1))
    assert.equal(server.callsTo('PUT', /\/edges\/order$/)[0].path, `/api/helpdesk/faqs/${PARENT}/edges/order`)
    assert.deepEqual(server.callsTo('PUT', /\/edges\/order$/)[0].body, { childIds: ['c2', 'c1', 'c3'] })
    await waitFor(() =>
      assert.equal(within(list).getAllByRole('listitem')[0].querySelector('.hdGraphChildLabel')?.textContent, 'Question c2?'),
    )
    // drag the last one to the top
    const items = within(list).getAllByRole('listitem')
    fireEvent.dragStart(items[2])
    fireEvent.dragOver(items[0])
    fireEvent.drop(items[0])
    await waitFor(() => assert.equal(server.callsTo('PUT', /\/edges\/order$/).length, 2))
    assert.deepEqual(server.callsTo('PUT', /\/edges\/order$/)[1].body, { childIds: ['c3', 'c2', 'c1'] })
  })

  test('the chip text: both languages or neither; saving sends both, then the list reloads; Remove deletes the link', async () => {
    serveGraph({ children: [edgeView('e1', 'c1')] })
    server.on('PUT', /^\/api\/helpdesk\/faq-edges\//, (call) => {
      const body = call.body as { labelEn: string; labelZh: string }
      children = [edgeView('e1', 'c1', { labelEn: body.labelEn, labelZh: body.labelZh })]
      return { data: children[0].edge }
    })
    server.on('DELETE', /^\/api\/helpdesk\/faq-edges\//, () => {
      children = []
      return { data: { deleted: true } }
    })
    const dialog = await openEditor()
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Edit the text of Question c1?' }))
    fireEvent.change(within(dialog).getByLabelText('Text shown (English)'), { target: { value: 'Another card?' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save text' }))
    assert.ok(await within(dialog).findByText('Fill in both languages, or leave both empty.'))
    assert.equal(server.callsTo('PUT', /^\/api\/helpdesk\/faq-edges\//).length, 0)
    fireEvent.change(within(dialog).getByLabelText('Text shown (Chinese)'), { target: { value: ' 换卡 ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save text' }))
    await waitFor(() => assert.equal(server.callsTo('PUT', /^\/api\/helpdesk\/faq-edges\//).length, 1))
    const [put] = server.callsTo('PUT', /^\/api\/helpdesk\/faq-edges\//)
    assert.equal(put.path, '/api/helpdesk/faq-edges/e1')
    assert.deepEqual(put.body, { labelEn: 'Another card?', labelZh: '换卡' })
    assert.ok(await within(dialog).findByText('Another card?'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Another card?' }))
    await waitFor(() => assert.equal(server.callsTo('DELETE', /^\/api\/helpdesk\/faq-edges\//).length, 1))
    assert.ok(await within(dialog).findByText('No follow-ups yet.'))
  })

  test('add an existing question: search, the card itself is left out, linked ones are marked, Add links it', async () => {
    serveGraph({ children: [edgeView('e1', 'c1', {}, 'Contact support')] })
    server.on('POST', /\/edges$/, (call) => {
      children = [...children, edgeView('e2', (call.body as { childId: string }).childId, {}, 'Refund policy')]
      return { status: 201, data: children[1].edge }
    })
    const dialog = await openEditor(PARENT_FAQ, [
      faq('c1', { questionEn: 'Contact support' }),
      faq('c9', { questionEn: 'Refund policy' }),
    ])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add existing question' }))
    await waitFor(() => assert.ok(within(dialog).getByRole('button', { name: 'Add Refund policy' })))
    const results = within(dialog).getByRole('button', { name: 'Add Refund policy' }).closest('ul') as HTMLElement
    absent(within(results).queryByText('My payment failed'))
    assert.ok(within(results).getByText('Already added'))
    fireEvent.change(within(dialog).getByRole('searchbox', { name: 'Search questions...' }), { target: { value: 'refund' } })
    await waitFor(() => assert.equal(server.callsTo('GET', LIST).at(-1)?.query.get('q'), 'refund'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Refund policy' }))
    await waitFor(() => assert.equal(server.callsTo('POST', /\/edges$/).length, 1))
    assert.deepEqual(server.callsTo('POST', /\/edges$/)[0].body, { childId: 'c9' })
    assert.ok(await within(dialog).findByRole('list', { name: /Follow-ups/ }))
    await waitFor(() => assert.equal(within(dialog).getAllByText('Refund policy').length, 1))
  })

  test('a new follow-up is created as a non-entry answer in the same category, then linked under this card', async () => {
    serveGraph()
    server.on('POST', LIST, (call) => ({ status: 201, data: faq('c-new', call.body as Partial<HelpdeskFaq>) }))
    server.on('POST', /\/edges$/, (call) => {
      children = [edgeView('e9', (call.body as { childId: string }).childId, {}, 'Will I be charged twice?')]
      return { status: 201, data: children[0].edge }
    })
    const dialog = await openEditor()
    fireEvent.click(within(dialog).getByRole('button', { name: 'New follow-up' }))
    const panel = within(dialog).getByText(/The new question is not an entry question/).parentElement as HTMLElement
    fireEvent.click(within(panel).getByRole('button', { name: 'Create and add' }))
    await waitFor(() => assert.equal(within(panel).getAllByText('Required').length, 4))
    assert.equal(server.callsTo('POST', LIST).length, 0)
    fireEvent.change(within(panel).getByLabelText('Question (English)'), { target: { value: 'Will I be charged twice?' } })
    fireEvent.change(within(panel).getByLabelText('Answer (English)'), { target: { value: 'No.' } })
    fireEvent.change(within(panel).getByLabelText('Question (Chinese)'), { target: { value: '会重复扣款吗？' } })
    fireEvent.change(within(panel).getByLabelText('Answer (Chinese)'), { target: { value: '不会。' } })
    fireEvent.click(within(panel).getByRole('button', { name: 'Create and add' }))
    await waitFor(() => assert.equal(server.callsTo('POST', /\/edges$/).length, 1))
    const [created] = server.callsTo('POST', LIST)
    assert.match(created.idempotencyKey ?? '', /^[0-9a-f-]{36}$/)
    assert.deepEqual(created.body, {
      category: 'payments_subscriptions',
      popular: false,
      questionEn: 'Will I be charged twice?',
      answerEn: 'No.',
      questionZh: '会重复扣款吗？',
      answerZh: '不会。',
      keywords: [],
      type: 'answer',
      entry: false,
      signals: [],
    })
    assert.deepEqual(server.callsTo('POST', /\/edges$/)[0].body, { childId: 'c-new' })
    assert.ok(await within(dialog).findByText('Will I be charged twice?'))
  })

  test('a choice card has lettered options; at its limit of 4 nothing more can be added; a loop is refused with its message', async () => {
    serveGraph({
      children: ['a', 'b', 'c', 'd'].map((id, at) => edgeView(`e${id}`, id, { kind: 'option', position: at }, `Option ${id}`)),
    })
    const choice = faq(PARENT, { ...PARENT_FAQ, type: 'choice', answerEn: 'Which one is it?', answerZh: '是哪种情况？' })
    const dialog = await openEditor(choice)
    const list = await within(dialog).findByRole('list', { name: 'Options (2–4)' })
    assert.deepEqual(
      [...list.querySelectorAll('.hdGraphLetter')].map((node) => node.textContent),
      ['A', 'B', 'C', 'D'],
    )
    assert.ok(within(dialog).getByText('This card already has 4.'))
    assert.equal((within(dialog).getByRole('button', { name: 'Add existing question' }) as HTMLButtonElement).disabled, true)
    assert.equal((within(dialog).getByRole('button', { name: 'New option' }) as HTMLButtonElement).disabled, true)
  })

  test('a link that would loop is refused and the reason is shown', async () => {
    serveGraph()
    server.on('POST', /\/edges$/, { status: 409, error: 'FAQ_EDGE_CYCLE' })
    const dialog = await openEditor(PARENT_FAQ, [faq('c9', { questionEn: 'Refund policy' })])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add existing question' }))
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add Refund policy' }))
    assert.equal(
      (await within(dialog).findByRole('alert')).textContent,
      'This link would make a loop: that question already leads back here.',
    )
  })

  test('phrasings: listed with their language; an empty one is refused; a Traditional Chinese one is added; Remove deletes it', async () => {
    serveGraph({ phrasings: [phrasing('p1', { text: 'card declined' }), phrasing('p2', { locale: 'zh-CN', text: '卡被拒', source: 'flywheel' })] })
    server.on('POST', /\/phrasings$/, (call) => {
      const body = call.body as { locale: 'zh-TW'; text: string }
      phrasings = [...phrasings, phrasing('p3', body)]
      return { status: 201, data: phrasings[2] }
    })
    server.on('DELETE', /^\/api\/helpdesk\/faq-phrasings\//, { data: { deleted: true } })
    const dialog = await openEditor()
    const list = await within(dialog).findByRole('list', { name: 'How learners ask' })
    assert.ok(within(list).getByText('card declined'))
    assert.ok(within(list).getByText('From chats'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add phrasing' }))
    assert.ok(await within(dialog).findByText('Enter a phrasing'))
    fireEvent.change(within(dialog).getByLabelText('Language of the phrasing'), { target: { value: 'zh-TW' } })
    fireEvent.change(within(dialog).getByLabelText('New phrasing'), { target: { value: '  卡被拒絕了  ' } })
    fireEvent.keyDown(within(dialog).getByLabelText('New phrasing'), { key: 'Enter' })
    await waitFor(() => assert.equal(server.callsTo('POST', /\/phrasings$/).length, 1))
    assert.deepEqual(server.callsTo('POST', /\/phrasings$/)[0].body, { locale: 'zh-TW', text: '卡被拒絕了' })
    assert.ok(await within(list).findByText('卡被拒絕了'))
    assert.equal((within(dialog).getByLabelText('New phrasing') as HTMLInputElement).value, '')
    fireEvent.click(within(list).getByRole('button', { name: 'Remove the phrasing card declined' }))
    await waitFor(() => assert.equal(server.callsTo('DELETE', /^\/api\/helpdesk\/faq-phrasings\//)[0]?.path, '/api/helpdesk/faq-phrasings/p1'))
    await waitFor(() => absent(within(list).queryByText('card declined')))
  })
})

describe('FAQ editor: focus and announcements after each action', () => {
  const announced = (dialog: HTMLElement) => dialog.querySelector('.hdGraphAnnounce')?.textContent ?? ''

  test('saving a text, adding, removing and phrasings keep the keyboard user in place and say what happened', async () => {
    serveGraph({ children: [edgeView('e1', 'c1', {}, 'Contact support')], phrasings: [phrasing('p1', { text: 'card declined' })] })
    server.on('PUT', /^\/api\/helpdesk\/faq-edges\//, (call) => {
      const body = call.body as { labelEn: string; labelZh: string }
      children = [edgeView('e1', 'c1', { labelEn: body.labelEn, labelZh: body.labelZh }, 'Contact support')]
      return { data: children[0].edge }
    })
    server.on('POST', /\/edges$/, (call) => {
      children = [...children, edgeView('e2', (call.body as { childId: string }).childId, { position: 1 }, 'Refund policy')]
      return { status: 201, data: children[1].edge }
    })
    server.on('DELETE', /^\/api\/helpdesk\/faq-edges\//, () => {
      children = children.filter((view) => view.edge.id !== 'e2')
      return { data: { deleted: true } }
    })
    server.on('POST', /\/phrasings$/, (call) => {
      phrasings = [...phrasings, phrasing('p2', call.body as Partial<FaqPhrasing>)]
      return { status: 201, data: phrasings[1] }
    })
    server.on('DELETE', /^\/api\/helpdesk\/faq-phrasings\//, { data: { deleted: true } })
    const dialog = await openEditor(PARENT_FAQ, [faq('c9', { questionEn: 'Refund policy' })])

    // saving a chip text: focus goes back to that row's Edit button
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Edit the text of Contact support' }))
    fireEvent.change(within(dialog).getByLabelText('Text shown (English)'), { target: { value: 'Talk to us' } })
    fireEvent.change(within(dialog).getByLabelText('Text shown (Chinese)'), { target: { value: '联系我们' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save text' }))
    await waitFor(() => assert.ok(document.activeElement === within(dialog).getByRole('button', { name: 'Edit the text of Talk to us' }), 'focus'))
    assert.equal(announced(dialog), 'Text saved.')

    // adding an existing question: focus goes back to "Add existing question"
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add existing question' }))
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add Refund policy' }))
    await waitFor(() => assert.ok(document.activeElement === within(dialog).getByRole('button', { name: 'Add existing question' }), 'focus'))
    assert.equal(announced(dialog), 'Added: Refund policy')

    // removing a link: focus goes to the list heading
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Remove Refund policy' }))
    await waitFor(() => assert.equal(announced(dialog), 'Removed: Refund policy'))
    assert.equal((document.activeElement as HTMLElement).id.endsWith('-children'), true)

    // phrasings: adding keeps focus in the input, removing moves it to the input
    const input = within(dialog).getByLabelText('New phrasing')
    fireEvent.change(input, { target: { value: 'charged but failed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => assert.equal(announced(dialog), 'Phrasing added.'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove the phrasing card declined' }))
    await waitFor(() => assert.equal(announced(dialog), 'Phrasing removed.'))
    assert.ok(document.activeElement === within(dialog).getByLabelText('New phrasing'), 'focus')
  })

  test('cancelling a chip text form returns focus to its Edit button', async () => {
    serveGraph({ children: [edgeView('e1', 'c1', {}, 'Contact support')] })
    const dialog = await openEditor()
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Edit the text of Contact support' }))
    const form = within(dialog).getByLabelText('Text shown (English)').closest('.hdGraphLabelForm') as HTMLElement
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => assert.ok(document.activeElement === within(dialog).getByRole('button', { name: 'Edit the text of Contact support' }), 'focus'))
  })
})

/* ---------------------------------- 树视图 ---------------------------------- */

function treeNode(id: string, children: FaqTreeNode[] = [], patch: Partial<FaqTreeNode> = {}, question = `Q ${id}`): FaqTreeNode {
  return {
    node: { id, key: id, type: 'answer', entry: false, category: 'payments_subscriptions', questionEn: question, questionZh: `问 ${id}`, status: 'published' },
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

function edgeOf(parentId: string, childId: string, kind: 'follow_up' | 'option', position: number) {
  return {
    id: `${parentId}-${childId}`,
    parentId,
    childId,
    kind,
    position,
    labelEn: null,
    labelZh: null,
    createdBy: null,
    createdAt: '2026-10-29T10:00:00Z',
    updatedAt: '2026-10-29T10:00:00Z',
  }
}

const SHARED = (parent: string) =>
  treeNode('contact', [], {
    edge: edgeOf(parent, 'contact', 'follow_up', 0),
    label: { en: 'Contact support', zh: '联系客服' },
    depth: 2,
    parentCount: 3,
    alsoAppearsIn: [
      { id: parent === 'failed' ? 'refund' : 'failed', key: 'x', questionEn: 'Other parent', questionZh: '另一个' },
      { id: 'third', key: 'third', questionEn: 'Third parent', questionZh: '第三个' },
    ],
  }, 'How do I contact support?')

const TREE = {
  root: treeNode(
    'pay',
    [
      treeNode('failed', [SHARED('failed')], { edge: edgeOf('pay', 'failed', 'option', 0), label: { en: 'It failed', zh: '付款失败' }, depth: 1 }, 'My payment failed'),
      treeNode('refund', [SHARED('refund')], {
        edge: edgeOf('pay', 'refund', 'option', 1),
        label: { en: 'I want a refund', zh: '想退款' },
        depth: 1,
        warnings: [{ rule: 'language', nodeId: 'refund', key: 'refund', detail: 'missing zh' }],
      }, 'How do I get a refund?'),
    ],
    { node: { id: 'pay', key: 'pay', type: 'choice', entry: true, category: 'payments_subscriptions', questionEn: 'A problem with paying?', questionZh: '付款有问题？', status: 'published' }, parentCount: 0 },
  ),
  nodes: 5,
}

const PAY = faq('pay', { questionEn: 'A problem with paying?', type: 'choice', entry: true, key: 'pay' })

async function openTree(role: 'ADMIN' | 'COURSE_CREATOR' = 'ADMIN') {
  serveFaqs(PAY)
  server.on('GET', /\/tree$/, { data: TREE })
  await renderHelpDesk(server, { role, path: '/en-GB/help-desk?tab=faqs' })
  // Figma 1379:2 的操作列只有 Edit / Preview：问题树从 Preview 进入
  const row = (await screen.findByText('A problem with paying?')).closest('tr') as HTMLElement
  assert.equal(within(row).queryByRole('button', { name: /question tree/i }), null, 'no Tree button in the table')
  const opener = within(row).getByRole('button', { name: 'Preview A problem with paying?' })
  opener.focus()
  fireEvent.click(opener)
  const preview = await screen.findByRole('dialog', { name: 'Preview FAQ' })
  // the accessible name is the visible text (WCAG 2.5.3 label in name)
  fireEvent.click(within(preview).getByRole('button', { name: 'View question tree', exact: true }))
  await waitFor(() => absent(screen.queryByRole('dialog', { name: 'Preview FAQ' })))
  return screen.findByRole('dialog', { name: 'Question tree' })
}

describe('tree view (graph design §5.2)', () => {
  test('an indented outline from the entry: options lettered, a shared node shows where else it appears, warnings inline', async () => {
    const dialog = await openTree()
    assert.equal(server.callsTo('GET', /\/tree$/)[0].path, '/api/helpdesk/faqs/pay/tree')
    const outline = await within(dialog).findByRole('list', { name: 'Question tree outline' })
    // nested lists (a screen reader hears each branch as a list inside its parent's item), rows in document order
    const rows = () => [...outline.querySelectorAll('li.hdTreeRow')].map((li) => li.querySelector('.hdGraphChildLabel')?.textContent)
    assert.deepEqual(rows(), ['A problem with paying?', 'It failed', 'Contact support', 'I want a refund', 'Contact support'])
    assert.equal(outline.querySelectorAll(':scope > li').length, 1, 'only the entry at the top level')
    const failedRow = within(outline).getByText('It failed').closest('li') as HTMLElement
    const branch = failedRow.parentElement as HTMLElement
    assert.equal(branch.tagName, 'UL')
    assert.equal(within(branch.closest('li') as HTMLElement).getAllByText('A problem with paying?').length, 1, 'the option sits inside the choice row')
    assert.equal(within(branch).getAllByRole('listitem').filter((li) => li.parentElement === branch).length, 2, 'two options')
    // the option letter is read out, not only drawn
    assert.match(failedRow.querySelector('.hdTreeLine')?.textContent ?? '', /Option A/)
    assert.ok(within(dialog).getByText('5 questions in this tree'))
    assert.ok(within(dialog).getByText('1 warnings'))
    assert.equal(within(outline).getAllByText('Also appears in 2 places').length, 2)
    assert.ok(within(outline).getAllByText('Also under: Other parent · Third parent').length >= 1)
    assert.ok(within(outline).getByText('English or Chinese text is missing.'))
    assert.ok(within(outline).getByText('Choice'))
    assert.ok(within(outline).getByText('Entry'))
    // the label differs from the question: both are shown
    assert.ok(within(outline).getByText('My payment failed'))
    fireEvent.click(within(outline).getByRole('button', { name: 'Collapse It failed' }))
    assert.deepEqual(rows(), ['A problem with paying?', 'It failed', 'I want a refund', 'Contact support'])
    assert.equal(within(outline).getByRole('button', { name: 'Expand It failed' }).getAttribute('aria-expanded'), 'false')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Collapse all' }))
    assert.deepEqual(rows(), ['A problem with paying?'])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Expand all' }))
    assert.equal(rows().length, 5)
  })

  test('VIEW roles can open it too; Escape closes it', async () => {
    const dialog = await openTree('COURSE_CREATOR')
    assert.ok(await within(dialog).findByRole('list', { name: 'Question tree outline' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => absent(screen.queryByRole('dialog')))
    // the preview is gone: focus goes back to the row's Preview button that opened it, not to <body>
    await waitFor(() => assert.equal(document.activeElement, screen.getByRole('button', { name: 'Preview A problem with paying?' })))
  })
})

/* -------------------------------- 对话预览 -------------------------------- */

function preview(locale: 'en-GB' | 'zh-CN'): FaqGraphPreview {
  const zh = locale === 'zh-CN'
  const node = (id: string, type: 'answer' | 'choice', entry: boolean, question: string, answer: string) => ({
    id,
    key: id,
    type,
    entry,
    category: 'payments_subscriptions' as const,
    popular: false,
    question,
    answer,
    blocks: type === 'answer' ? [{ id: 'b1', text: answer }] : [],
    signals: [],
  })
  return {
    source: 'working',
    published: 1,
    locale,
    nodes: [
      node('pay', 'choice', true, zh ? '付款有问题？' : 'A problem with paying?', zh ? '你遇到的是哪种情况？' : 'Which of these is it?'),
      node('failed', 'answer', false, zh ? '付款失败怎么办' : 'My payment failed', zh ? '换一张**卡**再试。' : 'Try **another card**.'),
      node('refund', 'answer', false, zh ? '如何申请退款' : 'How do I get a refund?', zh ? '在账单页申请。' : 'Ask on the billing page.'),
      ...['f1', 'f2', 'f3', 'f4', 'f5'].map((id) => node(id, 'answer', false, `Follow ${id}`, `Answer ${id}`)),
    ],
    edges: [
      { parentId: 'pay', childId: 'failed', kind: 'option', position: 0, label: zh ? '付款失败' : 'It failed' },
      { parentId: 'pay', childId: 'refund', kind: 'option', position: 1, label: zh ? '想退款' : 'I want a refund' },
      ...['f1', 'f2', 'f3', 'f4', 'f5'].map((id, at) => ({ parentId: 'failed', childId: id, kind: 'follow_up' as const, position: at, label: `Follow ${id}` })),
    ],
  }
}

describe('chat preview (graph design §5.3)', () => {
  test('click through an A/B choice and a follow-up exactly as Portal shows a click: fixed opening, the card, fixed closing, ≤ 4 chips', async () => {
    server.on('GET', '/api/helpdesk/faq-releases/preview', (call) => ({ data: preview(call.query.get('locale') as 'en-GB' | 'zh-CN') }))
    const dialog = await openTree()
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Chat preview' }))
    const log = await within(dialog).findByRole('log', { name: 'Preview conversation' })
    assert.equal(server.callsTo('GET', '/api/helpdesk/faq-releases/preview')[0].query.get('locale'), 'en-GB')
    assert.ok(within(log).getByText('A problem with paying?'))
    assert.ok(within(log).getByText('Which of these is it?'))
    const options = within(log).getByRole('list', { name: 'Which of these is it?' })
    assert.deepEqual(
      within(options).getAllByRole('button').map((button) => button.textContent),
      ['AIt failed', 'BI want a refund'],
    )
    fireEvent.click(within(options).getByRole('button', { name: /It failed/ }))
    const turns = () => within(log).getAllByRole('listitem').filter((item) => item.classList.contains('hdChatTurn'))
    await waitFor(() => assert.equal(turns().length, 2))
    const second = turns()[1]
    const texts = [...second.querySelectorAll('.hdChatAssistant > .hdChatText')].map((p) => p.textContent)
    assert.deepEqual(texts, ["Here's how to sort this out:", "If anything's unclear, just ask."])
    assert.ok(within(second).getByText('It failed'))
    assert.ok(within(second).getByText('From: My payment failed'))
    assert.equal(second.querySelector('.hdChatExcerpt strong')?.textContent, 'another card')
    const chips = within(second).getByRole('list', { name: 'You might also ask:' })
    assert.deepEqual(
      within(chips).getAllByRole('button').map((button) => button.textContent),
      ['Follow f1', 'Follow f2', 'Follow f3', 'Follow f4'],
    )
    assert.ok(within(second).getByText('1 more follow-ups are not shown (only the first 4 are).'))
    fireEvent.click(within(chips).getByRole('button', { name: 'Follow f2' }))
    await waitFor(() => assert.equal(turns().length, 3))
    assert.ok(within(turns()[2]).getByText('Answer f2'))
    // the other language: the same path, Chinese text and the Chinese fixed lines
    fireEvent.click(within(dialog).getByRole('radio', { name: '中文' }))
    await waitFor(() => assert.ok(within(dialog).getByText('你遇到的是哪种情况？')))
    assert.equal(server.callsTo('GET', '/api/helpdesk/faq-releases/preview').at(-1)?.query.get('locale'), 'zh-CN')
    assert.ok(within(dialog).getAllByText('好的，这个问题可以这样处理：').length >= 1)
    assert.ok(within(dialog).getByText('来自：付款失败怎么办'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start again' }))
    await waitFor(() => assert.equal(within(dialog).getAllByRole('listitem').filter((item) => item.classList.contains('hdChatTurn')).length, 1))
  })
})

/* ------------------------------- EventSource（jsdom 没有） ------------------------------- */

type FakeSource = { url: string; closed: boolean; push: (event: string, data: unknown) => void; emit: (event: string, raw: string) => void }
const realEventSource = (globalThis as { EventSource?: unknown }).EventSource

function installFakeEventSource(): FakeSource[] {
  const sources: FakeSource[] = []
  class FakeEventSource {
    url: string
    closed = false
    private listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>()
    constructor(url: string) {
      this.url = url
      const isClosed = () => this.closed
      sources.push({
        url,
        get closed() {
          return isClosed()
        },
        push: (event, data) => this.dispatch(event, JSON.stringify(data)),
        emit: (event, raw) => this.dispatch(event, raw),
      })
    }
    addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
    }
    close() {
      this.closed = true
    }
    private dispatch(type: string, data: string) {
      act(() => {
        for (const listener of this.listeners.get(type) ?? []) listener({ data } as MessageEvent<string>)
      })
    }
  }
  ;(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource
  return sources
}

function uninstallFakeEventSource() {
  if (realEventSource === undefined) delete (globalThis as { EventSource?: unknown }).EventSource
  else (globalThis as { EventSource?: unknown }).EventSource = realEventSource
}

/* ---------------------------------- 发布页 ---------------------------------- */

function release(version: number, patch: Partial<FaqRelease> = {}): FaqRelease {
  return {
    id: `r${version}`,
    version,
    status: 'superseded',
    checks: { passed: true, problems: [], counts: { nodes: 3, entries: 1, choices: 1, edges: 2, phrasings: 0 }, maxDepth: 1 },
    evalReport: { kind: 'retrieval', passed: true, summary: '', ranAt: '2026-10-29T10:00:00Z', metrics: { recallAt8: 0.9871, recallAt1: 0.9 }, misses: [] },
    sourceVersion: null,
    createdBy: null,
    createdAt: '2026-10-29T10:00:00Z',
    publishedBy: null,
    publishedAt: '2026-10-29T10:05:00Z',
    publishable: false,
    ...patch,
  }
}

const WORKING: FaqWorkingCopy = {
  published: 2,
  checks: {
    passed: false,
    problems: [{ rule: 'orphan', nodeId: 'n9', key: 'lonely', detail: 'orphan' }],
    counts: { nodes: 4, entries: 1, choices: 1, edges: 2, phrasings: 3 },
    maxDepth: 2,
  },
  diff: {
    nodes: {
      added: [{ id: 'n9', key: 'lonely', questionEn: 'A lonely question', questionZh: '孤立的问题' }],
      removed: [],
      changed: [{ id: 'pay', key: 'pay', questionEn: 'A problem with paying?', questionZh: '付款有问题？', fields: ['questionEn', 'signals'] }],
    },
    edges: {
      added: [{ parentId: 'pay', childId: 'n9', kind: 'option', position: 2, labelEn: null, labelZh: null }],
      removed: [],
      changed: [],
    },
    phrasings: { added: 3, removed: 0 },
    same: false,
  },
}

async function openReleases(role: 'ADMIN' | 'COURSE_CREATOR' = 'ADMIN', releases: FaqRelease[] = [release(1), release(2, { status: 'published' }), release(3, { status: 'draft', publishable: true, publishedAt: null })]) {
  serveFaqs(PAY)
  let list = releases
  server.on('GET', '/api/helpdesk/faq-releases', () => ({ data: { releases: list, published: list.find((r) => r.status === 'published')?.version ?? null } }))
  server.on('GET', '/api/helpdesk/faq-releases/working', { data: WORKING })
  const set = (next: FaqRelease[]) => {
    list = next
  }
  await renderHelpDesk(server, { role, path: '/en-GB/help-desk?tab=faqs' })
  fireEvent.click(screen.getByRole('button', { name: 'Releases' }))
  const dialog = await screen.findByRole('dialog', { name: 'Releases' })
  await within(dialog).findByText('Live: v2')
  return { dialog, set }
}

describe('publish a new version (graph design §5.4)', () => {
  test('the diff against the live version and the graph checks of the working copy', async () => {
    const { dialog } = await openReleases()
    assert.ok(within(dialog).getByText('Questions added (1)'))
    assert.ok(within(dialog).getByText('A lonely question'))
    assert.ok(within(dialog).getByText('Questions changed (1)'))
    assert.ok(within(dialog).getByText('(English question, situations)'))
    assert.ok(within(dialog).getByText('Links added (1)'))
    assert.ok(within(dialog).getByText('A problem with paying? → A lonely question'))
    assert.ok(within(dialog).getByText('Phrasings: 3 added, 0 removed'))
    assert.ok(within(dialog).getByText('1 problems to fix'))
    const problem = within(dialog).getByText(/Not an entry question, and no entry question leads here\./)
    assert.equal(problem.textContent, 'lonely: Not an entry question, and no entry question leads here.')
    // history, newest first, with the eval result
    const rows = within(dialog).getAllByRole('row').slice(1)
    assert.deepEqual(
      rows.map((row) => row.querySelector('th')?.textContent),
      ['v3', 'v2', 'v1'],
    )
    assert.ok(within(rows[1]).getByText('Live'))
    assert.ok(within(rows[0]).getByText('Passed, recall@8 98.7%'))
  })

  test('create a version, publish it after confirming, roll back to an older one after confirming', async () => {
    const { dialog, set } = await openReleases()
    server.on('POST', '/api/helpdesk/faq-releases', () => {
      set([release(1), release(2, { status: 'published' }), release(3, { status: 'draft', publishable: true, publishedAt: null }), release(4, { status: 'rejected', publishedAt: null })])
      return { status: 201, data: release(4, { status: 'rejected', publishedAt: null }) }
    })
    server.on('POST', /\/publish$/, () => ({ data: release(3, { status: 'published' }) }))
    server.on('POST', /\/rollback$/, () => ({ status: 201, data: release(5, { status: 'published', sourceVersion: 1 }) }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create new version' }))
    assert.equal((await within(dialog).findByRole('status')).textContent, 'v4 created.')
    assert.equal(server.callsTo('POST', '/api/helpdesk/faq-releases').length, 1)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish v3' }))
    const confirm = await screen.findByRole('alertdialog')
    assert.equal(confirm.textContent?.startsWith('Publish v3? Users will start seeing it'), true)
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => absent(screen.queryByRole('alertdialog')))
    assert.equal(server.callsTo('POST', /\/publish$/).length, 0)
    // cancelling returns focus to the button that opened the confirmation
    assert.ok(document.activeElement === within(dialog).getByRole('button', { name: 'Publish v3' }), 'focus')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish v3' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Publish' }))
    await waitFor(() => assert.equal(server.callsTo('POST', /\/publish$/).length, 1))
    assert.equal(server.callsTo('POST', /\/publish$/)[0].path, '/api/helpdesk/faq-releases/3/publish')
    assert.equal((await within(dialog).findByRole('status')).textContent, 'v3 is live.')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Roll back to v1' }))
    const rollback = await screen.findByRole('alertdialog')
    assert.ok(within(rollback).getByText('Roll back to v1? Its content is published again as a new version.'))
    fireEvent.click(within(rollback).getByRole('button', { name: 'Roll back' }))
    await waitFor(() => assert.equal(server.callsTo('POST', /\/rollback$/)[0]?.path, '/api/helpdesk/faq-releases/1/rollback'))
    assert.equal((await within(dialog).findByRole('status')).textContent, 'Rolled back: v5 is live.')
  })

  test('creating with no changes says so; a failed publish shows the reason; a version’s own changes open inline', async () => {
    const { dialog } = await openReleases()
    server.on('POST', '/api/helpdesk/faq-releases', { data: release(3, { status: 'draft', publishable: true, publishedAt: null }) })
    server.on('POST', /\/publish$/, { status: 409, error: 'FAQ_RELEASE_NOT_READY' })
    server.on('GET', /\/faq-releases\/2\/diff$/, {
      data: { base: 1, head: 2, diff: { ...WORKING.diff, nodes: { added: [], removed: [{ id: 'x', key: 'x', questionEn: 'Old question', questionZh: '旧问题' }], changed: [] }, edges: { added: [], removed: [], changed: [] }, phrasings: { added: 0, removed: 0 } } },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create new version' }))
    assert.equal((await within(dialog).findByRole('status')).textContent, 'Nothing changed since v3, so no new version was created.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish v3' }))
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Publish' }))
    assert.equal(
      (await within(dialog).findByRole('alert')).textContent,
      'This version has not passed the checks and the eval, so it cannot be published.',
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Changes in v2' }))
    assert.ok(await within(dialog).findByText('Questions removed (1)'))
    assert.ok(within(dialog).getByText('Old question'))
  })

  test('a background check shows its progress; the open drawer stays connected and the server pushes the result (no re-reading)', async () => {
    const sources = installFakeEventSource()
    try {
      const running = release(3, {
        status: 'evaluating',
        publishedAt: null,
        evalReport: null,
        evaluation: { state: 'running', startedAt: '2026-11-03T10:00:00Z', progress: { stage: 'model', done: 120, total: 300 } },
      })
      const { dialog } = await openReleases('ADMIN', [release(1), release(2, { status: 'published' }), running])
      assert.ok(within(dialog).getByText('Checking: live pipeline 120 / 300'))
      assert.ok(within(dialog).getByText('Checking'))
      // still running: no second check can be started
      absent(within(dialog).queryByRole('button', { name: /^Check again/ }))
      // one long connection to the release stream
      assert.deepEqual(
        sources.map((source) => source.url),
        ['/api/helpdesk/faq-releases/stream'],
      )
      const model = {
        kind: 'model',
        passed: true,
        summary: 'Live-pipeline sample passed (model): …',
        ranAt: '2026-11-03T10:04:00Z',
        metrics: { wrongRate: 0.01, cases: 300, costUsd: 0.12 },
        misses: [],
      } as const
      const reads = server.callsTo('GET', '/api/helpdesk/faq-releases').length
      sources[0].push('releases', {
        releases: [running, release(2, { status: 'published' }), release(1)].map((r) =>
          r.version === 3 ? { ...r, evaluation: { ...r.evaluation!, progress: { stage: 'model', done: 210, total: 300 } } } : r,
        ),
        published: 2,
      })
      await within(dialog).findByText('Checking: live pipeline 210 / 300')
      sources[0].push('releases', {
        releases: [
          release(3, {
            status: 'draft',
            publishable: true,
            publishedAt: null,
            evaluation: null,
            evalReport: {
              kind: 'combined',
              passed: true,
              summary: '',
              ranAt: '2026-11-03T10:04:00Z',
              metrics: { recallAt8: 0.9871 },
              misses: [],
              parts: [{ kind: 'retrieval', passed: true, summary: '', ranAt: '2026-11-03T10:01:00Z', metrics: { recallAt8: 0.9871 }, misses: [] }, model],
            },
          }),
          release(2, { status: 'published' }),
          release(1),
        ],
        published: 2,
      })
      await within(dialog).findByText(/^Live-pipeline check Passed: wrong card 1\.0%, 300 questions, about ¥0\.86/)
      absent(within(dialog).queryByText(/^Checking: /))
      // pushed, not re-read
      assert.equal(server.callsTo('GET', '/api/helpdesk/faq-releases').length, reads)
      // a broken frame is ignored
      sources[0].emit('releases', '{not json')
      assert.ok(within(dialog).getByText(/^Live-pipeline check Passed/))
      // closing the drawer closes the connection
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
      await waitFor(() => assert.equal(sources[0].closed, true))
    } finally {
      uninstallFakeEventSource()
    }
  })

  test('a check whose heartbeat stopped shows Check interrupted and can be checked again', async () => {
    const interrupted = release(3, {
      status: 'evaluating',
      publishedAt: null,
      evalReport: null,
      evaluation: { state: 'interrupted', startedAt: '2026-11-03T10:00:00Z', progress: { stage: 'model', done: 40, total: 300 } },
    })
    const { dialog } = await openReleases('ADMIN', [release(1), release(2, { status: 'published' }), interrupted])
    assert.ok(within(dialog).getByText('Check interrupted'))
    assert.ok(within(dialog).getByText(/^The check did not finish/))
    server.on('POST', /\/faq-releases\/3\/check$/, {
      data: release(3, { status: 'evaluating', publishedAt: null, evalReport: null, evaluation: { state: 'running', startedAt: '2026-11-03T10:10:00Z', progress: null } }),
    })
    fireEvent.click(within(dialog).getByRole('button', { name: /^Check again/ }))
    await waitFor(() => assert.equal(server.callsTo('POST', /\/faq-releases\/3\/check$/).length, 1))
    assert.ok(await within(dialog).findByText('v3 is being checked again.'))
  })

  test('VIEW roles see the versions and the changes but no Create, Publish, Check again or Roll back', async () => {
    const { dialog } = await openReleases('COURSE_CREATOR', [release(1), release(2, { status: 'published' }), release(3, { status: 'rejected', publishedAt: null })])
    assert.ok(within(dialog).getByText('Questions added (1)'))
    for (const name of [/^Create new version/, /^Publish v/, /^Check again/, /^Roll back/])
      absent(within(dialog).queryByRole('button', { name }), String(name))
    assert.ok(within(dialog).getByRole('button', { name: 'Changes in v1' }))
  })
})
