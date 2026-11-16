// PRD §12.5.2：粘贴或导入时，Google Docs 的 Heading 1、Word 的标题 1 样式识别为 H1。
// .docx 导入仍走服务端 mammoth；这里只覆盖编辑器粘贴时的客户端 HTML 归一化。
import './support/dom'

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { normalizePastedHtml } from '../src/backoffice/pages/course-editor/pasteHtml'

describe('normalizePastedHtml', () => {
  test('maps a Google Docs Heading 1 (20pt span) to h1 and unwraps the docs-internal-guid wrapper', () => {
    const html =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1a2b">' +
      '<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;">' +
      '<span style="font-size:20pt;font-family:Arial;color:#000000;font-weight:700;font-style:normal;text-decoration:none;vertical-align:baseline;white-space:pre-wrap;">State variables and state space</span>' +
      '</p>' +
      '<p dir="ltr" style="line-height:1.38;">' +
      '<span style="font-size:11pt;font-family:Arial;color:#000000;">A state variable stores the current condition.</span>' +
      '</p></b>'

    assert.equal(
      normalizePastedHtml(html),
      '<h1>State variables and state space</h1><p>A state variable stores the current condition.</p>',
    )
  })

  test('treats a Google Docs Title class (docs-title-1) as a paragraph, not a learning point', () => {
    const html =
      '<p class="docs-title-1" style="font-weight:700">Lesson title</p>' +
      '<p class="c1" style="color:#111111">Intro paragraph</p>' +
      '<p style="font-size:11pt">Body</p>'

    assert.equal(
      normalizePastedHtml(html),
      '<p>Lesson title</p><p>Intro paragraph</p><p>Body</p>',
    )
  })

  test('maps Word heading 1 styles (MsoHeading1 / mso-outline-level) to h1', () => {
    const html =
      "<p class=MsoHeading1 style='margin:0cm;mso-outline-level:1'>Word heading</p>" +
      "<p class=MsoNormal><span style='font-size:11.0pt'>Word body</span></p>"

    assert.equal(normalizePastedHtml(html), '<h1>Word heading</h1><p>Word body</p>')
  })

  test('maps Word mso-style-name "heading 1" to h1', () => {
    const html =
      '<p style=\'mso-style-name:"heading 1";font-size:11.0pt\'>Style name heading</p>' +
      '<p style="font-size:11pt">Paragraph</p>'

    assert.equal(normalizePastedHtml(html), '<h1>Style name heading</h1><p>Paragraph</p>')
  })

  test('keeps an existing h1 and strips its inline styling', () => {
    const html = '<h1 style="color:#ff0000"><span style="font-weight:700">Kept heading</span></h1>'

    assert.equal(normalizePastedHtml(html), '<h1>Kept heading</h1>')
  })

  test('maps font sizes by tier: 18-22pt to h1, 15-17.9pt to h2 (not flattened to a paragraph)', () => {
    assert.equal(
      normalizePastedHtml('<p style="font-size:20pt"><span style="color:#000000">Big title</span></p>'),
      '<h1>Big title</h1>',
    )
    assert.equal(
      normalizePastedHtml('<p style="font-size:24px">Pixel heading</p>'),
      '<h1>Pixel heading</h1>',
    )
    assert.equal(
      normalizePastedHtml('<p style="font-size:16pt"><span>Subheading</span></p>'),
      '<h2>Subheading</h2>',
    )
  })

  test('unwraps nested Google Docs div wrappers and keeps the basic structure', () => {
    const html =
      '<div class="c0"><div><p><span style="font-size:20pt">Nested heading</span></p></div>' +
      '<p>After</p></div>'

    assert.equal(normalizePastedHtml(html), '<h1>Nested heading</h1><p>After</p>')
  })

  test('keeps lists, emphasis and links while clearing inline styles and classes', () => {
    const html =
      '<ul style="margin:0"><li style="color:red">' +
      '<strong style="font-weight:bold">Bold</strong> and ' +
      '<em style="font-style:italic">italic</em> ' +
      '<a href="https://example.com" style="color:blue">link</a>' +
      '</li></ul>'

    assert.equal(
      normalizePastedHtml(html),
      '<ul><li><strong>Bold</strong> and <em>italic</em> <a href="https://example.com">link</a></li></ul>',
    )
  })

  test('falls back to escaped plain text when the clipboard has no usable structure', () => {
    assert.equal(normalizePastedHtml('Learning point one & two'), '<p>Learning point one &amp; two</p>')
  })

  test('returns empty output for empty or style-only clipboard content', () => {
    assert.equal(normalizePastedHtml(''), '')
    assert.equal(normalizePastedHtml('<style>p{color:red}</style><meta charset="utf-8">'), '')
  })

  test('drops scripts, event handlers and non-content metadata from a Word document paste', () => {
    const html =
      '<html><head><style>p{margin:0}</style></head><body><!--StartFragment-->' +
      '<h1 class=MsoTitle>Document title</h1>' +
      '<p class=MsoNormal onclick="alert(1)">Paragraph</p>' +
      '<script>alert(1)</script>' +
      '<!--EndFragment--></body></html>'

    assert.equal(normalizePastedHtml(html), '<h1>Document title</h1><p>Paragraph</p>')
  })

  test('maps 12.5-14.9pt body text to h3', () => {
    const html =
      '<p style="font-size:13.5pt">Slightly larger</p>' +
      '<p style="font-size:11pt">Normal</p>'

    assert.equal(normalizePastedHtml(html), '<h3>Slightly larger</h3><p>Normal</p>')
  })

  test('a wrapper div containing a heading does not collapse the whole document into one h1', () => {
    const html =
      '<div class="docs-wrapper"><p class="docs-heading-1">First heading</p>' +
      '<p>Body text</p><p class="docs-heading-1">Second heading</p><p>More body</p></div>'

    assert.equal(
      normalizePastedHtml(html),
      '<h1>First heading</h1><p>Body text</p><h1>Second heading</h1><p>More body</p>',
    )
  })

  test('a large-font paragraph that only holds an image is kept as a paragraph with its image', () => {
    const html = '<p style="font-size:20pt"><img src="https://example.com/a.png" alt="Diagram"></p>'

    assert.equal(
      normalizePastedHtml(html),
      '<p><img src="https://example.com/a.png" alt="Diagram"></p>',
    )
  })

  test('demotes a Google Docs Title (26pt span) to a paragraph instead of a learning point', () => {
    const html = '<p><span style="font-size:26pt">My lesson title</span></p>'

    assert.equal(normalizePastedHtml(html), '<p>My lesson title</p>')
  })

  test('gives heading classes priority over font size: docs-heading-1 is h1, docs-title-1 is a paragraph', () => {
    assert.equal(
      normalizePastedHtml('<p class="docs-heading-1" style="font-size:26pt">Heading one</p>'),
      '<h1>Heading one</h1>',
    )
    assert.equal(
      normalizePastedHtml('<p class="docs-title-1" style="font-size:20pt">Document title</p>'),
      '<p>Document title</p>',
    )
  })

  test('maps real Google Docs inline span styling to strong, em and u', () => {
    const html =
      '<p dir="ltr" style="line-height:1.38">' +
      '<span style="font-size:11pt;font-family:Arial;color:#000000;font-weight:700;font-style:normal;text-decoration:none;white-space:pre-wrap;">bold</span> ' +
      '<span style="font-size:11pt;font-family:Arial;color:#000000;font-weight:400;font-style:italic;text-decoration:none;white-space:pre-wrap;">italic</span> ' +
      '<span style="font-size:11pt;font-family:Arial;color:#000000;font-weight:400;font-style:normal;text-decoration:underline;white-space:pre-wrap;">underlined</span>' +
      '</p>'

    assert.equal(
      normalizePastedHtml(html),
      '<p><strong>bold</strong> <em>italic</em> <u>underlined</u></p>',
    )
  })

  test('combines bold and italic inline styles on one Google Docs span', () => {
    const html =
      '<p><span style="font-size:11pt;font-weight:700;font-style:italic">both</span></p>'

    assert.equal(normalizePastedHtml(html), '<p><strong><em>both</em></strong></p>')
  })

  test('keeps H2/H3 instead of flattening them: 16pt span, 14pt block and Word MsoHeading2/3', () => {
    assert.equal(
      normalizePastedHtml('<p><span style="font-size:16pt">Sub heading</span></p>'),
      '<h2>Sub heading</h2>',
    )
    assert.equal(
      normalizePastedHtml('<span style="font-size:14pt">Minor heading</span>'),
      '<h3>Minor heading</h3>',
    )
    assert.equal(
      normalizePastedHtml("<p class=MsoHeading2 style='mso-outline-level:2'>Word h2</p>"),
      '<h2>Word h2</h2>',
    )
    assert.equal(
      normalizePastedHtml("<p class=MsoHeading3 style='mso-outline-level:3'>Word h3</p>"),
      '<h3>Word h3</h3>',
    )
  })

  test('splits multi-line plain text into one paragraph per line', () => {
    assert.equal(normalizePastedHtml('a\nb\nc'), '<p>a</p><p>b</p><p>c</p>')
    assert.equal(
      normalizePastedHtml('first line\r\nsecond line'),
      '<p>first line</p><p>second line</p>',
    )
  })
})
