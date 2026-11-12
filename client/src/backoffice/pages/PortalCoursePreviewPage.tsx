import type { CSSProperties } from 'react'
import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'

import type { PortalPreviewDetail } from '../contracts/course'
import { boRequest } from '../lib/api'
import { localizedName } from '../lib/i18n/localized'
import { L } from './course-editor/shared-utils';

/**
 * 自建「Portal 风格」课程预览页（2026-11-01）。
 *
 * Back Office「在 Portal 中预览」生成的链接落在这里：员工会话 + 短时效 token
 * 读取草稿/指定版本投影，并按 Portal 课程详情页的版式重新开发渲染，
 * 不依赖 Portal 站点新增路由，也不暴露未发布内容给公开页面。
 */

const PAGE_BG = '#F9FAFB'
const HERO_BG = '#17233A'
const CARD: CSSProperties = {
  background: '#fff',
  borderRadius: 12,
  boxShadow: '0 1px 3px rgba(0,0,0,0.10), 0 1px 2px -1px rgba(0,0,0,0.10)',
  padding: 30,
}

const PROVIDE_ICON: Record<string, string> = {
  VIDEO_TEXT: '🎬',
  EXHIBITS: '🖼️',
  AI_ASSISTANT: '🤖',
  AI_GUIDED: '🧭',
  READINGS: '📚',
  BILINGUAL: '🌐',
}

function textEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === 'string') return item
      if (!item || typeof item !== 'object') return ''
      const record = item as { title?: unknown; text?: unknown }
      return typeof record.title === 'string' ? record.title : typeof record.text === 'string' ? record.text : ''
    })
    .filter((entry): entry is string => Boolean(entry.trim()))
}

function provideEntries(value: unknown): Array<{ title: string; key: string | null }> {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      if (typeof item === 'string') return { title: item, key: null }
      if (!item || typeof item !== 'object') return { title: '', key: null }
      const record = item as { title?: unknown; text?: unknown; key?: unknown; type?: unknown }
      const title = typeof record.title === 'string' ? record.title : typeof record.text === 'string' ? record.text : ''
      const key =
        typeof record.key === 'string'
          ? record.key
          : typeof record.type === 'string'
            ? record.type.toUpperCase()
            : null
      return { title, key }
    })
    .filter((entry) => Boolean(entry.title.trim()))
}

function formatDuration(totalSeconds: number, locale: string): string {
  const minutes = Math.max(0, Math.round(totalSeconds / 60))
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (!hours) return `${rest}${L(locale, '分钟', ' min')}`
  return `${hours}${L(locale, '小时', ' h')}${rest}${L(locale, '分钟', ' min')}`
}

