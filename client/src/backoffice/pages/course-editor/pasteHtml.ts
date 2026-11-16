/**
 * 粘贴 HTML 归一化（PRD §12.5.2）。
 *
 * Google Docs / Word 粘贴出来的富文本常常不是语义化的 `<h1>`：Google Docs 用
 * 带 `font-size:20pt` 的 `<span>`（外面还套一层 `docs-internal-guid` 的 `<b>`），
 * Word 用 `MsoHeading1` / `mso-outline-level:1` / `mso-style-name:"heading 1"`。
 * 编辑器只把正文里的 `<h1>` 识别为学习点，所以粘贴时必须先把这些“标题 1”
 * 样式映射成 `<h1>`，否则一个学习点都识别不到。
 *
 * 这里是纯函数：输入剪贴板 HTML，输出可安全插入 contentEditable 的 HTML。
 * - 只有 H1 是学习点：已有 h1、标题 1 标记、或 18–22pt 字号 → h1；
 * - 15–17.9pt → h2，12.5–14.9pt → h3（正文小标题，不降级成段落）；
 * - ≥24pt 是 Google Docs Title（文档标题），降为普通段落；
 * - Google Docs 的 docs-heading-N / docs-title-N、Word 的 MsoHeadingN 等类名优先于字号；
 * - 内联 font-weight/font-style/text-decoration 映射为 strong/em/u/s；
 * - 其余内联样式、class、id、事件属性一律清除，保留段落/列表/强调/链接等基本结构；
 * - 多行纯文本按换行拆段；解析失败或没有任何结构时退回转义的纯文本，不抛错、不丢内容。
 */

const DROP_TAGS = new Set([
  'STYLE', 'SCRIPT', 'META', 'LINK', 'TITLE', 'HEAD', 'XML', 'O:P',
  'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'BASE',
  'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'FORM',
])

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6'])

const INLINE_TAGS = new Set([
  'SPAN', 'FONT', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL',
  'SUB', 'SUP', 'CODE', 'SMALL', 'BIG', 'MARK', 'A', 'BR', 'IMG', 'WBR',
])

const TABLE_TAGS = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION'])

const BLOCK_QUERY =
  'p,div,ul,ol,li,table,thead,tbody,tfoot,tr,td,th,caption,h1,h2,h3,h4,h5,h6,blockquote,pre,section,article,header,footer,figure,figcaption,hr'

/**
 * 字号分档（PRD §12.5.2）。Google Docs 的默认字号：
 * Title 26pt、Heading 1 20pt、Heading 2 16pt、Heading 3 14pt、正文 11pt。
 * 24pt 以上视为文档标题（不是学习点），降为普通段落。
 */
const TITLE_MIN_FONT_PT = 24
const H1_MIN_FONT_PT = 18
const H2_MIN_FONT_PT = 15
const H3_MIN_FONT_PT = 12.5

const FONT_SIZE_KEYWORDS: Record<string, number> = {
  'xx-small': 9,
  'x-small': 10,
  small: 12,
  medium: 12,
  large: 13.5,
  'x-large': 18,
  'xx-large': 24,
  'xxx-large': 36,
}

const LEGACY_FONT_SIZE: Record<string, number> = {
  '1': 7.5,
  '2': 10,
  '3': 12,
  '4': 13.5,
  '5': 18,
  '6': 24,
  '7': 36,
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

/** 解析 CSS / `<font size>` 的字号，统一换算成 pt；无法识别时返回 null。 */
function parseFontSize(value: string | null): number | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  const keyword = FONT_SIZE_KEYWORDS[normalized]
  if (keyword !== undefined) return keyword

  const match = /^(-?\d*\.?\d+)\s*(pt|px|em|rem|%)$/.exec(normalized)
  if (!match) return null
  const size = Number(match[1])
  if (!Number.isFinite(size)) return null
  switch (match[2]) {
    case 'pt': return size
    case 'px': return size * 0.75
    // em/rem/% 取决于父级字号；按 12pt 正文估算即可，只用来区分“明显偏大”。
    case 'em':
    case 'rem': return size * 12
    default: return size * 0.12
  }
}

