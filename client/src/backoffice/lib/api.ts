import type { ErrorCode } from '../contracts/envelope'
import { serverText } from './i18n/serverText'
import { notifySessionChanged } from './navigation'

const KNOWN_ERRORS: ReadonlySet<string> = new Set<ErrorCode>([
  'INVALID_INPUT',
  'INVALID_EMPLOYEE_ACCOUNT',
  'INVALID_CREDENTIALS',
  'ACCOUNT_NOT_ACTIVE',
  'EMAIL_NOT_VERIFIED',
  'NOT_AUTHORISED',
  'RATE_LIMITED',
  'PROTECTED_ADMIN_ACCOUNT',
  'LAST_ADMIN',
  'SELF_ACCOUNT_EDIT',
  'INVALID_TOKEN',
  'TOKEN_EXPIRED',
  'TOKEN_ALREADY_USED',
  'DUPLICATE_EMAIL',
  'PASSWORD_TOO_WEAK',
  'PASSWORD_MISMATCH',
  'PASSWORD_SAME_AS_CURRENT',
  'INTERNAL_ERROR',
])

export type ApiResult<T> =
  | { success: true; data: T; error: null }
  | { success: false; data: null; error: ErrorCode; message?: string }

/**
 * 后端统一信封是 { success, data, error: { code, message } }；
 * 页面只关心稳定错误码，这里收敛成 ErrorCode，未知错误一律 INTERNAL_ERROR。
 */
/**
 * 课程草稿乐观并发（PRD §23）：服务端在课程读写响应里给 `ETag: "r<revision>"`，
 * 这里按课程记住最新的一个，之后对同一课程的写请求自动带 `If-Match`。
 * 别人在你打开之后改过课程时，服务端返回 409 COURSE_STALE，页面显示"请刷新"。
 */
const COURSE_URL = /^\/api\/backoffice\/courses\/([0-9a-f-]{36})(?:[/?]|$)/i
const COURSE_ETAG = /^"r\d+"$/
const courseRevisions = new Map<string, string>()

export function withCourseRevision(url: string, init?: RequestInit): RequestInit | undefined {
  const courseId = url.match(COURSE_URL)?.[1]
  const method = (init?.method ?? 'GET').toUpperCase()
  const etag = courseId ? courseRevisions.get(courseId) : undefined
  if (!etag || method === 'GET' || method === 'HEAD') return init
  const headers = new Headers(init?.headers)
  if (!headers.has('if-match')) headers.set('if-match', etag)
  return { ...init, headers }
}

export function rememberCourseRevision(url: string, etag: string | null): void {
  const courseId = url.match(COURSE_URL)?.[1]
  if (courseId && etag && COURSE_ETAG.test(etag)) courseRevisions.set(courseId, etag)
}

export async function boRequest<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, { credentials: 'same-origin', ...withCourseRevision(url, init) })
    if (response.ok) rememberCourseRevision(url, response.headers.get('etag'))
    // 401 / 403 可能是会话失效或角色刚被改：让外壳重读 /api/session 刷新菜单。
    // /api/session 自己就是外壳读取会话的请求，排除掉以免循环。
    if ((response.status === 401 || response.status === 403) && !url.startsWith('/api/session')) {
      notifySessionChanged()
    }
    const body = (await response.json().catch(() => null)) as {
      success?: boolean
      data?: T
      error?: { code?: string; message?: string } | null
    } | null
    if (body?.success === true) return { success: true, data: body.data as T, error: null }
    const code = body?.error?.code
    return {
      success: false,
      data: null,
      error: code && KNOWN_ERRORS.has(code) ? (code as ErrorCode) : 'INTERNAL_ERROR',
      message: body?.error?.message ? serverText(body.error.message) : undefined,
    }
  } catch {
    return { success: false, data: null, error: 'INTERNAL_ERROR' }
  }
}

export function postJson<T>(url: string, body: unknown): Promise<ApiResult<T>> {
  return boRequest<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 保持原页面 `const res = await fetch(); await res.json()` 的写法，json() 返回收敛后的信封。 */
export async function boFetch(url: string, init?: RequestInit): Promise<{ json: () => Promise<ApiResult<unknown>> }> {
  const result = await boRequest<unknown>(url, init)
  return { json: async () => result }
}
