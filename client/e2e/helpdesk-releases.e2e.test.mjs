// 浏览器 E2E（真 Chromium + Vite dev server，API 全部在浏览器里假装）：锁住发布前的后台检查（owner 2026-11-03
// 选「抽样跑测试集」，v2 起问全部题）在版本历史里 jsdom 测不到的部分：
// ① 检查中：状态「Checking」，结果栏显示进度（真流程检查 n / 300），表格不横向滚动；不能再开一次检查；
// ② 抽屉开着一直连着版本列表的长连接（SSE，真的 EventSource），服务端推进度与结果，页面不重读列表；
//    出结果后显示真流程检查那一行（错卡率、题数、约 ¥）。这里每次连接答一帧就断，浏览器按 retry 自己重连，
//    所以也锁住了「断了会自己连回来」；
// ③ 心跳停了：「Check interrupted」+ 提示，可以「Check again」。
// 运行：npm run test:e2e:helpdesk（本地跑，CI 不装浏览器）。E2E_SHOTS=<目录> 时保存截图。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))
const shots = process.env.E2E_SHOTS
let server
let browser
let base

before(async () => {
  server = await createServer({ root, logLevel: 'error', server: { port: 0, strictPort: false, host: '127.0.0.1' } })
  await server.listen()
  base = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
  await server?.close()
})

const JACK = { employeeId: '0192aaaa-0000-7000-8000-0000000000e1', loginEmail: 'jack@example.com', role: 'ADMIN', displayName: 'jack', accountStatus: 'ACTIVE', emailVerification: 'VERIFIED', displayStatus: 'Active', isBootstrapAdmin: false }
const ok = (data) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data, error: null }) })
const checks = { passed: true, problems: [], counts: { nodes: 650, entries: 198, choices: 40, edges: 471, phrasings: 2600 }, maxDepth: 3 }
const retrieval = { kind: 'retrieval', passed: true, summary: '', ranAt: '2026-11-03T09:01:00Z', metrics: { recallAt8: 0.9871, recallAt1: 0.91 }, misses: [] }

function release(version, patch = {}) {
  return {
    id: `r${version}`, version, status: 'superseded', checks, evalReport: retrieval, sourceVersion: null, createdBy: null,
    createdAt: `2026-11-0${version}T09:00:00Z`, publishedBy: null, publishedAt: `2026-11-0${version}T09:05:00Z`, publishable: false, ...patch,
  }
}

const model = {
  kind: 'model', passed: true, summary: 'Live-pipeline check passed (model): wrong card 1.0% over 300 questions.', ranAt: '2026-11-03T09:04:00Z',
  metrics: { cases: 300, wrongCards: 3, wrongRate: 0.01, errors: 0, costUsd: 0.13 }, misses: [],
}
const running = (done) => release(3, { status: 'evaluating', publishedAt: null, evalReport: null, evaluation: { state: 'running', startedAt: '2026-11-03T09:00:00Z', progress: { stage: 'model', done, total: 300 } } })
const finished = release(3, {
  status: 'draft', publishable: true, publishedAt: null, evaluation: null,
  evalReport: { kind: 'combined', passed: true, summary: '', ranAt: '2026-11-03T09:04:00Z', metrics: { recallAt8: 0.9871 }, misses: [], parts: [retrieval, model] },
})
const interrupted = release(3, { status: 'evaluating', publishedAt: null, evalReport: null, evaluation: { state: 'interrupted', startedAt: '2026-11-03T09:00:00Z', progress: { stage: 'model', done: 40, total: 300 } } })
const WORKING = { published: 2, checks, diff: { nodes: { added: [], removed: [], changed: [] }, edges: { added: [], removed: [], changed: [] }, phrasings: { added: 0, removed: 0 }, same: true } }

