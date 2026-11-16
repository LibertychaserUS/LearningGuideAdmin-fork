import type { HistoryPage } from '../../contracts/course'

export function historyActionLabel(action: string, locale: string): string {
  const zh = locale.startsWith('zh')
  switch (action) {
    case 'PUBLISH':
      return zh ? '发布' : 'Publish'
    case 'DELETE_DRAFT':
      return zh ? '删除草稿' : 'Delete draft'
    case 'RESTORE':
      return zh ? '恢复版本' : 'Restore'
    case 'EXPORT_PACKAGE':
      return zh ? '导出课程包' : 'Export package'
    case 'IMPORT_PACKAGE':
      return zh ? '导入课程包' : 'Import package'
    case 'CHANGE_STATUS':
      return zh ? '更改状态' : 'Change status'
    case 'ADD_LEARNING_LANGUAGE':
      return zh ? '添加学习语言' : 'Add learning language'
    case 'OPERATIONS_PUBLISH':
      return zh ? '发布运营位' : 'Publish operations'
    case 'CREATE_COURSE':
      return zh ? '新建课程' : 'Create course'
    default:
      return action
  }
}

/** 学习语言代码 → PRD §21 展示名（固定文案，不随界面语言变化）。 */
function languageDisplayName(code: unknown): string {
  const value = String(code)
  if (value === 'zh-CN') return '中文'
  if (value === 'en-GB' || value === 'en') return 'English'
  return value
}

/** 学习模式枚举 → PRD §21 展示名，例如 "Video and Text"。 */
function learningModeDisplayName(mode: unknown): string | null {
  if (mode === null || mode === undefined || mode === '') return null
  switch (mode) {
    case 'VIDEO_ONLY':
      return 'Video only'
    case 'TEXT_ONLY':
      return 'Text only'
    case 'VIDEO_AND_TEXT':
      return 'Video and Text'
    default:
      return String(mode)
  }
}

/** 线上状态枚举 → PRD §21 展示名，例如 "Online" / "Hidden"。 */
function statusDisplayName(status: unknown): string {
  switch (status) {
    case 'ONLINE':
      return 'Online'
    case 'HIDDEN':
      return 'Hidden'
    case 'OFFLINE':
      return 'Offline'
    default:
      return String(status)
  }
}

