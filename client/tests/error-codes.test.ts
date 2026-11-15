import test from 'node:test'
import assert from 'node:assert/strict'

import { boRequest } from '../src/backoffice/lib/api'

// BUG-0329：服务端已返回 LAST_ADMIN，但客户端只认识 KNOWN_ERRORS 里的码，
// 未知码会被折叠成 INTERNAL_ERROR，界面上只剩“系统出现异常，请重试”。
async function withFetchJson(body: unknown, status: number, run: () => Promise<void>) {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
}

test('a last-admin rejection reaches the page with its own code', async () => {
  await withFetchJson(
    { success: false, error: { code: 'LAST_ADMIN', message: 'Keep one admin' } },
    409,
    async () => {
      const result = await boRequest('/api/admin/employees/x', { method: 'PATCH' })
      assert.equal(result.success, false)
      assert.equal(result.error, 'LAST_ADMIN')
    },
  )
})

test('an unknown code still falls back to INTERNAL_ERROR', async () => {
  await withFetchJson(
    { success: false, error: { code: 'SOMETHING_NEW' } },
    500,
    async () => {
      const result = await boRequest('/api/admin/employees/x')
      assert.equal(result.error, 'INTERNAL_ERROR')
    },
  )
})
