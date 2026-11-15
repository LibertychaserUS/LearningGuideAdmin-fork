// 组件测试的浏览器环境（jsdom）：必须在 react-dom 之前导入（测试文件第一行 import './support/dom'）。
// 只补 jsdom 没有、而 antd / 页面用到的几个接口；网络一律由各测试替换 globalThis.fetch。
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const win = dom.window as unknown as Window & typeof globalThis

// Node 自带的 fetch / URL / AbortController 等保留；其余浏览器全局取 jsdom 的（Event 系列见下，必须用 jsdom 的）
const KEEP = new Set([
  'fetch',
  'Request',
  'Response',
  'Headers',
  'FormData',
  'URL',
  'URLSearchParams',
  'AbortController',
  'AbortSignal',
  'Blob',
  'File',
  'TextEncoder',
  'TextDecoder',
  'crypto',
  'performance',
  'console',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'queueMicrotask',
  'structuredClone',
  // jsdom 的 window 自带一个名为 undefined 的自属性；复制到 globalThis 会撞上不可重定义的 undefined。
  'undefined',
])
for (const key of Object.getOwnPropertyNames(win)) {
  // Node 26 起 Web Storage 全局「存在但为 undefined」（要 --localstorage-file 才有值），
  // 只按 `key in globalThis` 跳过会把 localStorage 挡在 jsdom 之外，组件测试里它就是空的。
  if (KEEP.has(key)) continue
  if ((globalThis as unknown as Record<string, unknown>)[key] !== undefined) continue
  Object.defineProperty(globalThis, key, {
    configurable: true,
    get: () => (win as unknown as Record<string, unknown>)[key],
  })
}
for (const key of ['window', 'document', 'navigator', 'self', 'Event', 'EventTarget', 'CustomEvent', 'KeyboardEvent', 'MouseEvent']) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === 'window' || key === 'self' ? win : (win as unknown as Record<string, unknown>)[key],
  })
}

// antd 依赖、jsdom 没有的接口
win.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof win.matchMedia
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(win as unknown as Record<string, unknown>).ResizeObserver ??= NoopResizeObserver
;(globalThis as unknown as Record<string, unknown>).ResizeObserver ??= NoopResizeObserver
// jsdom 不支持伪元素样式（Testing Library 计算可访问名称时会传 ::before / ::after）：按无伪元素处理
const computedStyle = win.getComputedStyle.bind(win)
win.getComputedStyle = ((element: Element) => computedStyle(element)) as typeof win.getComputedStyle
// rc-overflow（antd Select 多选）用 MessageChannel 排下一个任务：Node 的 MessagePort 设了 onmessage 就一直
// 占着事件循环，测试失败时进程永不退出（CI 会挂到超时）。换成用 setTimeout 投递的最小实现
// （浏览器里端口同样不会拖住页面）。React 的 scheduler 在 Node 里用 setImmediate，不受影响。
class TaskPort {
  onmessage: ((event: { data: unknown }) => void) | null = null
  other: TaskPort | null = null
  closed = false
  postMessage(data: unknown) {
    const target = this.other
    if (!target || this.closed) return
    setTimeout(() => {
      if (!target.closed) target.onmessage?.({ data })
    }, 0)
  }
  close() {
    this.closed = true
  }
  start() {}
}
class TaskMessageChannel {
  port1 = new TaskPort()
  port2 = new TaskPort()
  constructor() {
    this.port1.other = this.port2
    this.port2.other = this.port1
  }
}
;(globalThis as unknown as { MessageChannel: unknown }).MessageChannel = TaskMessageChannel
win.HTMLElement.prototype.scrollIntoView ??= function scrollIntoView() {}

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// findBy / waitFor 的等待上限放宽到 5s：antd 表格上按角色查询本身就要几百毫秒，CI 并行跑时更慢。
// 查询失败时不列出整棵 antd DOM 的全部角色（大表格上要算很久），只报找不到什么。
const { configure } = await import('@testing-library/dom')
configure({ asyncUtilTimeout: 5000, _disableExpensiveErrorDiagnostics: true } as Parameters<typeof configure>[0])