async function open(third, locale = 'en-GB', working = WORKING) {
  const page = await browser.newPage({ viewport: { width: 1672, height: 941 } })
  const state = { third, reads: 0, streams: 0 }
  await page.route((url) => url.pathname.startsWith('/api/'), (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/session') return route.fulfill(ok({ employee: JACK, sidebarState: 'expanded' }))
    if (url.pathname === '/api/helpdesk/tickets') return route.fulfill(ok({ tickets: [], nextCursor: null, counts: {} }))
    if (url.pathname === '/api/helpdesk/faqs') return route.fulfill(ok({ faqs: [], total: 0, page: 1, pageSize: 10 }))
    if (url.pathname === '/api/helpdesk/faq-releases/stream') {
      state.streams += 1
      const body = JSON.stringify({ releases: [state.third, release(2, { status: 'published' }), release(1)], published: 2 })
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `retry: 200\n\nevent: releases\ndata: ${body}\n\n` })
    }
    if (url.pathname === '/api/helpdesk/faq-releases') {
      state.reads += 1
      return route.fulfill(ok({ releases: [state.third, release(2, { status: 'published' }), release(1)], published: 2 }))
    }
    if (url.pathname === '/api/helpdesk/faq-releases/working') return route.fulfill(ok(working))
    if (url.pathname === '/api/helpdesk/faq-releases/3/check' && route.request().method() === 'POST') {
      state.third = running(0)
      return route.fulfill(ok(running(0)))
    }
    return route.fulfill(ok({}))
  })
  await page.goto(`${base}/${locale}/help-desk?tab=faqs`)
  const zh = locale === 'zh-CN'
  await page.getByRole('button', { name: zh ? '版本发布' : 'Releases', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: zh ? '版本发布' : 'Releases' })
  await dialog.getByText(locale === 'zh-CN' ? /v2/ : 'Live: v2').first().waitFor()
  return { page, dialog, state }
}

const v3 = (page, dialog) => dialog.locator('tr', { has: page.locator('th', { hasText: /^v3$/ }) })

async function shot(page, name) {
  if (shots) await page.waitForTimeout(400)
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false })
}

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)

test('a running check shows its progress; the stream pushes the next progress and the result without re-reading the list', async () => {
  const { page, dialog, state } = await open(running(120))
  const row = v3(page, dialog)
  await row.getByText('Checking: live pipeline 120 / 300').waitFor()
  assert.equal(await row.locator('.hdReleaseStatus').textContent(), 'Checking')
  assert.equal(await row.getByRole('button', { name: /^Check again/ }).count(), 0)
  assert.equal(await noSideScroll(page), true)
  await shot(page, 'release-check-running')
  const readsAtOpen = state.reads // 打开时读的（开发模式 StrictMode 会读两次）
  // 服务端往前走了：推过来，不用点任何东西
  state.third = running(210)
  await row.getByText('Checking: live pipeline 210 / 300').waitFor({ timeout: 8000 })
  state.third = finished
  await row.getByText(/^Live-pipeline check Passed: wrong card 1\.0%, 300 questions, about ¥0\.94/).waitFor({ timeout: 8000 })
  assert.equal(await row.locator('.hdReleaseStatus').textContent(), 'Ready')
  // 打开之后列表一次都没再读，全靠长连接（还重连过）
  assert.equal(state.reads, readsAtOpen)
  assert.ok(state.streams >= 2, `stream connections: ${state.streams}`)
  await shot(page, 'release-check-finished')
  await page.close()
})

test('an interrupted check says so and can be checked again', async () => {
  const { page, dialog, state } = await open(interrupted)
  const row = v3(page, dialog)
  assert.equal(await row.locator('.hdReleaseStatus').textContent(), 'Check interrupted')
  await row.getByText(/^The check did not finish/).waitFor()
  await shot(page, 'release-check-interrupted')
  await row.getByRole('button', { name: /^Check again/ }).click()
  await dialog.getByText('v3 is being checked again.').waitFor()
  assert.equal(state.third.evaluation.state, 'running')
  await row.getByText('Checking: live pipeline 0 / 300').waitFor()
  await page.close()
})

test('zh-CN: the finished check reads 真流程检查通过：错卡 1.0%，300 题，约 ¥0.94', async () => {
  const { page, dialog } = await open(finished, 'zh-CN')
  const row = v3(page, dialog)
  await row.getByText('真流程检查通过：错卡 1.0%，300 题，约 ¥0.94').waitFor()
  assert.equal(await row.locator('.hdReleaseStatus').textContent(), '待发布')
  await shot(page, 'release-check-finished-zh-CN')
  await page.close()
})

