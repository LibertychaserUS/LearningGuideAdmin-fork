import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { localizedName, pickLocalized, type Localized } from '../src/backoffice/lib/i18n/localized'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const fixture = JSON.parse(read('./fixtures/localized.cases.json')) as {
  localized: Localized<'name'>
  fallback: string
  cases: Array<{ language: string; expected: string; why: string }>
  withoutDefault: { localized: Localized<'name'>; language: string; expected: string }
}

test('uses the same cases as the server', () => {
  assert.equal(read('./fixtures/localized.cases.json'), read('../../server/src/common/i18n/localized.cases.json'))
})

for (const c of fixture.cases) {
  test(`${c.language} -> ${c.expected} (${c.why})`, () => {
    assert.equal(pickLocalized(fixture.localized, 'name', c.language, fixture.fallback), c.expected)
  })
}

test('falls back to the key when neither the language nor en-GB has text', () => {
  const w = fixture.withoutDefault
  assert.equal(pickLocalized(w.localized, 'name', w.language, fixture.fallback), w.expected)
})

test('shows a category in the current language from its stored names', () => {
  const society = { name: 'Society', localized: { 'en-GB': { name: 'Society' }, 'zh-CN': { name: '社会' } } }
  assert.equal(localizedName('zh-CN', society), '社会')
  assert.equal(localizedName('en-GB', society), 'Society')
  assert.equal(localizedName('zh-CN', { name: 'Imported', localized: {} }), 'Imported')
  assert.equal(localizedName('zh-CN', null), '')
})
