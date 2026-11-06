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

async function open(third, locale = 'en-GB') {
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
    if (url.pathname === '/api/helpdesk/faq-releases/working') return route.fulfill(ok(WORKING))
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
