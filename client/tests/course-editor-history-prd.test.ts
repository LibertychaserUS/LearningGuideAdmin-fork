import './support/dom'

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { HistoryItem } from '../src/backoffice/contracts/course'
import { historyActionLabel, historyDetailText } from '../src/backoffice/pages/course-editor/versionHistory'

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

/**
 * PRD §21 History Detail 的八种形态（逐字基准）。
 * 服务端 detail 使用真实写入的字段名，前端负责渲染成 PRD 文案。
 */
describe('History copy matches PRD §21 (all eight actions)', () => {
  test('CREATE_COURSE renders code · learning mode · language / source package', () => {
    assert.equal(
      historyDetailText(
        item('CREATE_COURSE', {
          code: 'C001',
          learningMode: 'VIDEO_AND_TEXT',
          learningLanguages: ['en-GB'],
          sourcePackage: 'C001_1.3.zip',
        }),
        'en-GB',
      ),
      'C001 · Video and Text · English / Created from package C001_1.3.zip',
    )
  })

  test('CREATE_COURSE from a blank course omits the source package segment', () => {
    assert.equal(
      historyDetailText(
        item('CREATE_COURSE', {
          code: 'C001',
          learningMode: 'VIDEO_AND_TEXT',
          learningLanguages: ['en-GB'],
        }),
        'en-GB',
      ),
      'C001 · Video and Text · English',
    )
  })

  test('IMPORT_PACKAGE renders "Draft replaced · 文件名"', () => {
    assert.equal(
      historyDetailText(item('IMPORT_PACKAGE', { from: 'Draft', to: 'C001_4.2.zip' }), 'en-GB'),
      'Draft replaced · C001_4.2.zip',
    )
  })

  test('EXPORT_PACKAGE renders version and the next publish series', () => {
    assert.equal(
      historyDetailText(
        item('EXPORT_PACKAGE', { versionLabel: '3.4', nextVersionLabel: '4.1' }),
        'en-GB',
      ),
      'Version 3.4 · next publish starts 4.1',
    )
  })

  test('PUBLISH renders original → new version and learner notification', () => {
    assert.equal(
      historyDetailText(
        item('PUBLISH', {
          from: 'Version 3',
          to: 'Version 4',
          versionLabel: 'Version 4',
          notifyLearners: true,
        }),
        'en-GB',
      ),
      'Version 3 → Version 4 · learners notified',
    )
    assert.equal(
      historyDetailText(
        item('PUBLISH', {
          from: 'Version 3',
          to: 'Version 4',
          versionLabel: 'Version 4',
          notifyLearners: false,
        }),
        'en-GB',
      ),
      'Version 3 → Version 4',
    )
  })

  test('DELETE_DRAFT renders "Draft → Version N"', () => {
    assert.equal(
      historyDetailText(
        item('DELETE_DRAFT', { from: 'Draft', to: 'Version 3', keptVersion: 'Version 3' }),
        'en-GB',
      ),
      'Draft → Version 3',
    )
  })

  test('RESTORE renders "Version N → draft" with a lowercase draft', () => {
    assert.equal(
      historyDetailText(
        item('RESTORE', { from: 'Version 1', to: 'draft', restoredFrom: 'Version 1' }),
        'en-GB',
      ),
      'Version 1 → draft',
    )
    // 旧记录仍写 'Draft'：渲染层统一按 PRD 输出小写 draft。
    assert.equal(
      historyDetailText(
        item('RESTORE', { from: 'Version 1', to: 'Draft', restoredFrom: 'Version 1' }),
        'en-GB',
      ),
      'Version 1 → draft',
    )
  })

  test('CHANGE_STATUS renders human status names with the reason', () => {
    assert.equal(
      historyDetailText(
        item('CHANGE_STATUS', {
          from: 'ONLINE',
          to: 'HIDDEN',
          reason: 'Typois reported in Lesson 04',
        }),
        'en-GB',
      ),
      'Online → Hidden · Typois reported in Lesson 04',
    )
  })

  test('ADD_LEARNING_LANGUAGE renders display language names', () => {
    assert.equal(
      historyDetailText(
        item('ADD_LEARNING_LANGUAGE', { from: ['en-GB'], to: ['en-GB', 'zh-CN'] }),
        'en-GB',
      ),
      'English → English, 中文',
    )
  })

  test('PUBLISH keeps the legacy rendering for records without from/to', () => {
    assert.equal(
      historyDetailText(
        item('PUBLISH', {
          versionLabel: 'Version 4',
          sourceEnvironment: 'UAT',
          sourceVersionLabel: 'Version 3',
          notifyLearners: true,
        }),
        'en-GB',
      ),
      'Version 4 · from UAT Version 3 · learners notified',
    )
  })

  test('every History action has localized copy (never the raw enum)', () => {
    const expected: Record<string, { en: string; zh: string }> = {
      PUBLISH: { en: 'Publish', zh: '发布' },
      DELETE_DRAFT: { en: 'Delete draft', zh: '删除草稿' },
      RESTORE: { en: 'Restore', zh: '恢复版本' },
      EXPORT_PACKAGE: { en: 'Export package', zh: '导出课程包' },
      IMPORT_PACKAGE: { en: 'Import package', zh: '导入课程包' },
      CHANGE_STATUS: { en: 'Change status', zh: '更改状态' },
      ADD_LEARNING_LANGUAGE: { en: 'Add learning language', zh: '添加学习语言' },
      OPERATIONS_PUBLISH: { en: 'Publish operations', zh: '发布运营位' },
      CREATE_COURSE: { en: 'Create course', zh: '新建课程' },
    }
    for (const [action, copy] of Object.entries(expected)) {
      assert.equal(historyActionLabel(action, 'en-GB'), copy.en, `${action} en-GB`)
      assert.equal(historyActionLabel(action, 'zh-CN'), copy.zh, `${action} zh-CN`)
      assert.notEqual(historyActionLabel(action, 'en-GB'), action, `${action} must not leak the enum`)
    }
  })
})
