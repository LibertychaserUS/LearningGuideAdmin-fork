import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { useEmployee } from '../employeeSession';
import type { CourseCategory, CourseList } from '../contracts/course'
import { useResizableColumns } from '../components/resizableColumns'
import { Pagination } from '../components/Pagination';
import { usePageSize } from '../components/paginationState';
import { boRequest } from '../lib/api'
import { localizedName } from '../lib/i18n/localized'
import { uploadFileWithProgress } from '../lib/upload'
import { t } from '../lib/i18n/messages'
import type { Locale } from '../lib/i18n/config'
import { serverText } from '../lib/i18n/serverText'
import { useLocale } from '../lib/navigation'
import { MENU_SEGMENT } from '../rbac/permissions'
import { MenuGuard } from './ModulePages'
import { languageLabel, learningModeLabel } from './course-editor/shared-utils';

type JobView = {
  jobId: string
  status: string
  stage?: string | null
  progress: number
  error: string | null
  courseId: string | null
  package: { courseCode: string; lessons: number; mediaFiles: number; incomplete: boolean } | null
  conflict?: { existingCourseCode: string; existingCourseId: string; live: boolean } | null
  report: { errors: Array<{ code: string; message: string }>; warnings: Array<{ code: string; message: string }> }
}

type ConfirmOutcome = {
  courseId?: string
  requiresOverwrite?: boolean
  existingCourseCode?: string
  existingCourseId?: string
  refused?: string
  message?: string
}

function uploadErrorText(locale: string, code: string, detail?: string): string {
  const zh = locale.startsWith('zh')
  if (code === 'NETWORK_ERROR' || code === 'ABORTED') {
    return zh ? '上传中断（网络不稳定或服务被重启）。请确认网络与服务稳定后重试。' : 'The upload was interrupted (unstable network or a service restart). Check them and try again.'
  }
  if (code === 'TIMEOUT') {
    return zh ? '上传超时（网络过慢或服务无响应）。请重试。' : 'The upload timed out (slow network or no answer from the service). Try again.'
  }
  const reason = detail && detail.trim() ? serverText(detail, locale as Locale) : code
  return zh ? `导入失败：${reason}` : `Import failed: ${reason}`
}

function formatWhen(value: string | null | undefined, locale: string): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}

/**
 * Course Overview（PRD CM01）：列表 + Category 筛选 + 新建 / 从包导入 / Operations 入口。
 * Publish / 版本 / 导入到已有课程在课程详情的 Versions 区完成。
 */
export function CourseManagementPage() {
  const locale = useLocale()
  return (
    <MenuGuard menu="course">
      <CourseManagementInner locale={locale} />
    </MenuGuard>
  )
}