// release check v2：全部题、套件与切片、按轻重排好的问题、花费与缓存、重复问法；开始前的估计
// as policy.ts: combined and S650 use the 95% upper bound, slices the point rate, the rest only 'not worse than live'
const ruleOf = (id) => (id.includes(':') ? 'point' : id === 'combined' || id === 's650' ? 'interval' : 'paired')
const suite = (id, label, status, n, wrongRate, wrongRateHigh, extra = {}) => ({
  id, label, status, rule: ruleOf(id), passed: true, n, reasons: [], metrics: { wrongRate, wrongRateHigh, confirmedWorse: 0, scored: n }, ...extra,
})
const v2Model = {
  kind: 'model', passed: false, ranAt: '2026-11-06T09:04:00Z',
  summary: 'Live-pipeline check failed (google/gemma-4-31b-it): 1 question(s) newly wrong against the live version',
  metrics: {
    cases: 1684, wrongCards: 9, wrongRate: 0.0054, wrongRateHigh: 0.0101, errors: 0, timeouts: 2, confirmedWorse: 1,
    followupCases: 12, costUsd: 0.0613, costModelUsd: 0.0521, costRerankUsd: 0.0079, costEmbedUsd: 0.0013,
    costCandidateUsd: 0.0402, costLiveUsd: 0.0011, costChecksUsd: 0.02, savedUsd: 0.7712, paidQuestions: 91,
    cacheStepHits: 3290, cacheStepMisses: 91, cacheRerankHits: 3301, cacheRerankMisses: 80, cacheEmbedHits: 3360, cacheEmbedMisses: 21,
    driftChecked: 40, driftChanged: 0, unpricedCalls: 0,
  },
  suites: [
    suite('combined', 'All questions', 'gate', 1684, 0.0054, 0.0101, { passed: false, reasons: ['1 question(s) newly wrong against the live version'], metrics: { wrongRate: 0.0054, wrongRateHigh: 0.0101, confirmedWorse: 1, scored: 1684 } }),
    suite('s650', 'S650 (written per card)', 'gate', 1409, 0.0043, 0.0093),
    suite('blind', 'Blind (written without seeing cards)', 'track', 275, 0.0109, 0.0316),
    suite('followup', 'Follow-ups (parent card on screen)', 'track', 12, 0, 0.2425),
    suite('changed', 'Questions on changed cards', 'track', 41, 0.0244, 0.1259),
    suite('multi', 'Several asks in one message', 'track', 118, 0.0424, 0.0957, {
      metrics: { wrongRate: 0.0424, wrongRateHigh: 0.0957, confirmedWorse: 0, scored: 118, asks: 207, asksCovered: 157, askCoverage: 0.7585, allCovered: 74, strayCards: 5, ordered: 66, inOrder: 65, noCardAsks: 32, missedSaid: 9 },
    }),
    suite('language:en-GB', 'Language en-GB', 'gate', 530, 0.0038, 0.0137),
    suite('language:zh-CN', 'Language zh-CN', 'gate', 640, 0.0047, 0.0137),
    suite('language:zh-TW', 'Language zh-TW', 'gate', 330, 0.0091, 0.0264),
    suite('style:typo', 'Style typo', 'track', 150, 0.0133, 0.0473),
  ],
  misses: [
    { id: 's650-0412', set: 's650', locale: 'zh-CN', text: '续费前会提醒我吗', expected: 'renewal-reminder', got: 'answer:cancel-subscription', live: 'answer:renewal-reminder', why: 'newly_wrong' },
    { id: 'followup:bw1-118', set: 'followup', locale: 'en-GB', text: 'and if it still says locked?', expected: 'paid-not-unlocked--still-locked', got: 'answer:refund', live: 'answer:refund', onScreen: 'paid-not-unlocked', why: 'wrong_card' },
    { id: 'bw1-207', set: 'blind', locale: 'en-GB', text: 'how long does a refund take to show up', expected: 'refund-timing', got: 'error:timeout', live: 'answer:refund-timing', why: 'timeout' },
  ],
  receipt: { model: 'google/gemma-4-31b-it', questions: 1696, devSet: 'eval-v6-dev', wrongRateMax: 0.02, sliceMin: 200, liveVersion: 2 },
  collisions: [
    { similarity: 0.981, added: { key: 'cancel-subscription', text: '怎么取消自动续费', source: 'phrasing' }, other: { key: 'turn-off-auto-renewal', text: '怎么关掉自动续费', source: 'phrasing' }, byState: false },
    { similarity: 0.962, added: { key: 'subscription-expired', text: 'my course will not open', source: 'phrasing' }, other: { key: 'paid-not-unlocked', text: 'my course won’t open', source: 'phrasing' }, byState: true },
  ],
}
const checkedV2 = release(3, {
  status: 'rejected', publishedAt: null, evaluation: null,
  evalReport: { kind: 'combined', passed: false, summary: '', ranAt: '2026-11-06T09:04:00Z', metrics: { recallAt8: 0.9871 }, misses: [], parts: [retrieval, v2Model] },
})
const workingWithEstimate = {
  ...WORKING,
  diff: { ...WORKING.diff, nodes: { added: [], removed: [], changed: [{ id: 'n1', key: 'refund', questionEn: 'How do I get a refund?', questionZh: '怎么退款？', fields: ['answerEn'] }] }, same: false },
  estimate: { questions: 1696, single: 1684, followups: 12, touchedCards: 1, paid: 91, usd: 0.0455, budgetUsd: 3, basis: 'last_check' },
}

