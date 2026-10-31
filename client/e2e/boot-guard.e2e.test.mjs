// 浏览器 E2E（真 Chromium + 构建产物 dist/）：发布后白屏的启动守护（index.html 里的 lg-boot-guard）。
// 背景（2026-10-31，HelpDesk 每次 dev 发布后打开是白屏，要强刷才出来）：发布时新旧实例短暂并存，
// 入口文档引用的带哈希脚本取不到——旧实例上没有新文件（以前还会被回成 index.html，200 text/html），
// 或开着的旧文档去取已下线的旧文件——浏览器拒绝执行，#root 一直是空的。
// 锁住：① 脚本一次取不到（404 或拿到 HTML）→ 自动重新加载，页面正常出来，计数清零；
//       ② 一直取不到 → 最多重试 4 次后显示说明和「重新加载」按钮，不死循环、不白屏；
//       ③ 正常加载不会多刷新一次。
// 运行：npm run build && node --test e2e/boot-guard.e2e.test.mjs（本地跑；云端 PW_CHROMIUM=/opt/pw-browsers/chromium）。
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

const dist = fileURLToPath(new URL('../dist', import.meta.url))
if (!existsSync(join(dist, 'index.html'))) throw new Error('先运行 npm run build（本测试用构建产物）')
const indexHtml = readFileSync(join(dist, 'index.html'), 'utf8')
const entryScript = indexHtml.match(/<script type="module"[^>]*src="([^"]+)"/)[1]

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' }

/** 每个用例改这里：入口脚本前 failures 次怎么失败（'html' = 旧实例回 index.html，'404'）。 */
let scenario = { failures: 0, how: '404' }
let documents = 0
let scriptHits = 0

let server
let browser
let base

before(async () => {
  server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    if (path.startsWith('/api/')) {
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end('{"message":"unauthorized"}')
    }
    if (path === entryScript) {
      scriptHits += 1
      if (scriptHits <= scenario.failures) {
        if (scenario.how === 'html') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          return res.end(indexHtml)
        }
        res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
        return res.end('Not found')
      }
    }
    const file = normalize(join(dist, path))
    if (file.startsWith(dist) && extname(file) && existsSync(file)) {
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
      return res.end(readFileSync(file))
    }
    // 只数真正的页面加载（图片等找不到的路径也会落到这里）
    if (req.headers['sec-fetch-dest'] === 'document') documents += 1
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(indexHtml)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  const executablePath = process.env.PW_CHROMIUM || undefined
  browser = await chromium.launch(executablePath ? { executablePath, args: ['--headless=new', '--no-sandbox'] } : {})
})

after(async () => {
  await browser?.close()
  await new Promise((resolve) => server?.close(resolve))
})

async function open(next) {
  scenario = next
  documents = 0
  scriptHits = 0
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`${base}/zh-CN/help-desk`)
  return { page, context }
}

/** 应用真的渲染出来了（#root 有内容，且不是守护的失败说明）。API 一律 401，这里不关心具体是哪一屏。 */
const appShown = (page) =>
  page.waitForFunction(() => {
    const root = document.getElementById('root')
    return Boolean(root && root.firstElementChild && !root.querySelector('[data-lg-boot-failed]'))
  }, null, { timeout: 15_000 })

const retryState = (page) => page.evaluate(() => sessionStorage.getItem('lg.boot-retry'))

test('正常加载：不多刷新，页面直接出来', async () => {
  const { page, context } = await open({ failures: 0, how: '404' })
  await appShown(page)
  await page.waitForTimeout(9_000) // 越过 8 秒空白检查
  assert.equal(documents, 1)
  assert.equal(await retryState(page), null)
  await context.close()
})

for (const how of ['html', '404']) {
  test(`脚本取不到一次（${how === 'html' ? '旧实例回成 index.html' : '404'}）：自动重新加载后正常显示并清零`, async () => {
    const { page, context } = await open({ failures: 1, how })
    await appShown(page)
    assert.equal(documents, 2, '只多加载了一次入口文档')
    assert.equal(await page.locator('[data-lg-boot-failed]').count(), 0)
    await page.waitForTimeout(9_000)
    assert.equal(await retryState(page), null, '页面正常后重试计数清零')
    await context.close()
  })
}

test('一直取不到：重试 4 次后显示说明和「重新加载」，不死循环', { timeout: 90_000 }, async () => {
  const { page, context } = await open({ failures: 1_000, how: 'html' })
  const failed = page.locator('[data-lg-boot-failed]')
  await failed.waitFor({ timeout: 60_000 })
  assert.equal(documents, 5, '首次 + 4 次重试')
  assert.match(await failed.innerText(), /页面没有加载完整/)
  await page.waitForTimeout(3_000)
  assert.equal(documents, 5, '放弃后不再自动刷新')

  // 发布结束后点「重新加载」就能出来
  scenario = { failures: 0, how: 'html' }
  await failed.getByRole('button', { name: '重新加载' }).click()
  await appShown(page)
  await context.close()
})