function CourseManagementInner({ locale }: { locale: ReturnType<typeof useLocale> }) {
  const employee = useEmployee()
  const navigate = useNavigate()
  const L = (zh: string, en: string) => (locale.startsWith('zh') ? zh : en)
  const canPublish = employee.role === 'ADMIN' || employee.role === 'OPERATION_ADMIN'
  const [list, setList] = useState<CourseList | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = usePageSize('course-list')
  const [importJob, setImportJob] = useState<JobView | null>(null)
  const [confirmNotice, setConfirmNotice] = useState<{ kind: 'overwrite' | 'refused'; courseCode?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [actionMenuId, setActionMenuId] = useState<string | null>(null)
  const [statusCourse, setStatusCourse] = useState<CourseList['courses'][number] | null>(null)
  const [statusTarget, setStatusTarget] = useState<'ONLINE' | 'HIDDEN' | 'OFFLINE'>('ONLINE')
  const [statusReason, setStatusReason] = useState('')
  const [packageFile, setPackageFile] = useState<File | null>(null)
  const [uploadPct, setUploadPct] = useState<number | null>(null)
  const [categoryId, setCategoryId] = useState('')
  const [catalogCategories, setCatalogCategories] = useState<CourseCategory[]>([])
  const [createCategoryId, setCreateCategoryId] = useState('')
  const [createMode, setCreateMode] = useState('VIDEO_AND_TEXT')
  const [createLanguages, setCreateLanguages] = useState<string[]>([locale.startsWith('zh') ? 'zh-CN' : 'en-GB'])
  const [exportingId, setExportingId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const rawFileRef = useRef<HTMLInputElement | null>(null)
  const openCourse = (id: string) => navigate(`/${locale}/course/${id}`)
  const courseTable = useResizableColumns({
    storageKey: 'course-list',
    defaultWidths: [300, 104, 120, 160, 130, 136, 176],
  })

  const fetchLoad = useCallback(() => {
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
    if (categoryId) query.set('categoryId', categoryId)
    return boRequest<CourseList>(`/api/backoffice/courses?${query.toString()}`).then((result) => {
      setLoading(false)
      if (!result.success) {
        setMessage(t(locale, 'common.sessionUnavailable'))
        return
      }
      if (result.data.pages > 0 && page > result.data.pages) {
        setPage(result.data.pages)
        return
      }
      setList(result.data)
    })
  }, [locale, categoryId, page, pageSize])

  const [loadSource, setLoadSource] = useState(() => ({ locale, categoryId, page, pageSize }))
  if (
    loadSource.locale !== locale ||
    loadSource.categoryId !== categoryId ||
    loadSource.page !== page ||
    loadSource.pageSize !== pageSize
  ) {
    setLoadSource({ locale, categoryId, page, pageSize })
    setLoading(true)
  }
  const load = useCallback(() => {
    setLoading(true)
    return fetchLoad()
  }, [fetchLoad])

  useEffect(() => {
    void fetchLoad();
  }, [fetchLoad]);

  useEffect(() => {
    void (async () => {
      const result = await boRequest<CourseCategory[]>(`/api/backoffice/courses/categories`)
      if (result.success) setCatalogCategories(result.data)
    })()
  }, [])

  const categories = useMemo(() => {
    const map = new Map<string, string>()
    for (const category of catalogCategories) map.set(category.id, localizedName(locale, category))
    // 当前页出现的分类即使目录接口没返回（如已停用）也保留，避免已选筛选值丢失
    for (const course of list?.courses ?? []) {
      if (course.category) map.set(course.category.id, localizedName(locale, course.category))
    }
    return [...map.entries()]
  }, [catalogCategories, list, locale])

  async function createCourse(form: FormData) {
    const titleEn = String(form.get('titleEn') || '').trim()
    const titleZh = String(form.get('titleZh') || '').trim()
    if (!titleEn || !titleZh) {
      setMessage(L('英文和中文课程名称均为必填。', 'English and Chinese course titles are both required.'))
      return
    }
    if (!createCategoryId) {
      setMessage(L('请选择分类。', 'Category is required.'))
      return
    }
    if (createLanguages.length === 0) {
      setMessage(L('请至少选择一种学习语言。', 'Select at least one learning language.'))
      return
    }
    const defaultLanguage = createLanguages.includes('en-GB') ? 'en-GB' : createLanguages[0]
    const defaultTitle = defaultLanguage === 'zh-CN' ? titleZh : titleEn
    setBusy(true)
    const result = await boRequest<{ id: string }>('/api/backoffice/courses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: String(form.get('code') || '').trim() || undefined,
        title: defaultTitle,
        slug: String(form.get('slug') || ''),
        language: defaultLanguage,
        defaultContentLanguage: defaultLanguage,
        learningLanguages: createLanguages,
        learningMode: createMode,
        categoryId: createCategoryId,
      }),
    })
    if (!result.success) {
      setBusy(false)
      setMessage(L(`新建失败：${result.error}`, `Create failed: ${result.error}`))
      return
    }
    const otherLanguage = defaultLanguage === 'zh-CN' ? 'en-GB' : 'zh-CN'
    const otherTitle = otherLanguage === 'zh-CN' ? titleZh : titleEn
    await boRequest(`/api/backoffice/courses/${result.data.id}/localizations/${otherLanguage}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: otherTitle }),
    })
    setBusy(false)
    setShowCreate(false)
    await load()
    openCourse(result.data.id)
  }

  // 轮询后台导入作业，直到校验完成 / 失败 / 取消（异步导入：上传即返回，处理在后台）
  async function pollImportJob(initial: JobView): Promise<JobView> {
    const terminal = new Set(['AWAITING_CONFIRM', 'FAILED', 'CANCELLED'])
    let job = initial
    for (let i = 0; i < 600 && !terminal.has(job.status); i++) {
      await new Promise((r) => setTimeout(r, 1500))
      const poll = await boRequest<JobView>(`/api/backoffice/courses/import/${job.jobId}`)
      if (!poll.success) {
        setMessage(uploadErrorText(locale, poll.error, poll.message))
        return job
      }
      job = poll.data
      if (job.status === 'VALIDATING') {
        setMessage(L(`正在后台解析并校验素材…（${job.progress ?? 0}%）`, `Parsing and validating materials… (${job.progress ?? 0}%)`))
      }
    }
    return job
  }

  async function onPickRawFile(file: File) {
    setBusy(true)
    setMessage(null)
    setConfirmNotice(null)
    setUploadPct(0)
    // 大素材包单次 POST 会被 CloudFront/App Runner 中途切断，改为分块上传：
    // 先开会话拿 jobId + 块大小，再把文件切成小块逐块 PUT，最后 complete。
    const init = await boRequest<{ jobId: string; chunkSize: number }>(
      `/api/backoffice/courses/import/raw/session`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, bytesTotal: file.size }),
      },
    )
    if (!init.success) {
      setBusy(false)
      setMessage(uploadErrorText(locale, init.error, init.message))
      return
    }
    const { jobId } = init.data
    const total = file.size
    const size = Math.max(1, init.data.chunkSize || 5 * 1024 * 1024)
    let sent = 0
    for (let index = 0; sent < total; index++) {
      const start = index * size
      const blob = file.slice(start, Math.min(start + size, total))
      const res = await uploadFileWithProgress<{ jobId: string; progress: number }>(
        `/api/backoffice/courses/import/${jobId}/chunk?index=${index}`,
        blob,
        (pct) => setUploadPct(Math.min(99, Math.round(((sent + (blob.size * pct) / 100) / total) * 100))),
        { field: 'chunk', method: 'PUT' },
      )
      if (!res.success) {
        setBusy(false)
        setUploadPct(null)
        setMessage(uploadErrorText(locale, res.error, res.errorMessage))
        return
      }
      sent += blob.size
      setUploadPct(Math.min(99, Math.round((sent / total) * 100)))
    }
    setUploadPct(null)
    setMessage(L('上传完成，正在后台解析并校验…', 'Uploaded. Parsing and validating in the background…'))
    const comp = await boRequest<JobView>(`/api/backoffice/courses/import/${jobId}/complete`, { method: 'POST' })
    if (!comp.success) {
      setBusy(false)
      setMessage(uploadErrorText(locale, comp.error, comp.message))
      return
    }
    const job = await pollImportJob(comp.data)
    setBusy(false)
    setImportJob(job)
    if (job.status === 'FAILED') setMessage(job.error ? uploadErrorText(locale, '', job.error) : L('导入校验失败。', 'Import validation failed.'))
    else if (job.status === 'AWAITING_CONFIRM') setMessage(L('原始素材已转换。确认前请先查看校验结果。', 'Raw materials converted. Review validation before confirming.'))
  }

  async function importFromServerFolder() {
    const dir = window.prompt(L('仓库内素材目录（相对仓库根）', 'Server material folder (relative to repo root)'), 'docs/modeling-life')
    if (dir === null) return
    setBusy(true)
    setMessage(null)
    setConfirmNotice(null)
    const result = await boRequest<JobView>(`/api/backoffice/courses/import/local`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir }),
    })
    if (!result.success) {
      setBusy(false)
      setMessage(uploadErrorText(locale, result.error, result.message))
      return
    }
    setMessage(L('已提交，正在后台解析素材…', 'Submitted. Parsing materials in the background…'))
    const job = await pollImportJob(result.data)
    setBusy(false)
    setImportJob(job)
    if (job.status === 'FAILED') setMessage(job.error ? uploadErrorText(locale, '', job.error) : L('导入校验失败。', 'Import validation failed.'))
    else setMessage(L('已从本地目录解析素材，请在校验信息中确认后导入。', 'Parsed materials from the server folder. Review validation before confirming.'))
  }

  async function exportCourse(course: CourseList['courses'][number]) {
    setExportingId(course.id)
    setMessage(null)
    const startExport = (version?: string) =>
      boRequest<{ jobId: string; fileName?: string }>(`/api/backoffice/courses/${course.id}/export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(version ? { version } : {}),
      })
    // 有线上版本 → 先导出线上版本；未发布或线上版本导出被拒（如不完整）→ 回退导出当前草稿
    let start = await startExport(course.liveVersionId ? undefined : 'working')
    if (!start.success && course.liveVersionId) start = await startExport('working')
    if (!start.success) {
      setExportingId(null)
      setMessage(uploadErrorText(locale, start.error, start.message))
      return
    }
    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const status = await boRequest<{ status: string; progress: number; fileLabel?: string; error?: string }>(
        `/api/backoffice/courses/export/${start.data.jobId}`,
      )
      if (!status.success) continue
      if (status.data.status === 'READY') {
        window.location.href = `/api/backoffice/courses/export/${start.data.jobId}/download`
        setExportingId(null)
        setMessage(L(`已导出 ${course.code}，正在下载课程包。`, `Exported ${course.code}. Downloading the package.`))
        return
      }
      if (status.data.status === 'FAILED') {
        setExportingId(null)
        setMessage(L(`导出失败：${status.data.error ?? '未知错误'}`, `Export failed: ${status.data.error ?? 'unknown error'}`))
        return
      }
    }
    setExportingId(null)
    setMessage(L('导出超时，请稍后在课程详情页重试。', 'Export timed out. Retry from the course detail page.'))
  }

  async function changeCourseStatus() {
    if (!statusCourse || !statusReason.trim()) return
    setBusy(true)
    const result = await boRequest(`/api/backoffice/courses/${statusCourse.id}/live-status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: statusTarget, reason: statusReason }),
    })
    setBusy(false)
    if (result.success) {
      setStatusCourse(null)
      setStatusReason('')
      await load()
    } else setMessage(L(`状态更新失败：${result.message ?? result.error}`, `Status update failed: ${result.message ?? result.error}`))
  }

  async function onPickFile(file: File) {
    setPackageFile(file)
    setShowImport(true)
    const lower = file.name.toLowerCase()
    if (!lower.endsWith('.zip') && !lower.endsWith('.lgcourse.zip')) {
      setMessage(L('只能导入 .lgcourse.zip 课程包。', 'Only .lgcourse.zip course packages can be imported.'))
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    setBusy(true)
    setMessage(null)
    setUploadPct(0)
    const result = await uploadFileWithProgress<JobView>(`/api/backoffice/courses/import`, file, setUploadPct)
    setUploadPct(null)
    setBusy(false)
    if (result.success) {
      setImportJob(result.data)
      if (result.data.status === 'FAILED') setMessage(result.data.error ?? L('导入校验失败。', 'Import validation failed.'))
    } else setMessage(uploadErrorText(locale, result.error, result.errorMessage))
  }

  async function confirmImport(onConflict: string, overwriteDraft = false) {
    if (!importJob) return
    setBusy(true)
    setConfirmNotice(null)
    const result = await boRequest<ConfirmOutcome>(`/api/backoffice/courses/import/${importJob.jobId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ onConflict, reassignCodes: false, overwriteDraft }),
    })
    setBusy(false)
    if (!result.success) {
      setMessage(L(`确认导入失败：${result.message ?? result.error}`, `Confirm failed: ${result.message ?? result.error}`))
      return
    }
    const outcome = result.data
    if (outcome.requiresOverwrite) {
      // 同 Course ID 的草稿课程已存在 → 询问是否覆盖（覆盖仅影响沙盒草稿）
      setConfirmNotice({ kind: 'overwrite', courseCode: outcome.existingCourseCode })
      return
    }
    if (outcome.refused) {
      // 同 Course ID 的课程已上线 → 拒绝导入
      setConfirmNotice({ kind: 'refused', courseCode: outcome.existingCourseCode })
      return
    }
    setImportJob(null)
    setConfirmNotice(null)
    if (fileRef.current) fileRef.current.value = ''
    setShowImport(false)
    setPackageFile(null)
    if (outcome.courseId) openCourse(outcome.courseId)
  }

  // 忽略：不覆盖同 Course ID 的草稿课程，直接取消该导入作业。
  async function ignoreImport() {
    if (!importJob) return
    setBusy(true)
    await boRequest(`/api/backoffice/courses/import/${importJob.jobId}/cancel`, { method: 'POST' })
    setBusy(false)
    setImportJob(null)
    setConfirmNotice(null)
    if (fileRef.current) fileRef.current.value = ''
    setShowImport(false)
    setPackageFile(null)
    setMessage(L('已忽略该课程包（未覆盖同名草稿）。', 'Package ignored (existing draft left untouched).'))
  }

  return (
    <section className="card cardGrow">
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 className="cardTitle">{t(locale, 'course.title')}</h1>
          <p className="cardBody">
            {list
              ? L(
                  `${list.counts.total} 门课程 · ${list.counts.draft} 草稿 · ${list.counts.online} 在线 · ${list.counts.notPublished} 未发布`,
                  `${list.counts.total} courses · ${list.counts.draft} with draft · ${list.counts.online} online · ${list.counts.notPublished} not published`,
                )
              : t(locale, 'course.description')}
          </p>
        </div>
        {canPublish && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="button buttonGhost" disabled={busy} onClick={() => navigate(`/${locale}/operations`)}>
              {L('运营位', 'Operations')}
            </button>
            <button type="button" className="button buttonGhost" disabled={busy} onClick={() => setShowCreate(true)}>
              {L('新建课程', 'Create course')}
            </button>
            <button type="button" className="button buttonGhost" disabled={busy} onClick={() => rawFileRef.current?.click()}>
              {L('导入原始素材（.zip）', 'Import raw materials (.zip)')}
            </button>
            <button type="button" className="button buttonGhost" disabled={busy} onClick={() => void importFromServerFolder()}>
              {L('本地目录导入', 'Import from server folder')}
            </button>
            <button type="button" className="button" disabled={busy} onClick={() => setShowImport(true)}>
              {L('导入课程包', 'Import course package')}
            </button>
          </div>
        )}
        <input
          ref={rawFileRef}
          type="file"
          accept=".zip"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void onPickRawFile(file)
          }}
        />
      </header>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12 }}>
        <label style={{ fontSize: 13 }}>
          {L('分类', 'Category')}{' '}
          <select
            value={categoryId}
            onChange={(event) => {
              setCategoryId(event.target.value)
              setPage(1)
            }}
            style={{ padding: 7, borderRadius: 8 }}
          >
            <option value="">{L('全部分类', 'All categories')}</option>
            {categories.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <button type="button" className="button buttonGhost" disabled={loading} onClick={() => void load()}>{L('刷新', 'Refresh')}</button>
      </div>

      {message && (() => {
        const isError = /fail|error|失败|中断|invalid/i.test(message)
        return (
          <p className="cardBody" role="status" style={{ color: isError ? 'var(--color-danger, #d33)' : '#1E7A3C', background: isError ? '#FDECEC' : '#E7F6EC', borderRadius: 8, padding: '8px 12px', marginTop: 8 }}>
            {isError ? '✕ ' : '✓ '}{message}
          </p>
        )
      })()}

      {uploadPct !== null && (
        <div className="cardBody" role="status" style={{ marginTop: 4, marginBottom: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
            <span>{L('正在上传文件…', 'Uploading…')}</span>
            <span>{uploadPct}%</span>
          </div>
          <div style={{ height: 8, background: '#E8EDF5', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ width: `${uploadPct}%`, height: '100%', background: '#1D6BFF', transition: 'width 0.2s ease' }} />
          </div>
          {uploadPct >= 100 && <div style={{ fontSize: 12, marginTop: 4, opacity: 0.7 }}>{L('上传完成，正在解析与校验，请稍候…', 'Upload complete. Parsing and validating…')}</div>}
        </div>
      )}

      {showCreate && (
        <div
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowCreate(false)
          }}
          style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(16, 24, 40, 0.42)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-course-title"
            action={(form) => void createCourse(form)}
            style={{ width: 'min(640px, 100%)', maxHeight: '90vh', overflowY: 'auto', background: '#fff', borderRadius: 16, padding: 24, boxShadow: '0 24px 64px rgba(16, 24, 40, 0.24)' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 16 }}>
              <div>
                <h2 id="create-course-title" style={{ margin: 0, fontSize: 20 }}>{L('新建课程', 'Create course')}</h2>
                <p style={{ margin: '6px 0 0', fontSize: 13, opacity: 0.7 }}>{L('创建后会进入课程编辑页，可继续填写内容、试看和价格。', 'After creating, you will enter the course editor to continue with content, trial and pricing.')}</p>
              </div>
              <button type="button" aria-label={L('关闭', 'Close')} onClick={() => setShowCreate(false)} style={{ border: 0, background: 'transparent', fontSize: 22, cursor: 'pointer', lineHeight: 1, padding: 4 }}>×</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
              <label style={{ fontSize: 13, fontWeight: 600 }}>{L('课程名称（英文）', 'Course title (English)')} *<input name="titleEn" required autoFocus style={{ display: 'block', width: '100%', marginTop: 6, padding: 10, borderRadius: 8, border: '1px solid #D5DCE8' }} /></label>
              <label style={{ fontSize: 13, fontWeight: 600 }}>{L('课程名称（中文）', 'Course title (Chinese)')} *<input name="titleZh" required style={{ display: 'block', width: '100%', marginTop: 6, padding: 10, borderRadius: 8, border: '1px solid #D5DCE8' }} /></label>
              <label style={{ fontSize: 13, fontWeight: 600 }}>{L('课程 ID（留空自动生成）', 'Course ID (auto if blank)')}<input name="code" pattern="[A-Za-z0-9_-]+" title={L('仅限字母、数字、下划线和连字符', 'Letters, numbers, underscores and hyphens only')} style={{ display: 'block', width: '100%', marginTop: 6, padding: 10, borderRadius: 8, border: '1px solid #D5DCE8' }} /></label>
              <label style={{ fontSize: 13, fontWeight: 600 }}>{L('短名', 'Slug')}<input name="slug" style={{ display: 'block', width: '100%', marginTop: 6, padding: 10, borderRadius: 8, border: '1px solid #D5DCE8' }} /></label>
              <label style={{ fontSize: 13, fontWeight: 600 }}>{L('学习模式', 'Learning mode')}<select value={createMode} onChange={(e) => setCreateMode(e.target.value)} style={{ display: 'block', width: '100%', marginTop: 6, padding: 10, borderRadius: 8, border: '1px solid #D5DCE8' }}><option value="VIDEO_ONLY">{L('仅视频', 'Video only')}</option><option value="TEXT_ONLY">{L('仅文字', 'Text only')}</option><option value="VIDEO_AND_TEXT">{L('视频和文字', 'Video and text')}</option></select></label>
              <label style={{ fontSize: 13, fontWeight: 600 }}>{L('分类', 'Category')} *<select required value={createCategoryId} onChange={(e) => setCreateCategoryId(e.target.value)} style={{ display: 'block', width: '100%', marginTop: 6, padding: 10, borderRadius: 8, border: '1px solid #D5DCE8' }}><option value="">{L('请选择分类', 'Select a category')}</option>{catalogCategories.map((cat) => <option key={cat.id} value={cat.id}>{localizedName(locale, cat)}</option>)}</select></label>
            </div>
            <fieldset style={{ border: '1px solid #D5DCE8', borderRadius: 8, padding: 12, marginTop: 14 }}>
              <legend style={{ fontSize: 13, fontWeight: 600, padding: '0 4px' }}>{L('学习语言', 'Learning languages')} *</legend>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13 }}>
                {[['en-GB', languageLabel(locale, 'en-GB')], ['zh-CN', languageLabel(locale, 'zh-CN')]].map(([code, label]) => (
                  <label key={code} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={createLanguages.includes(code)}
                      onChange={(event) => setCreateLanguages((current) => event.target.checked
                        ? [...new Set([...current, code])]
                        : current.filter((language) => language !== code))}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div style={{ fontSize: 12, opacity: 0.65, marginTop: 6 }}>{L('学习语言创建后只能增加，不能删除。', 'Learning languages can only be added later, not removed.')}</div>
            </fieldset>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 24 }}>
              <button type="button" className="button buttonGhost" onClick={() => setShowCreate(false)}>{L('取消', 'Cancel')}</button>
              <button className="button" disabled={busy}>{busy ? L('创建中…', 'Creating…') : L('创建并编辑', 'Create and edit')}</button>
            </div>
          </form>
        </div>
      )}

      {(showImport || importJob) && (
        <div
          role="presentation"
          style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(16, 24, 40, 0.42)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) {
              setShowImport(false)
              setImportJob(null)
              setPackageFile(null)
              if (fileRef.current) fileRef.current.value = ''
            }
          }}
        >
          <div role="dialog" aria-modal="true" aria-labelledby="import-package-title" style={{ width: 'min(760px, 100%)', maxHeight: '90vh', overflowY: 'auto', background: '#fff', borderRadius: 16, padding: 24, boxShadow: '0 24px 64px rgba(16, 24, 40, 0.24)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 16 }}>
              <div>
                <h2 id="import-package-title" style={{ margin: 0, fontSize: 20 }}>{L('导入课程包', 'Import course package')}</h2>
                <p style={{ margin: '6px 0 0', fontSize: 13, opacity: 0.7 }}>{L('上传 .lgcourse.zip 或 .zip 课程包，系统会校验结构、课时、媒体和学习点。', 'Upload a .lgcourse.zip or .zip package. The system validates structure, lessons, media and learning points.')}</p>
              </div>
              <button type="button" aria-label={L('关闭', 'Close')} disabled={busy} onClick={() => { setShowImport(false); setImportJob(null); setPackageFile(null); if (fileRef.current) fileRef.current.value = '' }} style={{ border: 0, background: 'transparent', fontSize: 22, cursor: busy ? 'not-allowed' : 'pointer', lineHeight: 1, padding: 4 }}>×</button>
            </div>

            {!importJob && (
              <div
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  const file = event.dataTransfer.files?.[0]
                  if (file) void onPickFile(file)
                }}
                style={{ border: '2px dashed #B7C3D8', borderRadius: 12, padding: 28, textAlign: 'center', background: '#F7F9FC' }}
              >
                <div style={{ fontSize: 14, fontWeight: 600 }}>{packageFile ? packageFile.name : L('拖拽文件到此处，或点击选择文件', 'Drag a file here, or click to choose')}</div>
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>{L('支持 .zip / .lgcourse.zip', 'Supports .zip / .lgcourse.zip')}</div>
                <button type="button" className="button" disabled={busy} style={{ marginTop: 14 }} onClick={() => fileRef.current?.click()}>{L('选择文件', 'Choose file')}</button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".zip,.lgcourse.zip"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) void onPickFile(file)
                  }}
                />
              </div>
            )}

            {importJob && (
              <ImportPanel
                job={importJob}
                busy={busy}
                locale={locale}
                notice={confirmNotice}
                onConfirm={confirmImport}
                onIgnore={ignoreImport}
              />
            )}
          </div>
        </div>
      )}

      {statusCourse && (
        <div
          role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setStatusCourse(null) }}
          style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(16, 24, 40, 0.42)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
        >
          <div role="dialog" aria-modal="true" aria-labelledby="change-status-title" style={{ width: 'min(520px, 100%)', background: '#fff', borderRadius: 16, padding: 24, boxShadow: '0 24px 64px rgba(16, 24, 40, 0.24)' }}>
            <h2 id="change-status-title" style={{ margin: 0, fontSize: 20 }}>{L('更改状态', 'Change status')}</h2>
            <p style={{ margin: '8px 0 0', fontSize: 13, opacity: 0.7 }}>{statusCourse.code} · {statusCourse.title}</p>
            <p style={{ margin: '8px 0 0', fontSize: 12, opacity: 0.65 }}>{L('更改状态不会生成新版本。', 'Changing the status does not create a version.')}</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              {(['ONLINE', 'HIDDEN', 'OFFLINE'] as const).map((status) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => setStatusTarget(status)}
                  style={{
                    padding: '7px 12px',
                    borderRadius: 8,
                    border: '1px solid ' + (statusTarget === status ? '#2B58C8' : '#D5DCE8'),
                    background: statusTarget === status ? '#EEF3FF' : '#fff',
                    color: statusTarget === status ? '#2B58C8' : '#25314C',
                    fontWeight: statusTarget === status ? 700 : 400,
                    cursor: 'pointer',
                  }}
                >
                  {status === 'ONLINE' ? L('在线', 'Online') : status === 'HIDDEN' ? L('已隐藏', 'Hidden') : L('已下线', 'Offline')}
                  {statusCourse.liveStatus === status ? ` · ${L('当前', 'Current')}` : ''}
                </button>
              ))}
            </div>
            <label style={{ display: 'block', marginTop: 14, fontSize: 13, fontWeight: 600 }}>
              {L('原因', 'Reason')} *
              <textarea rows={3} value={statusReason} onChange={(event) => setStatusReason(event.target.value)} style={{ display: 'block', width: '100%', marginTop: 6, padding: 10, borderRadius: 8, border: '1px solid #D5DCE8', resize: 'vertical' }} />
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
              <button type="button" className="button buttonGhost" onClick={() => setStatusCourse(null)}>{L('取消', 'Cancel')}</button>
              <button type="button" className="button" disabled={busy || !statusReason.trim()} onClick={() => void changeCourseStatus()}>
                {busy ? L('更新中…', 'Updating…') : L('更改状态', 'Change status')}
              </button>
            </div>
          </div>
        </div>
      )}

      {loading && <p className="cardBody">{t(locale, 'common.loading')}</p>}

      {list && (
        <div className="tableWrap" style={{ marginTop: 16 }}>
          <table className="table" style={courseTable.tableStyle}>
            {courseTable.colGroup}
            <thead>
              <tr>
                <th>{L('课程', 'Course')}{courseTable.resizeHandle(0)}</th>
                <th>{L('课程 ID', 'Course ID')}{courseTable.resizeHandle(1)}</th>
                <th>{L('分类', 'Category')}{courseTable.resizeHandle(2)}</th>
                <th>{L('版本', 'Version')}{courseTable.resizeHandle(3)}</th>
                <th>{L('状态', 'Status')}{courseTable.resizeHandle(4)}</th>
                <th>{L('更新时间', 'Updated')}{courseTable.resizeHandle(5)}</th>
                <th>{L('操作', 'Actions')}{courseTable.resizeHandle(6)}</th>
              </tr>
            </thead>
            <tbody>
              {list.courses.map((course) => (
                <tr key={course.id}>
                  <td>
                    <button type="button" onClick={() => openCourse(course.id)} style={{ fontWeight: 600, background: 'none', border: 0, padding: 0, color: '#1d6bff', cursor: 'pointer', textAlign: 'left' }}>{course.title}</button>
                    <div style={{ opacity: 0.7, fontSize: 12 }}>
                      {learningModeLabel(locale, course.learningMode)} · {course.learningLanguages.map((language) => languageLabel(locale, language)).join(', ')} · {course.lessonCount} {L('课时', 'lessons')}
                      {course.trialEnabled ? ` · ${L('含试看', 'trial')}` : ''}
                    </div>
                  </td>
                  <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{course.code}</td>
                  <td>{course.category ? localizedName(locale, course.category) : '—'}</td>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontWeight: 600 }}>{course.liveVersionLabel ?? '—'}</span>
                      {course.hasDraft ? <span style={{ fontSize: 11, color: '#9A6B00' }}>{L('有未发布草稿', 'Draft not published')}</span> : <span style={{ fontSize: 11, opacity: 0.6 }}>{L('无草稿', 'No draft')}</span>}
                    </div>
                  </td>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {course.published ? (
                        <span style={{ color: course.liveStatus === 'ONLINE' ? '#1E7A3C' : '#5A6577', fontWeight: 600 }}>
                          {course.liveStatus === 'ONLINE' ? L('在线', 'Online') : course.liveStatus === 'HIDDEN' ? L('已隐藏', 'Hidden') : course.liveStatus === 'OFFLINE' ? L('已下线', 'Offline') : course.liveStatus}
                        </span>
                      ) : (
                        <span style={{ opacity: 0.65 }}>{L('未发布', 'Not published')}</span>
                      )}
                      {course.published && course.liveVersionWentLiveAt && <span style={{ fontSize: 11, opacity: 0.65 }}>{formatWhen(course.liveVersionWentLiveAt, locale)}</span>}
                    </div>
                  </td>
                  <td style={{ fontSize: 12, opacity: 0.8 }}>{formatWhen(course.updatedAt, locale)}</td>
                  <td>
                    <div style={{ position: 'relative', display: 'inline-block' }}>
                      <button
                        type="button"
                        className="button buttonGhost"
                        onClick={() => setActionMenuId((current) => (current === course.id ? null : course.id))}
                      >
                        {L('操作', 'Actions')} ▾
                      </button>
                      {actionMenuId === course.id && (
                        <div
                          style={{
                            position: 'absolute',
                            right: 0,
                            top: 'calc(100% + 4px)',
                            zIndex: 20,
                            minWidth: 170,
                            background: '#fff',
                            border: '1px solid #D5DCE8',
                            borderRadius: 10,
                            boxShadow: '0 12px 32px rgba(16, 24, 40, 0.18)',
                            padding: 6,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 4,
                          }}
                        >
                          <button type="button" className="button buttonGhost" style={{ justifyContent: 'flex-start' }} onClick={() => { setActionMenuId(null); openCourse(course.id) }}>{L('编辑内容', 'Edit content')}</button>
                          <button type="button" className="button buttonGhost" style={{ justifyContent: 'flex-start' }} onClick={() => { setActionMenuId(null); openCourse(course.id) }}>{L('版本', 'Versions')}</button>
                          <button
                            type="button"
                            className="button buttonGhost"
                            disabled={!course.published}
                            style={{ justifyContent: 'flex-start' }}
                            onClick={() => { setActionMenuId(null); if (course.published) setStatusCourse(course) }}
                            title={!course.published ? L('请先发布', 'Publish first') : undefined}
                          >
                            {L('更改状态', 'Change status')}
                          </button>
                          <button
                            type="button"
                            className="button buttonGhost"
                            disabled={busy || exportingId !== null}
                            style={{ justifyContent: 'flex-start' }}
                            onClick={() => { setActionMenuId(null); void exportCourse(course) }}
                          >
                            {exportingId === course.id ? L('导出中…', 'Exporting…') : L('导出', 'Export')}
                          </button>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {list.courses.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: 24, opacity: 0.7 }}>
                    {L('还没有课程。可以新建课程或导入课程包。', 'No courses yet. Create a course or import a course package.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        locale={locale}
        page={list?.page ?? page}
        pageSize={pageSize}
        total={list ? list.total : null}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size)
          setPage(1)
        }}
      />
    </section>
  )
}

function ImportPanel({
  job,
  busy,
  locale,
  notice,
  onConfirm,
  onIgnore,
}: {
  job: JobView
  busy: boolean
  locale: string
  notice: { kind: 'overwrite' | 'refused'; courseCode?: string } | null
  onConfirm: (onConflict: string, overwriteDraft?: boolean) => void
  onIgnore: () => void
}) {
  const zh = locale.startsWith('zh')
  const errors = job.report?.errors ?? []
  const warnings = job.report?.warnings ?? []
  // 后端在 AWAITING_CONFIRM 阶段就已预判 Course ID 是否已存在：
  // 在点「导入课程」之前就提示「覆盖草稿 / 已上线拒绝」，而不是点了之后才报错。
  const conflictNotice =
    job.status === 'AWAITING_CONFIRM' && job.conflict
      ? {
          kind: job.conflict.live ? ('refused' as const) : ('overwrite' as const),
          courseCode: job.conflict.existingCourseCode,
        }
      : null
  const effectiveNotice = notice ?? conflictNotice
  return (
    <div style={{ marginTop: 16, padding: 16, border: '1px solid #E8EDF5', borderRadius: 12 }}>
      <h3 style={{ margin: 0 }}>{zh ? '导入校验' : 'Import validation'}</h3>
      <p style={{ margin: '8px 0', fontSize: 13 }}>
        {zh ? '状态' : 'Status'}: <strong>{job.status}</strong>
        {job.package && (
          <>
            {' · '}{zh ? '课程' : 'Course'} {job.package.courseCode} · {job.package.lessons} {zh ? '课时' : 'lessons'} · {job.package.mediaFiles} {zh ? '媒体' : 'media'}
            {job.package.incomplete ? ' · incomplete' : ''}
          </>
        )}
      </p>
      {job.error && <div style={{ color: '#b42318', fontSize: 13, marginBottom: 8 }}>{serverText(job.error, locale as Locale)}</div>}
      {errors.length > 0 && (
        <div style={{ color: '#b42318', fontSize: 13 }}>
          {errors.map((e, i) => <div key={i}>{e.code}: {serverText(e.message, locale as Locale)}</div>)}
        </div>
      )}
      {warnings.length > 0 && (
        <details style={{ fontSize: 13, marginTop: 8 }}>
          <summary>{warnings.length} {zh ? '条警告' : 'warning(s)'}</summary>
          {warnings.map((w, i) => <div key={i} style={{ opacity: 0.8 }}>{w.code}: {serverText(w.message, locale as Locale)}</div>)}
        </details>
      )}
      {job.status === 'AWAITING_CONFIRM' && (
        <div style={{ marginTop: 12 }}>
          {effectiveNotice?.kind === 'overwrite' ? (
            <div style={{ fontSize: 13, background: '#FFF6E5', padding: '10px 12px', borderRadius: 8 }}>
              <p style={{ margin: 0, color: '#9A6B00' }}>
                {zh
                  ? `课程 ${effectiveNotice?.courseCode} 已存在（草稿状态，从未上线）。是否用本课程包覆盖其沙盒草稿？覆盖只影响草稿，线上内容不受影响。`
                  : `Course ${effectiveNotice?.courseCode} already exists as a draft (never published). Overwrite its sandbox draft with this package? Only the draft is replaced; live content is unaffected.`}
              </p>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="button" disabled={busy} onClick={() => onConfirm('ABORT', true)}>
                  {zh ? '覆盖草稿' : 'Overwrite draft'}
                </button>
                <button className="button buttonGhost" disabled={busy} onClick={onIgnore}>
                  {zh ? '忽略' : 'Ignore'}
                </button>
              </div>
            </div>
          ) : effectiveNotice?.kind === 'refused' ? (
            <div style={{ fontSize: 13, color: '#b42318', background: '#FDECEC', padding: '10px 12px', borderRadius: 8 }}>
              <p style={{ margin: 0 }}>
                {zh
                  ? `课程 ${effectiveNotice?.courseCode} 已上线，导入被拒绝。只能覆盖状态为草稿（从未发布）的课程，已上线课程的内容不受影响。`
                  : `Course ${effectiveNotice?.courseCode} is already live, so the import is refused. Only draft (never published) courses can be overwritten; live content is never affected.`}
              </p>
              <button className="button buttonGhost" style={{ marginTop: 10 }} disabled={busy} onClick={onIgnore}>
                {zh ? '知道了' : 'OK'}
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="button" disabled={busy} onClick={() => onConfirm('ABORT')}>
                {zh ? '导入课程' : 'Import course'}
              </button>
              <button className="button buttonGhost" disabled={busy} onClick={onIgnore}>
                {zh ? '取消本次导入' : 'Cancel import'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// 供 Sidebar 高亮使用
export const COURSE_MENU_SEGMENT = MENU_SEGMENT.course