test('v2: the estimate shows before the check starts, and the check details open as one module with tabs', async () => {
  const { page, dialog } = await open(checkedV2, 'en-GB', workingWithEstimate)
  await dialog.getByText('About 1696 questions (1684 single, 12 follow-ups); about 91 need asking again, about ¥0.33 (cap ¥22).').waitFor()
  const row = v3(page, dialog)
  await row.getByRole('button', { name: 'Check details' }).click()
  const details = dialog.getByRole('region', { name: 'Live-pipeline check details' })
  const tabs = details.getByRole('tab')
  assert.deepEqual(await tabs.allTextContents(), ['Suites', 'Slices', 'Questions 3', 'Spend', 'Duplicate wording 2'])
  await details.getByRole('rowheader', { name: 'All single questions' }).waitFor()
  await details.getByRole('rowheader', { name: 'Follow-ups (parent card on screen)' }).waitFor()
  assert.equal(await details.getByRole('rowheader', { name: 'Language zh-TW' }).count(), 0)
  // the reason is written from the numbers and the limits in the report, in the page language
  await details.getByText('1 newly wrong against the live version').waitFor()
  // several asks in one message: tracked, with the per-ask numbers on one line
  await details.getByRole('rowheader', { name: 'Several asks in one message' }).waitFor()
  await details.getByText('Card per ask 75.8% (157 of 207); 5 card(s) for no ask; in the order asked 65 of 66').waitFor()
  await details.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await shot(page, 'release-check-v2-suites')
  await details.getByRole('tab', { name: 'Slices' }).click()
  await details.getByRole('rowheader', { name: 'Language zh-TW' }).waitFor()
  await details.getByText('Under 200 questions, so tracked only').waitFor()
  await details.getByRole('tab', { name: 'Questions 3' }).click()
  await details.getByText('On screen: paid-not-unlocked').waitFor()
  await details.getByRole('cell', { name: 'Newly wrong' }).waitFor()
  await shot(page, 'release-check-v2-questions')
  // arrow keys move between tabs
  await details.getByRole('tab', { name: 'Questions 3' }).press('ArrowRight')
  assert.equal(await details.getByRole('tab', { name: 'Spend' }).getAttribute('aria-selected'), 'true')
  await details.getByText('91 questions asked for real; Drift check: 0 of 40 differed from the cache').waitFor()
  await shot(page, 'release-check-v2-spend')
  await details.getByRole('tab', { name: 'Duplicate wording 2' }).click()
  await details.getByText('The two cards are told apart by user state; likely intended').waitFor()
  await shot(page, 'release-check-v2-duplicates')
  // one module: the panel scrolls inside, the drawer does not grow sideways
  const panel = details.getByRole('tabpanel')
  assert.ok((await panel.evaluate((el) => el.getBoundingClientRect().height)) <= 281)
  assert.equal(await noSideScroll(page), true)
  await row.getByRole('button', { name: 'Hide details' }).click()
  assert.equal(await details.count(), 0)
  await page.close()
})

test('zh-CN v2: 估计与检查详情', async () => {
  const { page, dialog } = await open(checkedV2, 'zh-CN', workingWithEstimate)
  await dialog.getByText('预计问 1696 道题（单问 1684、追问 12）；约 91 道要真问，约 ¥0.33（上限 ¥22）。').waitFor()
  const row = v3(page, dialog)
  await row.getByRole('button', { name: '检查详情' }).click()
  const details = dialog.getByRole('region', { name: '真流程检查详情' })
  await details.getByRole('rowheader', { name: '全部单问' }).waitFor()
  await details.getByText('比线上新错 1 道').waitFor()
  assert.equal(await details.getByText('newly wrong against the live version').count(), 0)
  await details.getByRole('rowheader', { name: '一句问了几件事' }).waitFor()
  await details.getByText('每件事给到卡 75.8%（157/207）；多给错卡 5 张；按问的顺序 65/66').waitFor()
  await details.getByRole('rowheader', { name: '一句问了几件事' }).scrollIntoViewIfNeeded()
  await shot(page, 'release-check-v2-multi-zh-CN')
  await details.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await shot(page, 'release-check-v2-suites-zh-CN')
  await details.getByRole('tab', { name: '切片' }).click()
  await details.getByText('不到 200 题，只看不拦').waitFor()
  await shot(page, 'release-check-v2-slices-zh-CN')
  await details.getByRole('tab', { name: '花费' }).click()
  await details.getByText('真问了 91 道；漂移抽查：40 道里 0 道和缓存不一样').waitFor()
  await shot(page, 'release-check-v2-spend-zh-CN')
  await page.close()
})