export function historyDetailText(item: HistoryPage['items'][number], locale: string): string {
  const zh = locale.startsWith('zh')
  const detail =
    item.detail && typeof item.detail === 'object' ? (item.detail as Record<string, unknown>) : null
  if (!detail) return item.versionNo ? `v${item.versionNo}` : '—'
  const text = (value: unknown) =>
    value === null || value === undefined || value === '' ? '—' : String(value)
  const hasValue = (value: unknown) =>
    value !== null && value !== undefined && value !== ''
  // PRD §21 使用带 "Version " 前缀的版本展示名；沙箱版本号（3.4）自动补齐前缀，
  // 已经是 "Version N" 的记录不重复加。
  const versionText = (value: unknown) => {
    const label = text(value)
    return /^version\b/i.test(label) ? label : `Version ${label}`
  }
  const versionTransition = (from: unknown, to: unknown) =>
    hasValue(from) && hasValue(to)
      ? `${versionText(from)} → ${versionText(to)}`
      : null
  const languageList = (value: unknown) =>
    Array.isArray(value)
      ? value.map((entry) => languageDisplayName(entry)).join(', ')
      : languageDisplayName(value)
  switch (item.action) {
    case 'CREATE_COURSE': {
      // PRD §21 "C001 · Video and Text · English / Created from package C001_1.3.zip"
      const parts = [
        hasValue(detail.code) ? text(detail.code) : null,
        learningModeDisplayName(detail.learningMode),
        hasValue(detail.learningLanguages) ? languageList(detail.learningLanguages) : null,
      ].filter(Boolean)
      const createdFrom = hasValue(detail.sourcePackage)
        ? zh
          ? `由课程包创建 ${text(detail.sourcePackage)}`
          : `Created from package ${text(detail.sourcePackage)}`
        : null
      const base = parts.join(' · ')
      if (base && createdFrom) return `${base} / ${createdFrom}`
      return base || createdFrom || '—'
    }
    case 'PUBLISH': {
      // PRD §21 "Version 3 → Version 4 · learners notified"
      const transition = versionTransition(detail.from, detail.to)
      if (transition) {
        return [
          transition,
          detail.notifyLearners ? (zh ? '已通知学员' : 'learners notified') : null,
        ]
          .filter(Boolean)
          .join(' · ')
      }
      // 兼容旧记录：没有原值/新值时继续显示版本与来源。
      return [
        text(detail.versionLabel),
        detail.sourceEnvironment
          ? `${zh ? '来源' : 'from'} ${text(detail.sourceEnvironment)} ${text(detail.sourceVersionLabel)}`
          : null,
        detail.notifyLearners ? (zh ? '已通知学员' : 'learners notified') : null,
      ]
        .filter(Boolean)
        .join(' · ')
    }
    case 'DELETE_DRAFT': {
      // PRD §21 "Draft → Version 3"
      if (hasValue(detail.from) && hasValue(detail.to)) {
        return `${text(detail.from)} → ${versionText(detail.to)}`
      }
      return zh ? `保留 ${text(detail.keptVersion)}` : `Kept ${text(detail.keptVersion)}`
    }
    case 'RESTORE': {
      // PRD §21 "Version 1 → draft"：草稿单词小写。
      if (hasValue(detail.from) && hasValue(detail.to)) {
        return `${versionText(detail.from)} → draft`
      }
      return zh
        ? `从 ${text(detail.restoredFrom)} 恢复`
        : `Restored from ${text(detail.restoredFrom)}`
    }
    case 'CHANGE_STATUS':
      // PRD §21 "Online → Hidden · reason"
      return `${statusDisplayName(detail.from)} → ${statusDisplayName(detail.to)}${detail.reason ? ` · ${text(detail.reason)}` : ''}`
    case 'EXPORT_PACKAGE': {
      // PRD §21 "Version 3.4 · next publish starts 4.1"
      const version = versionText(detail.versionLabel)
      if (hasValue(detail.nextVersionLabel)) {
        return zh
          ? `${version} · 下次发布从 ${text(detail.nextVersionLabel)} 开始`
          : `${version} · next publish starts ${text(detail.nextVersionLabel)}`
      }
      return version
    }
    case 'IMPORT_PACKAGE':
      // PRD §21 "Draft replaced · C001_4.2.zip"
      if (hasValue(detail.from) && hasValue(detail.to)) {
        return `${text(detail.from)} ${zh ? '已替换' : 'replaced'} · ${text(detail.to)}`
      }
      return (
        [
          detail.versionLabel ? `${zh ? '版本' : 'Version'} ${text(detail.versionLabel)}` : null,
          detail.sourceVersionLabel
            ? `${zh ? '来源' : 'from'} ${text(detail.sourceVersionLabel)}`
            : null,
          detail.lessonCount !== undefined
            ? `${text(detail.lessonCount)} ${zh ? '课时' : 'lessons'}`
            : null,
        ]
          .filter(Boolean)
          .join(' · ') || '—'
      )
    case 'ADD_LEARNING_LANGUAGE':
      // PRD §21 "English → English, 中文"：原始语言列表 → 新语言列表。
      if (Array.isArray(detail.from) && Array.isArray(detail.to)) {
        return `${languageList(detail.from)} → ${languageList(detail.to)}`
      }
      if (hasValue(detail.from) && hasValue(detail.to)) {
        return `${languageDisplayName(detail.from)} → ${languageDisplayName(detail.to)}`
      }
      return '—'
    case 'OPERATIONS_PUBLISH':
      return (
        [
          detail.section ? `${zh ? '区域' : 'Section'} ${text(detail.section)}` : null,
          detail.reason ? `${zh ? '原因' : 'Reason'}: ${text(detail.reason)}` : null,
        ]
          .filter(Boolean)
          .join(' · ') || '—'
      )
    default:
      return (
        Object.entries(detail)
          .map(([key, value]) => `${key}: ${text(value)}`)
          .join(' · ') || '—'
      )
  }
}
