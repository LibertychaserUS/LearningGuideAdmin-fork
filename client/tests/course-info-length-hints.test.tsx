// PRD §11.2 / §11.3：建议长度提示。
// 超过建议长度时，字数和输入框标黄并提示 "Longer than recommended"，
// 不设硬性上限、不阻止保存和发布。
import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { CourseDetail } from '../src/backoffice/contracts/course'
import { CourseInfoSection } from '../src/backoffice/pages/course-editor/CourseInfoSection'

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

const originalFetch = globalThis.fetch

const AMBER_TEXT = 'rgb(154, 107, 0)'
const AMBER_BORDER = 'rgb(224, 168, 0)'
const DEFAULT_BORDER = 'rgb(217, 224, 234)'

function course(): CourseDetail {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    code: 'C-TEST',
    slug: 'course-test',
    learningMode: 'VIDEO_AND_TEXT',
    learningLanguages: ['en-GB', 'zh-CN'],
    defaultContentLanguage: 'en-GB',
    categoryId: null,
    subtitle: null,
    lifecycleStatus: 'DRAFT',
    liveStatus: 'OFFLINE',
    liveVersionId: null,
    hasDraft: true,
    trialEnabled: false,
    localizations: [
      {
        language: 'en-GB',
        title: 'EN title',
        shortDescription: 'EN short',
        overview: 'EN overview',
        whatYouLearn: ['EN learn'],
        provides: [],
      },
      {
        language: 'zh-CN',
        title: 'ZH title',
        shortDescription: 'ZH short',
        overview: 'ZH overview',
        whatYouLearn: ['ZH learn'],
        provides: [],
      },
    ],
    lessons: [],
    plans: [],
    trialRows: [],
    completeness: {
      steps: {
        courseInformation: { complete: false, missing: [] },
        content: { complete: false, missing: [], lessons: [] },
        trial: { complete: false, missing: [] },
      },
      completedSteps: 0,
      canPublish: false,
      publishBlockers: [],
    },
  }
}

function renderSection(locale: string) {
  return render(
    <CourseInfoSection
      locale={locale}
      course={course()}
      categories={[]}
      busy={false}
      setBusy={() => {}}
      onReload={async () => {}}
      onNotice={() => {}}
      onNext={() => {}}
    />,
  )
}

function change(value: string) {
  return { target: { value } }
}

function borderOf(element: HTMLElement): string {
  return (element as HTMLInputElement | HTMLTextAreaElement).style.borderColor
}

test('keeps the existing counters and adds no warning at exactly the suggested length', () => {
  renderSection('en-GB')

  assert.ok(screen.getByText('8 / 30'))
  assert.ok(screen.getByText('8 / 225'))
  assert.ok(screen.getByText('11 / 650'))
  assert.ok(screen.getByText('8 / 14'))
  assert.ok(screen.getByText('8 / 100'))
  assert.ok(screen.getByText('11 / 380'))

  const title = screen.getByDisplayValue('EN title') as HTMLInputElement
  fireEvent.change(title, change('a'.repeat(30)))

  assert.ok(screen.getByText('30 / 30'))
  assert.equal(screen.queryByText(/Longer than recommended/), null)
  assert.notEqual(borderOf(title), AMBER_BORDER)
})

test('English title over 30 turns the number and the input amber and shows the PRD sentence', () => {
  renderSection('en-GB')

  const title = screen.getByDisplayValue('EN title') as HTMLInputElement
  fireEvent.change(title, change('a'.repeat(31)))

  const counter = screen.getByText('31 / 30') as HTMLElement
  assert.equal(counter.style.color, AMBER_TEXT)
  assert.equal(borderOf(title), AMBER_BORDER)
  assert.ok(screen.getByText(/Longer than recommended/))
})

