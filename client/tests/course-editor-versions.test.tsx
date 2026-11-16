import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { cleanup, fireEvent, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import type { CourseDetail, CourseVersion } from '../src/backoffice/contracts/course'
import { CourseVersionsSection } from '../src/backoffice/pages/course-editor/CourseVersionsSection'
import { fmtDate } from '../src/backoffice/pages/course-editor/shared-utils'

/**
 * 版本列表与发布弹窗的展示规则（PRD §15.5 / §15.2）。
 *
 * - Published 列 = 发布日期 · 操作人（显示名优先，其次邮箱 @ 前的前缀）。
 * - Source 列严格按 PRD：Production 显示 Sandbox X.Y / Restored from Version N / —；
 *   Sandbox 只显示 Exported + 日期，其余为 —。
 * - 发布弹窗的空缺 Lesson 显示两位序号（Lesson 06），多个 Lesson 并列在同一行。
 */

type VersionFixture = CourseVersion & {
  createdByName?: string | null
  createdBy?: string | null
}

const LIVE_AT = '2026-10-20T10:00:00.000Z'

function makeCourse(overrides: Partial<CourseDetail> = {}): CourseDetail {
  return {
    id: 'course-1',
    code: 'C001',
    slug: 'course-1',
    learningMode: 'VIDEO_AND_TEXT',
    learningLanguages: ['en-GB'],
    defaultContentLanguage: 'en-GB',
    categoryId: null,
    subtitle: null,
    lifecycleStatus: 'LIVE',
    liveStatus: 'ONLINE',
    liveVersionId: 'version-1',
    hasDraft: true,
    trialEnabled: false,
    localizations: [],
    lessons: [],
    plans: [],
    trialRows: [],
    completeness: {
      steps: {
        courseInformation: { complete: true, missing: [] },
        content: { complete: true, missing: [], lessons: [] },
        trial: { complete: true, missing: [] },
      },
      completedSteps: 3,
      canPublish: true,
      publishBlockers: [],
    },
    ...overrides,
  }
}

function makeVersion(overrides: Partial<VersionFixture>): VersionFixture {
  return {
    id: 'version-1',
    versionNo: 1,
    versionLabel: 'Version 1',
    versionSeries: 0,
    versionMinor: 1,
    sourceEnvironment: null,
    sourceVersionLabel: null,
    wentLiveAt: LIVE_AT,
    exportedAt: null,
    createdAt: LIVE_AT,
    isLive: false,
    ...overrides,
  }
}

function renderSection(
  versions: VersionFixture[],
  course: CourseDetail,
  versionNumberingMode: 'sandbox' | 'production' = 'sandbox',
) {
  return render(
    <MemoryRouter initialEntries={['/en-GB/knowledge/courses/course-1']}>
      <CourseVersionsSection
        locale="en-GB"
        course={course}
        versions={versions}
        history={null}
        historyPage={1}
        setHistoryPage={() => {}}
        busy={false}
        setBusy={() => {}}
        onReload={async () => {}}
        onNotice={() => {}}
        versionNumberingMode={versionNumberingMode}
      />
    </MemoryRouter>,
  )
}

function row(container: HTMLElement, versionLabel: string): HTMLTableRowElement {
  const found = Array.from(container.querySelectorAll('tbody tr')).find(
    (tr) => tr.querySelector('td')?.textContent === versionLabel,
  )
  assert.ok(found, `expected a row for ${versionLabel}`)
  return found as HTMLTableRowElement
}

afterEach(cleanup)

describe('course versions list display', () => {
  test('Published shows the publish date plus the operator display name', () => {
    const versions = [
      makeVersion({ id: 'v4', versionNo: 4, versionLabel: 'Version 4', createdByName: 'Jack Smith' }),
      makeVersion({ id: 'v3', versionNo: 3, versionLabel: 'Version 3', createdBy: 'jane.doe@example.com' }),
    ]
    const { container } = renderSection(versions, makeCourse())
    const date = fmtDate(LIVE_AT, 'en-GB')

    assert.ok(row(container, 'Version 4').textContent?.includes(`${date} · Jack Smith`))
    // 没有员工显示名时回退到登录邮箱 @ 前的部分。
    assert.ok(row(container, 'Version 3').textContent?.includes(`${date} · jane.doe`))
  })

  test('Production Source shows Sandbox X.Y, Restored from Version N, or a dash', () => {
    const versions = [
      makeVersion({ id: 'v3', versionNo: 3, versionLabel: 'Version 3', sourceEnvironment: 'Sandbox', sourceVersionLabel: '3.4' }),
      makeVersion({ id: 'v2', versionNo: 2, versionLabel: 'Version 2', sourceVersionLabel: 'Version 1' }),
      makeVersion({ id: 'v1', versionNo: 1, versionLabel: 'Version 1' }),
    ]
    const { container } = renderSection(versions, makeCourse(), 'production')
    const sourceCell = (label: string) => row(container, label).querySelectorAll('td')[2].textContent

    assert.equal(sourceCell('Version 3'), 'Sandbox 3.4')
    assert.equal(sourceCell('Version 2'), 'Restored from Version 1')
    assert.equal(sourceCell('Version 1'), '—')
  })

  test('Sandbox Source shows only Exported plus date, otherwise a dash', () => {
    const exportedAt = '2026-10-21T09:00:00.000Z'
    const versions = [
      makeVersion({ id: 'v3', versionNo: 3, versionLabel: '1.3', exportedAt }),
      // Sandbox 不显示来源；即使数据里带了 source，也按 PRD 显示 —。
      makeVersion({ id: 'v2', versionNo: 2, versionLabel: '1.2', sourceEnvironment: 'Sandbox', sourceVersionLabel: '1.1' }),
    ]
    const { container } = renderSection(versions, makeCourse(), 'sandbox')
    const sourceCell = (label: string) => row(container, label).querySelectorAll('td')[2].textContent

    assert.equal(sourceCell('1.3'), `Exported ${fmtDate(exportedAt, 'en-GB')}`)
    assert.equal(sourceCell('1.2'), '—')
  })

  test('publish gaps use two-digit lesson numbers on one line instead of codes or UUIDs', () => {
    const lessonIds = Array.from({ length: 7 }, (_, index) => `11111111-1111-4111-8111-11111111110${index + 1}`)
    const lessons = lessonIds.map((lessonId, index) => ({
      lessonId,
      // 业务编号 L006/L007 不应出现在空缺提示里。
      code: `L00${index + 1}`,
      studyComplete: index < 5,
      understandingComplete: true,
      missing: [],
    }))
    const course = makeCourse({
      completeness: {
        steps: {
          courseInformation: { complete: true, missing: [] },
          content: { complete: false, missing: [], lessons },
          trial: { complete: true, missing: [] },
        },
        completedSteps: 2,
        canPublish: true,
        publishBlockers: [],
      },
    })
    const { container } = renderSection([makeVersion({})], course)

    const publishButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Publish',
    )
    assert.ok(publishButton, 'expected the draft Publish button')
    fireEvent.click(publishButton)

    const text = container.textContent ?? ''
    assert.ok(text.includes('Course Content: Lesson 06, Lesson 07'), 'expected both lessons on one line with two-digit numbers')
    assert.equal((text.match(/Course Content:/g) ?? []).length, 1, 'expected a single Course Content line')
    assert.ok(!text.includes('L006'), 'must not show the lesson business code')
    assert.ok(!text.includes('L007'), 'must not show the lesson business code')
    for (const lessonId of lessonIds) {
      assert.ok(!text.includes(lessonId), 'must not show the internal lesson UUID')
    }
  })
})