function fontSizeOfElement(element: Element): number | null {
  let size: number | null = null
  const style = element.getAttribute('style')
  if (style) {
    const matches = style.matchAll(/font-size\s*:\s*([^;]+)/gi)
    for (const match of matches) {
      const parsed = parseFontSize(match[1] ?? null)
      if (parsed !== null) size = parsed
    }
  }
  const legacy = element.getAttribute('size')
  if (legacy !== null && LEGACY_FONT_SIZE[legacy.trim()] !== undefined) {
    const parsed = LEGACY_FONT_SIZE[legacy.trim()]
    if (size === null || parsed > size) size = parsed
  }
  return size
}

function maxFontSize(element: Element): number | null {
  let max = fontSizeOfElement(element)
  for (const child of Array.from(element.querySelectorAll('[style],[size]'))) {
    const size = fontSizeOfElement(child)
    if (size !== null && (max === null || size > max)) max = size
  }
  return max
}

type HeadingLevel = 1 | 2 | 3
type HeadingKind = HeadingLevel | 'title'

function headingLevelFromFontSize(size: number | null): HeadingKind | null {
  if (size === null) return null
  if (size >= TITLE_MIN_FONT_PT) return 'title'
  if (size >= H1_MIN_FONT_PT) return 1
  if (size >= H2_MIN_FONT_PT) return 2
  if (size >= H3_MIN_FONT_PT) return 3
  return null
}

/** 类名 / mso 样式里的标题标记（类名优先于字号）。 */
function headingSignalOf(element: Element): HeadingKind | null {
  const className = element.getAttribute('class') ?? ''
  const docsHeading = /\bdocs-heading-([1-6])\b/i.exec(className)
  if (docsHeading) {
    const level = Number(docsHeading[1])
    return level <= 3 ? (level as HeadingLevel) : null
  }
  // Google Docs 的 docs-title-1 是 Title（文档标题），不是学习点。
  if (/\bdocs-title(?:-[1-6])?\b/i.test(className)) return 'title'

  const msoHeading = /\bMsoHeading([1-6])\b/i.exec(className)
  if (msoHeading) {
    const level = Number(msoHeading[1])
    return level <= 3 ? (level as HeadingLevel) : null
  }

  const style = element.getAttribute('style') ?? ''
  const outline = /mso-outline-level\s*:\s*([1-6])(?![\d.])/i.exec(style)
  if (outline) {
    const level = Number(outline[1])
    return level <= 3 ? (level as HeadingLevel) : null
  }
  const styleName = /mso-style-name\s*:\s*[^;]*?heading\s*([1-6])(?![\d])/i.exec(style)
  if (styleName) {
    const level = Number(styleName[1])
    return level <= 3 ? (level as HeadingLevel) : null
  }
  return null
}

function hasHeadingSignal(element: Element): boolean {
  if (headingSignalOf(element) !== null) return true
  for (const child of Array.from(element.querySelectorAll('[class],[style]'))) {
    if (headingSignalOf(child) !== null) return true
  }
  return false
}

/** 元素（含后代）的标题类型：类名优先，其次按最大字号分档。 */
function blockKindOf(element: Element): HeadingKind | null {
  const own = headingSignalOf(element)
  if (own) return own
  for (const child of Array.from(element.querySelectorAll('[class],[style]'))) {
    const signal = headingSignalOf(child)
    if (signal) return signal
  }
  return headingLevelFromFontSize(maxFontSize(element))
}

function containsBlock(element: Element): boolean {
  return element.querySelector(BLOCK_QUERY) !== null
}

function hasText(node: Node): boolean {
  return Boolean((node.textContent ?? '').trim())
}

/** 段落需要保留 `<br>` / 图片（空的 `p` 代表空行）。 */
function hasRenderableContent(element: Element): boolean {
  return hasText(element) || element.querySelector('br,img') !== null
}

