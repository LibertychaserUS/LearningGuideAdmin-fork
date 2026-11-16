import './support/dom'

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { HistoryItem } from '../src/backoffice/contracts/course'
import { historyActionLabel, historyDetailText } from '../src/backoffice/pages/course-editor/versionHistory';

function item(action: string, detail: unknown, versionNo: number | null = null): HistoryItem {
  return {
    id: 'h1',
    time: '2026-10-20T10:00:00.000Z',
    operator: 'Jack',
    action,
    versionNo,
    detail,
  }
}

describe('course editor history formatting', () => {
  test('formats publish details with source and learner notification', () => {
    const text = historyDetailText(
      item('PUBLISH', { versionLabel: 'Version 4', sourceEnvironment: 'UAT', sourceVersionLabel: 'Version 3', notifyLearners: true }),
      'en-GB',
    )
    assert.equal(text, 'Version 4 · from UAT Version 3 · learners notified')
  })

  test('formats status changes with reason', () => {
    const text = historyDetailText(item('CHANGE_STATUS', { from: 'ONLINE', to: 'HIDDEN', reason: 'Reviewing materials' }), 'en-GB')
    // PRD §21 使用人类可读状态名（Online / Hidden），不是原始枚举。
    assert.equal(text, 'Online → Hidden · Reviewing materials')
  })

  test('formats restore and delete draft details', () => {
    assert.equal(historyDetailText(item('RESTORE', { restoredFrom: 'Version 2' }), 'zh-CN'), '从 Version 2 恢复')
    assert.equal(historyDetailText(item('DELETE_DRAFT', { keptVersion: 'Version 4' }), 'en-GB'), 'Kept Version 4')
  })

  test('falls back to readable key/value pairs for unknown details', () => {
    assert.equal(historyDetailText(item('UNKNOWN', { foo: 'bar', empty: null }), 'en-GB'), 'foo: bar · empty: —')
  })

  test('localizes known action labels', () => {
    assert.equal(historyActionLabel('PUBLISH', 'en-GB'), 'Publish')
    assert.equal(historyActionLabel('CHANGE_STATUS', 'zh-CN'), '更改状态')
    assert.equal(historyActionLabel('CUSTOM_ACTION', 'en-GB'), 'CUSTOM_ACTION')
  })
})
