// 编辑器粘贴接线：Google Docs 的标题样式必须经归一化后以 h1 进入正文，
// 否则 CourseContentSection 只按 h1 识别学习点，整篇粘贴会一个都识别不到。
import './support/dom'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { cleanup, fireEvent, render } from '@testing-library/react'

import { TextEditor } from '../src/backoffice/pages/course-editor/TextEditor'

afterEach(cleanup)

const GOOGLE_DOCS_HTML =
  '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1a2b">' +
  '<p dir="ltr"><span style="font-size:20pt;font-weight:700">State variables and state space</span></p>' +
  '<p dir="ltr"><span style="font-size:11pt">A state variable stores the current condition.</span></p>' +
  '</b>'

function paste(editor: HTMLElement, html: string, text: string) {
  fireEvent.paste(editor, {
    clipboardData: {
      getData: (type: string) => (type === 'text/html' ? html : type === 'text/plain' ? text : ''),
    },
  })
}

test('pasting Google Docs HTML inserts an h1 and a cleaned paragraph', () => {
  const changes: string[] = []
  const { container } = render(
    <TextEditor
      locale="en-GB"
      value=""
      onChange={(html) => changes.push(html)}
      exhibits={[]}
      language="en-GB"
      onImportDocx={async () => null}
      onNotice={() => {}}
    />,
  )

  const editor = container.querySelector('[contenteditable="true"]')
  assert.ok(editor instanceof HTMLElement)

  paste(editor, GOOGLE_DOCS_HTML, 'State variables and state space\nA state variable stores the current condition.')

  assert.equal(changes.at(-1), '<h1>State variables and state space</h1><p>A state variable stores the current condition.</p>')
  assert.equal(
    editor.innerHTML,
    '<h1>State variables and state space</h1><p>A state variable stores the current condition.</p>',
  )
})

test('pasting plain text still inserts the text instead of throwing', () => {
  const changes: string[] = []
  const { container } = render(
    <TextEditor
      locale="en-GB"
      value=""
      onChange={(html) => changes.push(html)}
      exhibits={[]}
      language="en-GB"
      onImportDocx={async () => null}
      onNotice={() => {}}
    />,
  )

  const editor = container.querySelector('[contenteditable="true"]')
  assert.ok(editor instanceof HTMLElement)

  paste(editor, '', 'Learning point one & two')

  assert.equal(changes.at(-1), '<p>Learning point one &amp; two</p>')
})

test('pasting multi-line plain text inserts one paragraph per line', () => {
  const changes: string[] = []
  const { container } = render(
    <TextEditor
      locale="en-GB"
      value=""
      onChange={(html) => changes.push(html)}
      exhibits={[]}
      language="en-GB"
      onImportDocx={async () => null}
      onNotice={() => {}}
    />,
  )

  const editor = container.querySelector('[contenteditable="true"]')
  assert.ok(editor instanceof HTMLElement)

  paste(editor, '', 'line one\nline two\nline three')

  assert.equal(changes.at(-1), '<p>line one</p><p>line two</p><p>line three</p>')
})

test('prevents the browser default paste when normalization yields nothing', () => {
  const changes: string[] = []
  const { container } = render(
    <TextEditor
      locale="en-GB"
      value=""
      onChange={(html) => changes.push(html)}
      exhibits={[]}
      language="en-GB"
      onImportDocx={async () => null}
      onNotice={() => {}}
    />,
  )

  const editor = container.querySelector('[contenteditable="true"]')
  assert.ok(editor instanceof HTMLElement)

  const notCancelled = fireEvent.paste(editor, {
    clipboardData: {
      getData: (type: string) => (type === 'text/html' ? '<style>p{color:red}</style>' : ''),
    },
  })

  assert.equal(notCancelled, false, 'paste default should be prevented')
  assert.equal(editor.innerHTML, '')
  assert.equal(changes.length, 0)
})