function formatPrice(amountMinor: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale === 'zh-CN' ? 'zh-CN' : 'en-GB', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(amountMinor / 100)
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency.toUpperCase()}`
  }
}

function contentBadges(contents: PortalPreviewDetail['sections'][number]['lessons'][number]['contents'], locale: string): string[] {
  const types = new Set(contents.map((content) => content.type))
  const badges: string[] = []
  if (types.has('video')) badges.push(L(locale, '视频', 'Video'))
  if (types.has('text') || types.has('pdf')) badges.push(L(locale, '文本', 'Text'))
  return badges
}

export function PortalCoursePreviewPage() {
  const { locale = 'en-GB', courseId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') ?? ''
  const [detail, setDetail] = useState<PortalPreviewDetail | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!courseId || !token) {
        setError(L(locale, '预览链接缺少课程或令牌。', 'The preview link is missing a course or token.'))
        setLoading(false)
        return
      }
      setLoading(true)
      const result = await boRequest<PortalPreviewDetail>(
        `/api/backoffice/courses/${courseId}/portal-preview/content?token=${encodeURIComponent(token)}`,
      )
      if (cancelled) return
      setLoading(false)
      if (result.success) {
        setDetail(result.data)
        setError('')
        return
      }
      setError(
        result.message || L(locale, '预览链接无效或已过期，请回到后台重新生成。', 'This preview link is invalid or has expired. Create a new one from the Back Office.'),
      )
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [courseId, token, locale])

  const backHref = `/${locale}/course/${courseId}`
  const noticeBody = (
    <div style={{ minHeight: '100vh', background: PAGE_BG, display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ ...CARD, maxWidth: 520, textAlign: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>
          {loading ? L(locale, '加载中…', 'Loading…') : L(locale, '预览不可用', 'Preview unavailable')}
        </h1>
        <p style={{ color: '#5A6577' }}>{loading ? '' : error}</p>
        {!loading && (
          <Link to={backHref} style={{ color: '#2B58C8', fontWeight: 600 }}>
            {L(locale, '返回课程编辑', 'Back to course editor')}
          </Link>
        )}
      </div>
    </div>
  )

  if (loading || error || !detail) return noticeBody

  const lessons = detail.sections.flatMap((section) => section.lessons)
  const outcomes = textEntries(detail.whatYouLearn)
  const provides = provideEntries(detail.provides)
  const bannerText =
    detail.preview.source === 'version'
      ? `${L(locale, '版本预览', 'Version preview')} ${detail.preview.versionLabel ?? ''}`
      : L(locale, '草稿预览（未发布）', 'Draft preview (not published)')
  const previewMediaUrl = (url: string) => {
    const match = /^\/api\/portal\/v1\/media\/[^/]+\/assets\/(.+)$/.exec(url)
    if (!match) return url
    return `/api/backoffice/courses/${detail.id}/portal-preview/media/${match[1]}?token=${encodeURIComponent(token)}`
  }
  const coverSrc = detail.coverUrl
    ? `/api/backoffice/courses/${detail.id}/portal-preview/cover?token=${encodeURIComponent(token)}`
    : null

  return (
    <div style={{ minHeight: '100vh', background: PAGE_BG, color: '#0A0A0A' }} data-portal-preview>
      <div
        data-preview-banner
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 14,
          padding: '10px 32px',
          background: '#FFF7E6',
          borderBottom: '1px solid #F5D58F',
          color: '#8A5A00',
          fontSize: 13,
        }}
      >
        <strong>{L(locale, '课程预览', 'Course preview')}</strong>
        <span>{bannerText}</span>
        <span>{L(locale, '仅供预览，不计入学习记录，也不影响订阅与购买。', 'Preview only. Progress, subscriptions and purchases are not affected.')}</span>
        <Link to={backHref} style={{ marginLeft: 'auto', color: '#8A5A00', fontWeight: 600 }}>
          {L(locale, '返回课程编辑', 'Back to course editor')}
        </Link>
      </div>

      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 32px', background: '#fff', borderBottom: '1px solid #E5E7EB' }}>
        <span style={{ fontWeight: 700, fontSize: 18, color: '#155DFC' }}>{L(locale, '学习指南', 'Learning Guide')}</span>
        <span style={{ color: '#7C7C7C', fontSize: 13 }}>{detail.code}</span>
      </header>

      <nav style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '16px 32px', background: '#fff', borderBottom: '1px solid #E5E7EB', fontSize: 14, color: '#7C7C7C' }}>
        <Link to={`/${locale}/course`} style={{ color: 'inherit' }}>{L(locale, '课程列表', 'Courses')}</Link>
        <span>›</span>
        {detail.category && <><span>{localizedName(locale, { name: detail.category, localized: detail.categoryLocalized })}</span><span>›</span></>}
        <span style={{ color: '#0A0A0A' }}>{detail.title}</span>
      </nav>

      <section style={{ position: 'relative', minHeight: 420, background: HERO_BG, color: '#fff', overflow: 'hidden' }}>
        {coverSrc && (
          <>
            <img src={coverSrc} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
            <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)' }} />
          </>
        )}
        <div style={{ position: 'relative', width: 'min(1200px, calc(100% - 64px))', margin: '0 auto', padding: '56px 0' }}>
          {detail.category && (
            <span style={{ display: 'inline-flex', alignItems: 'center', minHeight: 30, padding: '4px 12px', background: '#246BFD', borderRadius: 6, fontSize: 14 }}>{localizedName(locale, { name: detail.category, localized: detail.categoryLocalized })}</span>
          )}
          <h1 style={{ margin: '26px 0 20px', fontSize: 46, fontWeight: 600, lineHeight: 1.2 }}>{detail.title}</h1>
          <p style={{ maxWidth: 811, margin: 0, fontSize: 16, lineHeight: 1.4, color: 'rgba(255,255,255,0.72)' }}>{detail.shortDescription ?? ''}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, marginTop: 44, color: '#D1D5DC', fontSize: 15 }}>
            <span>{detail.lessonCount} {L(locale, '节课', 'lessons')}</span>
            <span style={{ borderLeft: '1px solid rgba(209,213,220,0.5)', paddingLeft: 20 }}>{formatDuration(detail.totalDurationSeconds, locale)}</span>
          </div>
        </div>
      </section>

      <div style={{ width: 'min(1280px, calc(100% - 64px))', margin: '32px auto 80px', display: 'grid', gridTemplateColumns: 'minmax(0, 2.2fr) minmax(0, 1fr)', alignItems: 'start', gap: 20 }}>
        <div style={{ display: 'grid', gap: 20 }}>
          <section style={CARD}>
            <h2 style={{ margin: 0, fontSize: 22 }}>{L(locale, '课程概览', 'Overview')}</h2>
            <p style={{ margin: '12px 0 0', fontSize: 14, lineHeight: 1.6, color: 'rgba(0,0,0,0.6)', whiteSpace: 'pre-line' }}>{detail.description ?? ''}</p>
            {outcomes.length > 0 && (
              <div style={{ marginTop: 24 }}>
                <h3 style={{ margin: '0 0 8px', fontSize: 17, color: '#155DFC' }}>{L(locale, '你将学到什么', "What you'll learn")}</h3>
                <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: '8px 24px', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', color: '#3C4B66', fontSize: 13 }}>
                  {outcomes.map((outcome) => (
                    <li key={outcome}>✓ {outcome}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section style={CARD}>
            <h2 style={{ margin: 0, fontSize: 22 }}>{L(locale, '课程大纲', 'Curriculum')}</h2>
            <div style={{ display: 'flex', gap: 24, margin: '10px 0 16px', color: '#99A1AF', fontSize: 14 }}>
              <span>{detail.lessonCount} {L(locale, '节课', 'lessons')}</span>
              <span>{formatDuration(detail.totalDurationSeconds, locale)}</span>
            </div>
            {lessons.length === 0 ? (
              <p style={{ color: '#5A6577', fontSize: 13 }}>{L(locale, '该课程还没有课时。', 'This course has no lessons yet.')}</p>
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                {lessons.map((lesson, index) => {
                  const badges = contentBadges(lesson.contents, locale)
                  const videoSource = lesson.contents.find((content) => content.type === 'video' && content.url)
                  const textContents = lesson.contents.filter((content) => content.type === 'text' && content.html)
                  return (
                    <article
                      key={lesson.id}
                      style={{ display: 'grid', gap: 14, padding: '16px 18px', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 8 }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20 }}>
                        <div style={{ minWidth: 0 }}>
                          <h3 style={{ display: 'flex', gap: 14, alignItems: 'baseline', margin: '0 0 8px', fontSize: 16, fontWeight: 500, color: '#596478' }}>
                            <span>{L(locale, '课时', 'Lesson')} {index + 1}</span>
                            <span>{lesson.title}</span>
                            {lesson.isPublic && <span style={{ fontSize: 11, color: '#155DFC' }}>{L(locale, '试看', 'Trial')}</span>}
                          </h3>
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, color: '#99A1AF', fontSize: 13 }}>
                            <time style={{ flex: '0 0 64px', borderRight: '1px solid rgba(0,0,0,0.1)', minHeight: 30 }}>
                              {lesson.durationSeconds ? formatDuration(lesson.durationSeconds, locale) : '—'}
                            </time>
                            <span style={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' } as CSSProperties}>{lesson.summary ?? ''}</span>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                          {badges.map((badge) => (
                            <span key={badge} style={{ padding: '4px 10px', borderRadius: 999, background: '#EEF4FF', color: '#155DFC', fontSize: 12 }}>{badge}</span>
                          ))}
                        </div>
                      </div>
                      {lesson.trial?.videoCutoffSeconds ? (
                        <p style={{ margin: 0, fontSize: 12, color: '#155DFC' }}>
                          {L(locale, '试看范围', 'Trial')}：{formatDuration(lesson.trial.videoCutoffSeconds, locale)}
                        </p>
                      ) : null}
                      {videoSource?.url && (
                        <video
                          controls
                          preload="metadata"
                          style={{ width: '100%', maxHeight: 420, background: '#000', borderRadius: 8 }}
                          src={previewMediaUrl(videoSource.url)}
                        />
                      )}
                      {textContents.map((content) => (
                        <div
                          key={content.id}
                          style={{ lineHeight: 1.7, fontSize: 14 }}
                          dangerouslySetInnerHTML={{ __html: content.html ?? '' }}
                        />
                      ))}
                      {lesson.contents.some((content) => content.type === 'video' && content.nodes?.length) && (
                        <ul style={{ margin: 0, paddingLeft: 18, color: '#5A6577', fontSize: 13 }}>
                          {lesson.contents
                            .filter((content) => content.type === 'video')
                            .flatMap((content) => content.nodes ?? [])
                            .map((node) => (
                              <li key={node.id}>
                                {node.title}
                                {node.triggerTime ? ` · ${formatDuration(node.triggerTime, locale)}` : ''}
                              </li>
                            ))}
                        </ul>
                      )}
                    </article>
                  )
                })}
              </div>
            )}
            <p style={{ margin: '16px 0 0', color: '#99A1AF', fontSize: 12 }}>
              {L(
                locale,
                '预览使用与正式 Portal 相同的课程投影数据；视频/正文来自同一个课程资产库（草稿内容仅员工可见）。试看范围以「学员视角预览」中的截止点为准。',
                'This preview uses the same course projection data as the live Portal. Video and text come from the same course asset store (drafts are staff-only). Trial cut-offs follow the learner view preview.',
              )}
            </p>
          </section>
        </div>

        <aside style={{ display: 'grid', gap: 20 }}>
          <section style={CARD}>
            <h2 style={{ margin: 0, fontSize: 22 }}>{L(locale, '本课程提供', 'This course provides')}</h2>
            <ul style={{ margin: '20px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: 14 }}>
              {(provides.length ? provides : []).map((item, index) => (
                <li key={`${item.title}-${index}`} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14 }}>
                  <span aria-hidden="true">{PROVIDE_ICON[item.key ?? ''] ?? '•'}</span>
                  <span>{item.title}</span>
                </li>
              ))}
              {provides.length === 0 && <li style={{ color: '#99A1AF', fontSize: 13 }}>{L(locale, '尚未填写。', 'Not provided yet.')}</li>}
            </ul>
          </section>

          {detail.plans.length > 0 && (
            <section style={{ ...CARD, padding: '20px 24px 24px', background: '#F0F7FF', border: '1px solid #D6E3F7', boxShadow: 'none' }}>
              <h2 style={{ margin: '0 0 12px', fontSize: 16, color: '#135BC7' }}>{L(locale, '订阅计划', 'Subscription plans')}</h2>
              {detail.plans.map((plan) => (
                <p key={plan.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '0 0 10px', color: '#0E1C33' }}>
                  <strong style={{ fontSize: 26 }}>{formatPrice(plan.amountMinor, plan.currency, locale)}</strong>
                  <span style={{ fontSize: 13 }}>/ {plan.termMonths} {L(locale, '个月', 'months')}</span>
                  <span style={{ fontSize: 13, color: '#5A6577' }}>{plan.name}</span>
                </p>
              ))}
            </section>
          )}

          <section style={{ ...CARD, padding: '20px 24px' }}>
            <h2 style={{ margin: '0 0 12px', fontSize: 16 }}>{L(locale, '课程信息', 'Course information')}</h2>
            <dl style={{ margin: 0, display: 'grid', gap: 8, fontSize: 13, color: '#5A6577' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <dt>{L(locale, '学习模式', 'Learning mode')}</dt>
                <dd style={{ margin: 0, color: '#0A0A0A' }}>{detail.learningMode ?? '—'}</dd>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <dt>{L(locale, '学习语言', 'Learning languages')}</dt>
                <dd style={{ margin: 0, color: '#0A0A0A' }}>
                  {detail.learningLanguages.map((language) => (language === 'zh-CN' ? '中文' : 'English')).join(' / ')}
                </dd>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <dt>{L(locale, '课程代码', 'Course code')}</dt>
                <dd style={{ margin: 0, color: '#0A0A0A' }}>{detail.code}</dd>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <dt>{L(locale, '短名', 'Slug')}</dt>
                <dd style={{ margin: 0, color: '#0A0A0A' }}>{detail.slug}</dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>

      <footer style={{ padding: '24px 32px', background: '#fff', borderTop: '1px solid #E5E7EB', color: '#99A1AF', fontSize: 12 }}>
        © 2026 Learning Guide · {L(locale, '预览模式，未发布内容不会对外公开。', 'Preview mode. Unpublished content stays private.')}
      </footer>
    </div>
  )
}