test('short description and overview use the English suggested lengths 225 and 650', () => {
  renderSection('en-GB')

  const description = screen.getByDisplayValue('EN short') as HTMLTextAreaElement
  fireEvent.change(description, change('a'.repeat(226)))
  assert.ok(screen.getByText('226 / 225'))
  assert.ok(screen.getByText(/Longer than recommended/))
  assert.equal(borderOf(description), AMBER_BORDER)

  cleanup()
  renderSection('en-GB')
  const overview = screen.getByDisplayValue('EN overview') as HTMLTextAreaElement
  fireEvent.change(overview, change('a'.repeat(651)))
  assert.ok(screen.getByText('651 / 650'))
  assert.ok(screen.getByText(/Longer than recommended/))
  assert.equal(borderOf(overview), AMBER_BORDER)
})

test('Chinese fields use 14 / 100 / 380 and show the translated warning', () => {
  renderSection('zh-CN')

  const title = screen.getByDisplayValue('ZH title') as HTMLInputElement
  fireEvent.change(title, change('中'.repeat(15)))
  assert.ok(screen.getByText('15 / 14'))
  assert.ok(screen.getByText(/超过建议长度/))
  assert.equal((screen.getByText('15 / 14') as HTMLElement).style.color, AMBER_TEXT)
  assert.equal(borderOf(title), AMBER_BORDER)

  const description = screen.getByDisplayValue('ZH short') as HTMLTextAreaElement
  fireEvent.change(description, change('中'.repeat(101)))
  assert.ok(screen.getByText('101 / 100'))
  assert.equal(borderOf(description), AMBER_BORDER)

  const overview = screen.getByDisplayValue('ZH overview') as HTMLTextAreaElement
  fireEvent.change(overview, change('中'.repeat(381)))
  assert.ok(screen.getByText('381 / 380'))
  assert.equal(borderOf(overview), AMBER_BORDER)
})

test("each What you'll learn item uses 55 / 25 and warns only when over", () => {
  renderSection('en-GB')

  const learnEn = screen.getByDisplayValue('EN learn') as HTMLInputElement
  const learnZh = screen.getByDisplayValue('ZH learn') as HTMLInputElement

  fireEvent.change(learnEn, change('a'.repeat(55)))
  fireEvent.change(learnZh, change('中'.repeat(25)))
  assert.ok(screen.getByText('55 / 55'))
  assert.ok(screen.getByText('25 / 25'))
  assert.equal(screen.queryByText(/Longer than recommended/), null)
  assert.notEqual(borderOf(learnEn), AMBER_BORDER)

  fireEvent.change(learnEn, change('a'.repeat(56)))
  fireEvent.change(learnZh, change('中'.repeat(26)))
  assert.ok(screen.getByText('56 / 55'))
  assert.ok(screen.getByText('26 / 25'))
  assert.equal((screen.getByText('56 / 55') as HTMLElement).style.color, AMBER_TEXT)
  assert.equal((screen.getByText('26 / 25') as HTMLElement).style.color, AMBER_TEXT)
  assert.equal(borderOf(learnEn), AMBER_BORDER)
  assert.equal(borderOf(learnZh), AMBER_BORDER)
  assert.equal(screen.getAllByText(/Longer than recommended/).length, 2)
})

test('over-limit fields have no maxLength and still save', async () => {
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
    return new Response(JSON.stringify({ success: true, data: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  renderSection('en-GB')

  const title = screen.getByDisplayValue('EN title') as HTMLInputElement
  const description = screen.getByDisplayValue('EN short') as HTMLTextAreaElement
  fireEvent.change(title, change('a'.repeat(31)))
  fireEvent.change(description, change('a'.repeat(226)))

  assert.equal(title.getAttribute('maxlength'), null)
  assert.equal(description.getAttribute('maxlength'), null)

  const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
  assert.equal(save.disabled, false)
  fireEvent.click(save)

  await waitFor(() => {
    assert.ok(
      calls.some((call) => call.startsWith('PUT /api/backoffice/courses/11111111-1111-1111-1111-111111111111')),
    )
  })
})

test('under-limit inputs keep the default border', () => {
  renderSection('en-GB')
  const title = screen.getByDisplayValue('EN title') as HTMLInputElement
  assert.equal(borderOf(title), DEFAULT_BORDER)
})