function safeHref(value: string | null): string | null {
  if (!value) return null
  const href = value.trim()
  if (!href) return null
  if (/^(?:https?:|mailto:|tel:)/i.test(href)) return href
  if (/^(?:\/|\.{1,2}\/|#)/.test(href)) return href
  return null
}

function safeImageSrc(value: string | null): string | null {
  if (!value) return null
  const src = value.trim()
  if (!src) return null
  if (/^(?:https?:|data:image\/)/i.test(src)) return src
  if (/^(?:\/|\.{1,2}\/)/.test(src)) return src
  return null
}

function isInlineNode(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) return true
  if (node.nodeType !== Node.ELEMENT_NODE) return false
  const element = node as Element
  const tag = element.tagName.toUpperCase()
  if (!INLINE_TAGS.has(tag)) return false
  // 内联标签里若含块级内容（Google Docs 的 <b> 包住整篇 <p>），按块级处理。
  if (containsBlock(element)) return false
  // 带“标题 1”class/style 的内联元素也按块级处理，随后升级成 h1。
  return !hasHeadingSignal(element)
}

/** 标题本身已加粗，标题里的 font-weight:700 不再额外包一层 <strong>。 */
function unwrapStrong(root: Element): void {
  for (const strong of Array.from(root.querySelectorAll('strong'))) {
    const parent = strong.parentNode
    if (!parent) continue
    while (strong.firstChild) parent.insertBefore(strong.firstChild, strong)
    parent.removeChild(strong)
  }
}

function styleDeclarations(element: Element): Map<string, string> {
  const declarations = new Map<string, string>()
  const style = element.getAttribute('style')
  if (!style) return declarations
  for (const part of style.split(';')) {
    const separator = part.indexOf(':')
    if (separator === -1) continue
    const property = part.slice(0, separator).trim().toLowerCase()
    const value = part.slice(separator + 1).trim().toLowerCase()
    if (property) declarations.set(property, value)
  }
  return declarations
}

function isBoldStyle(styles: Map<string, string>): boolean {
  const weight = styles.get('font-weight')
  if (!weight) return false
  if (weight === 'bold' || weight === 'bolder') return true
  const numeric = Number(weight)
  return Number.isFinite(numeric) && numeric >= 600
}

function isItalicStyle(styles: Map<string, string>): boolean {
  const style = styles.get('font-style')
  return style === 'italic' || style === 'oblique'
}

function textDecorationFlags(styles: Map<string, string>): { underline: boolean; strike: boolean } {
  const tokens: string[] = []
  for (const property of ['text-decoration', 'text-decoration-line']) {
    const value = styles.get(property)
    if (value) tokens.push(...value.split(/\s+/))
  }
  return { underline: tokens.includes('underline'), strike: tokens.includes('line-through') }
}

/**
 * Google Docs 的粗体/斜体/下划线/删除线是 span 的内联样式（font-weight:700 /
 * font-style:italic / text-decoration:underline），这里映射成语义标签。
 */
function appendInlineWithStyles(element: Element, target: Node, doc: Document): void {
  if (containsBlock(element)) {
    normalizeChildren(element, target, doc, 'block')
    return
  }
  const styles = styleDeclarations(element)
  const wrappers: string[] = []
  if (isBoldStyle(styles)) wrappers.push('strong')
  if (isItalicStyle(styles)) wrappers.push('em')
  const decoration = textDecorationFlags(styles)
  if (decoration.underline) wrappers.push('u')
  if (decoration.strike) wrappers.push('s')

  if (wrappers.length === 0) {
    normalizeChildren(element, target, doc, 'inline')
    return
  }

  const outer = doc.createElement(wrappers[0])
  let inner: Node = outer
  for (const tag of wrappers.slice(1)) {
    const next = doc.createElement(tag)
    inner.appendChild(next)
    inner = next
  }
  normalizeChildren(element, inner, doc, 'inline')
  if (hasRenderableContent(outer)) target.appendChild(outer)
}

function appendHeading(source: Element, target: Node, doc: Document): void {
  const heading = doc.createElement('h1')
  normalizeChildren(source, heading, doc, 'inline')
  unwrapStrong(heading)
  if (hasText(heading)) target.appendChild(heading)
}

function appendParagraph(
  source: Element,
  target: Node,
  doc: Document,
  kind: HeadingKind | null,
): void {
  const tag = kind === 1 ? 'h1' : kind === 2 ? 'h2' : kind === 3 ? 'h3' : 'p'
  const node = doc.createElement(tag)
  normalizeChildren(source, node, doc, 'inline')
  if (tag !== 'p') {
    unwrapStrong(node)
    if (hasText(node)) {
      target.appendChild(node)
      return
    }
    // 只有图片 / 空行的“标题”不是标题，退回普通段落，避免丢内容。
    const paragraph = doc.createElement('p')
    while (node.firstChild) paragraph.appendChild(node.firstChild)
    if (hasRenderableContent(paragraph)) target.appendChild(paragraph)
    return
  }
  if (hasRenderableContent(node)) target.appendChild(node)
}

function normalizeElement(
  element: Element,
  target: Node,
  doc: Document,
  mode: 'block' | 'inline',
): void {
  const tag = element.tagName.toUpperCase()
  if (DROP_TAGS.has(tag)) return

  // 已有的 h1 保留；h2-h6 保持层级。H1 仍会清掉内联样式并展开 span。
  if (HEADING_TAGS.has(tag)) {
    const level = Number(tag.slice(1))
    if (level === 1) {
      appendHeading(element, target, doc)
    } else {
      const heading = doc.createElement(tag.toLowerCase())
      normalizeChildren(element, heading, doc, 'inline')
      unwrapStrong(heading)
      if (hasText(heading)) target.appendChild(heading)
    }
    return
  }

  // Google Docs / Word 的标题 class 或 mso 标记落在元素自身（span/div/…）。
  const signal = headingSignalOf(element)
  if (mode === 'block' && signal) {
    if (containsBlock(element)) {
      // 只是带标题 class 的排版容器：展开子块，避免把整篇文档折进一个标题。
      normalizeChildren(element, target, doc, 'block')
    } else {
      appendParagraph(element, target, doc, signal)
    }
    return
  }

  // 段落，以及不含块级子节点的 div（Google Docs 常用 div 当段落）。
  // 标题标记可能落在段内的 span 上，所以这里连同后代一起检查；
  // 含块级子节点的容器不检查后代，避免把整篇文档折叠成一个 h1。
  if (tag === 'P' || (tag === 'DIV' && !containsBlock(element))) {
    appendParagraph(element, target, doc, blockKindOf(element))
    return
  }

  // 含块级子节点的 div 只是排版容器，展开即可。
  if (tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE' || tag === 'HEADER' ||
      tag === 'FOOTER' || tag === 'FIGURE' || tag === 'FIGCAPTION' || tag === 'MAIN') {
    normalizeChildren(element, target, doc, 'block')
    return
  }

  if (tag === 'UL' || tag === 'OL') {
    const list = doc.createElement(tag.toLowerCase())
    for (const child of Array.from(element.children)) {
      if (child.tagName.toUpperCase() === 'LI') {
        const item = doc.createElement('li')
        normalizeChildren(child, item, doc, containsBlock(child) ? 'block' : 'inline')
        if (hasRenderableContent(item)) list.appendChild(item)
      } else {
        normalizeElement(child, list, doc, 'block')
      }
    }
    if (list.children.length > 0) target.appendChild(list)
    return
  }

  if (tag === 'LI') {
    const item = doc.createElement('li')
    normalizeChildren(element, item, doc, containsBlock(element) ? 'block' : 'inline')
    if (hasRenderableContent(item)) target.appendChild(item)
    return
  }

  if (TABLE_TAGS.has(tag)) {
    const node = doc.createElement(tag.toLowerCase())
    const cell = tag === 'TD' || tag === 'TH' || tag === 'CAPTION'
    normalizeChildren(element, node, doc, cell && !containsBlock(element) ? 'inline' : 'block')
    target.appendChild(node)
    return
  }

  if (tag === 'BLOCKQUOTE') {
    const quote = doc.createElement('blockquote')
    normalizeChildren(element, quote, doc, 'block')
    if (hasRenderableContent(quote)) target.appendChild(quote)
    return
  }

  if (tag === 'PRE') {
    const pre = doc.createElement('pre')
    normalizeChildren(element, pre, doc, 'inline')
    if (hasText(pre)) target.appendChild(pre)
    return
  }

  if (tag === 'HR') {
    target.appendChild(doc.createElement('hr'))
    return
  }

  if (tag === 'A') {
    const href = safeHref(element.getAttribute('href'))
    if (href) {
      const anchor = doc.createElement('a')
      anchor.setAttribute('href', href)
      normalizeChildren(element, anchor, doc, 'inline')
      target.appendChild(anchor)
    } else {
      normalizeChildren(element, target, doc, mode)
    }
    return
  }

  if (tag === 'B' || tag === 'STRONG') {
    const id = element.getAttribute('id') ?? ''
    // Google Docs 的 <b id="docs-internal-guid-..."> 只是应用包裹层，不是语义加粗。
    if (/^docs-internal-guid/i.test(id) || containsBlock(element)) {
      normalizeChildren(element, target, doc, mode)
      return
    }
    const strong = doc.createElement('strong')
    normalizeChildren(element, strong, doc, 'inline')
    if (hasRenderableContent(strong)) target.appendChild(strong)
    return
  }

  if (tag === 'I' || tag === 'EM') {
    if (containsBlock(element)) {
      normalizeChildren(element, target, doc, mode)
      return
    }
    const em = doc.createElement('em')
    normalizeChildren(element, em, doc, 'inline')
    if (hasRenderableContent(em)) target.appendChild(em)
    return
  }

  if (tag === 'U' || tag === 'S' || tag === 'STRIKE' || tag === 'DEL') {
    if (containsBlock(element)) {
      normalizeChildren(element, target, doc, mode)
      return
    }
    const node = doc.createElement(tag === 'U' ? 'u' : 's')
    normalizeChildren(element, node, doc, 'inline')
    if (hasRenderableContent(node)) target.appendChild(node)
    return
  }

  if (tag === 'CODE') {
    const code = doc.createElement('code')
    normalizeChildren(element, code, doc, 'inline')
    if (hasText(code)) target.appendChild(code)
    return
  }

  if (tag === 'IMG') {
    const src = safeImageSrc(element.getAttribute('src'))
    if (src) {
      const image = doc.createElement('img')
      image.setAttribute('src', src)
      const alt = element.getAttribute('alt')
      if (alt) image.setAttribute('alt', alt)
      target.appendChild(image)
    }
    return
  }

  if (tag === 'BR') {
    if (mode === 'block') {
      const paragraph = doc.createElement('p')
      paragraph.appendChild(doc.createElement('br'))
      target.appendChild(paragraph)
    } else {
      target.appendChild(doc.createElement('br'))
    }
    return
  }

  // 其余内联样式标签（span/font/…）与未知标签：去掉标签本身，保留内容，
  // 并把 Google Docs 的粗体/斜体/下划线内联样式映射成语义标签。
  if (mode === 'block') {
    if (containsBlock(element)) {
      normalizeChildren(element, target, doc, 'block')
    } else {
      appendParagraph(element, target, doc, blockKindOf(element))
    }
    return
  }
  appendInlineWithStyles(element, target, doc)
}

/** 没有 p 包裹的内联节点自身的标题类型（类名优先，其次按字号分档）。 */
function inlineKindOf(node: Node): HeadingKind | null {
  if (node.nodeType !== Node.ELEMENT_NODE) return null
  const element = node as Element
  return headingSignalOf(element) ?? headingLevelFromFontSize(fontSizeOfElement(element))
}

/**
 * 块级上下文：相邻的内联节点聚成一段；字号落在标题档位时这一段升级成 h1/h2/h3，
 * 24pt 以上（Google Docs Title）降为普通段落。
 * 这样 `<span style="font-size:20pt">` 这种没有 p 包裹的粘贴也能识别。
 */
function normalizeBlockChildren(source: Node, target: Node, doc: Document): void {
  let buffer: Node[] = []

  const flush = () => {
    if (buffer.length === 0) return
    const meaningful = buffer.some((node) =>
      node.nodeType === Node.TEXT_NODE
        ? hasText(node)
        : hasRenderableContent(node as Element))
    if (meaningful) {
      const levels: HeadingLevel[] = []
      let hasTitle = false
      for (const node of buffer) {
        const signal = inlineKindOf(node)
        if (signal === null) continue
        if (signal === 'title') hasTitle = true
        else levels.push(signal)
      }
      const kind: HeadingKind | null =
        levels.length > 0 ? (Math.min(...levels) as HeadingLevel) : hasTitle ? 'title' : null
      const tag = kind === 1 ? 'h1' : kind === 2 ? 'h2' : kind === 3 ? 'h3' : 'p'
      const paragraph = doc.createElement(tag)
      for (const node of buffer) {
        if (node.nodeType === Node.TEXT_NODE) {
          paragraph.appendChild(doc.createTextNode((node.textContent ?? '').replace(/\u00a0/g, ' ')))
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          normalizeElement(node as Element, paragraph, doc, 'inline')
        }
      }
      if (tag === 'p') {
        if (hasRenderableContent(paragraph)) target.appendChild(paragraph)
      } else {
        unwrapStrong(paragraph)
        if (hasText(paragraph)) {
          target.appendChild(paragraph)
        } else {
          // 只有图片 / 空行的大字号片段不是标题：退回普通段落，避免丢内容。
          const fallback = doc.createElement('p')
          while (paragraph.firstChild) fallback.appendChild(paragraph.firstChild)
          if (hasRenderableContent(fallback)) target.appendChild(fallback)
        }
      }
    }
    buffer = []
  }

  for (const child of Array.from(source.childNodes)) {
    if (isInlineNode(child)) {
      buffer.push(child)
      continue
    }
    flush()
    if (child.nodeType === Node.ELEMENT_NODE) {
      normalizeElement(child as Element, target, doc, 'block')
    }
  }
  flush()
}

function normalizeChildren(
  source: Node,
  target: Node,
  doc: Document,
  mode: 'block' | 'inline',
): void {
  if (mode === 'block') {
    normalizeBlockChildren(source, target, doc)
    return
  }
  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = (child.textContent ?? '').replace(/\u00a0/g, ' ')
      if (text) target.appendChild(doc.createTextNode(text))
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    normalizeElement(child as Element, target, doc, 'inline')
  }
}

/** 纯文本按换行拆成多个段落；空行跳过。 */
function plainTextToParagraphs(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('')
}

function looksLikeMarkup(input: string): boolean {
  // 需要完整标签（`<p ...>` / `</p>` / `<!-- -->`）才算 HTML，
  // 避免把 "a < b > c" 这类纯文本当成结构解析而丢内容。
  return /<(?:[a-zA-Z][^>]*|\/[a-zA-Z][^>]*|![^>]*)>/.test(input)
}

function fallbackPlainText(raw: string): string {
  const text = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()
  return text ? plainTextToParagraphs(text) : ''
}

/**
 * 把粘贴进来的 HTML 归一化成编辑器可用的 HTML。
 * 映射失败时返回转义后的纯文本，绝不抛错、不丢内容。
 */
export function normalizePastedHtml(raw: string): string {
  const input = raw ?? ''
  if (!input.trim()) return ''
  // 多行纯文本没有 HTML 结构：按换行拆段，避免渲染时折叠成空格。
  if (!looksLikeMarkup(input)) return plainTextToParagraphs(input)

  let doc: Document
  try {
    if (typeof DOMParser === 'undefined') return fallbackPlainText(input)
    doc = new DOMParser().parseFromString(input, 'text/html')
  } catch {
    return fallbackPlainText(input)
  }

  if (!doc.body) return fallbackPlainText(input)

  const container = doc.createElement('div')
  normalizeChildren(doc.body, container, doc, 'block')
  const html = container.innerHTML.trim()
  if (html) return html

  const text = (doc.body.textContent ?? '').trim()
  return text ? `<p>${escapeHtml(text)}</p>` : ''
}
