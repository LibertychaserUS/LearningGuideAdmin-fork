import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'

import type { FaqEvalSuite, FaqModelMiss, FaqReleaseEvalReport, FaqTextCollision } from '../contracts/helpdesk'
import { USD_TO_CNY } from '../lib/helpdeskGraph'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'

/**
 * 真流程检查的详情（release check v2）：版本历史里点「检查详情」展开，一个模块、几个页签，不加长页面
 *（owner 2026-10-31 页面长度规则）——套件（拦发布的与只看的）、切片（语言 / 写法）、问题（按轻重排好的清单）、
 * 花费（按层、按版本、缓存命中、省下多少）、重复问法（这一版新加的文字和别的卡几乎一样，只提醒）。
 * 没有 Figma 画板：沿用候选审核的页签（hdReviewTab）与版本表格的样式（待视觉验收）。每个页签内容区限高、自己滚动。
 */

type Tab = 'suites' | 'slices' | 'misses' | 'spend' | 'duplicates'

type Props = { locale: Locale; report: FaqReleaseEvalReport }

const pct = (value: number | undefined) => (typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : '—')
const cny = (usd: number | undefined) => `¥${((usd ?? 0) * USD_TO_CNY).toFixed(2)}`
const isSlice = (suite: FaqEvalSuite) => suite.id.startsWith('language:') || suite.id.startsWith('style:')

function suiteName(locale: Locale, suite: FaqEvalSuite): string {
  const [kind, value] = suite.id.split(':')
  const key = `helpDesk.releases.report.suite.${kind}`
  const text = t(locale, key, { value: value ?? '' })
  return text === key ? suite.label : text
}

type Limits = { wrongRateMax: number; sliceMin: number } | null

/** 这次检查用的门槛（报告的 receipt）；旧报告没有 → null，界面直接显示服务端的原因。 */
function limitsOf(report: FaqReleaseEvalReport): Limits {
  const { wrongRateMax, sliceMin } = report.receipt ?? {}
  return typeof wrongRateMax === 'number' && typeof sliceMin === 'number' ? { wrongRateMax, sliceMin } : null
}

/** 套件为什么没过（或为什么只看），按界面语言写；和服务端 policy.ts 判的是同一件事。 */
function reasonsOf(locale: Locale, suite: FaqEvalSuite, limits: Limits): string[] {
  if (!suite.rule || !limits) return suite.reasons
  const r = (key: string, vars: Record<string, string | number>) => t(locale, `helpDesk.releases.report.reason.${key}`, vars)
  const m = suite.metrics
  const max = pct(limits.wrongRateMax)
  const small = suite.rule === 'point' && (m.scored ?? 0) < limits.sliceMin
  const out: string[] = []
  if (suite.rule === 'interval' && (m.wrongRateHigh ?? 0) > limits.wrongRateMax) out.push(r('interval', { high: pct(m.wrongRateHigh), max }))
  if (suite.rule === 'point' && !small && (m.wrongRate ?? 0) > limits.wrongRateMax)
    out.push(r('point', { rate: pct(m.wrongRate), max, scored: m.scored ?? 0 }))
  if ((m.confirmedWorse ?? 0) > 0) out.push(r('worse', { count: m.confirmedWorse }))
  if (small) out.push(r('small', { min: limits.sliceMin }))
  return out
}

function SuiteTable({ locale, suites, limits }: { locale: Locale; suites: FaqEvalSuite[]; limits: Limits }) {
  if (suites.length === 0) return <p className="hdGraphHint">{t(locale, 'helpDesk.releases.report.noSuites')}</p>
  const sep = locale === 'zh-CN' ? '；' : '; '
  return (
    <table className="hdFaqTable hdReleaseTable hdCheckTable">
      <thead>
        <tr>
          {(['suite', 'status', 'n', 'wrong', 'worse', 'result'] as const).map((column) => (
            <th key={column} scope="col">
              {t(locale, `helpDesk.releases.report.columns.${column}`)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {suites.map((suite) => {
          const reasons = reasonsOf(locale, suite, limits)
          return (
            <tr key={suite.id}>
              <th scope="row">{suiteName(locale, suite)}</th>
              <td className="hdCheckNowrap">{t(locale, `helpDesk.releases.report.status.${suite.status}`)}</td>
              <td>{suite.n}</td>
              <td>
                {pct(suite.metrics.wrongRate)} <span className="hdGraphHint">({pct(suite.metrics.wrongRateHigh)})</span>
              </td>
              <td>{suite.metrics.confirmedWorse ?? 0}</td>
              <td>
                <span className={suite.passed ? 'hdReleasePass' : 'hdFieldError'}>
                  {t(locale, suite.passed ? 'helpDesk.releases.passed' : 'helpDesk.releases.failed')}
                </span>
                {reasons.length > 0 ? <span className="hdGraphHint hdReleaseHint">{reasons.join(sep)}</span> : null}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function MissTable({ locale, misses }: { locale: Locale; misses: FaqModelMiss[] }) {
  if (misses.length === 0) return <p className="hdGraphHint">{t(locale, 'helpDesk.releases.report.noMisses')}</p>
  return (
    <>
      <p className="hdGraphHint">{t(locale, 'helpDesk.releases.report.missesMore', { count: misses.length })}</p>
      <table className="hdFaqTable hdReleaseTable hdCheckTable">
        <thead>
          <tr>
            {(['why', 'text', 'expected', 'got', 'live'] as const).map((column) => (
              <th key={column} scope="col">
                {t(locale, `helpDesk.releases.report.missColumns.${column}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {misses.map((miss) => {
            const why = `helpDesk.releases.report.why.${miss.why}`
            const label = t(locale, why)
            return (
              <tr key={miss.id}>
                <td className={miss.why === 'newly_wrong' || miss.why === 'wrong_card' ? 'hdFieldError' : undefined}>
                  {label === why ? miss.why : label}
                </td>
                <td>
                  {miss.text}
                  {miss.onScreen ? (
                    <span className="hdGraphHint hdReleaseHint">{t(locale, 'helpDesk.releases.report.onScreen', { key: miss.onScreen })}</span>
                  ) : null}
                </td>
                <td>{miss.expected}</td>
                <td>{miss.got}</td>
                <td>{miss.live ?? '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}

function SpendView({ locale, metrics }: { locale: Locale; metrics: Record<string, number> }) {
  const s = (key: string) => t(locale, `helpDesk.releases.report.spend.${key}`)
  const row = (label: string, value: ReactNode) => (
    <tr key={label}>
      <th scope="row">{label}</th>
      <td>{value}</td>
    </tr>
  )
  const sep = locale === 'zh-CN' ? '；' : '; '
  const hits = (layer: 'Step' | 'Rerank' | 'Embed') => `${metrics[`cache${layer}Hits`] ?? 0} / ${metrics[`cache${layer}Misses`] ?? 0}`
  return (
    <div className="hdCheckSpend">
      <table className="hdFaqTable hdReleaseTable hdCheckTable">
        <caption className="hdFieldLabel">{s('byLayer')}</caption>
        <tbody>
          {row(s('model'), cny(metrics.costModelUsd))}
          {row(s('rerank'), cny(metrics.costRerankUsd))}
          {row(s('embed'), cny(metrics.costEmbedUsd))}
          {row(s('total'), <strong>{cny(metrics.costUsd)}</strong>)}
          {row(s('saved'), cny(metrics.savedUsd))}
        </tbody>
      </table>
      <table className="hdFaqTable hdReleaseTable hdCheckTable">
        <caption className="hdFieldLabel">{s('byVersion')}</caption>
        <tbody>
          {row(s('candidate'), cny(metrics.costCandidateUsd))}
          {row(s('live'), cny(metrics.costLiveUsd))}
          {row(s('checks'), cny(metrics.costChecksUsd))}
        </tbody>
      </table>
      <table className="hdFaqTable hdReleaseTable hdCheckTable">
        <caption className="hdFieldLabel">{s('cache')}</caption>
        <tbody>
          {row(s('model'), hits('Step'))}
          {row(s('rerank'), hits('Rerank'))}
          {row(s('embed'), hits('Embed'))}
        </tbody>
      </table>
      <p className="hdGraphHint">
        {t(locale, 'helpDesk.releases.report.spend.paid', { count: metrics.paidQuestions ?? 0 })}
        {sep}
        {t(locale, 'helpDesk.releases.report.spend.drift', {
          checked: metrics.driftChecked ?? 0,
          changed: metrics.driftChanged ?? 0,
        })}
        {(metrics.unpricedCalls ?? 0) > 0 ? `${sep}${t(locale, 'helpDesk.releases.report.spend.unpriced', { count: metrics.unpricedCalls })}` : null}
      </p>
    </div>
  )
}

function DuplicateList({ locale, pairs }: { locale: Locale; pairs: FaqTextCollision[] }) {
  return (
    <>
      <p className="hdGraphHint">{t(locale, 'helpDesk.releases.report.duplicates.hint')}</p>
      {pairs.length === 0 ? (
        <p className="hdGraphHint">{t(locale, 'helpDesk.releases.report.duplicates.none')}</p>
      ) : (
        <ul className="hdReleaseList hdCheckPairs">
          {pairs.map((pair) => (
            <li key={`${pair.added.key}\n${pair.added.text}\n${pair.other.key}\n${pair.other.text}`}>
              {t(locale, 'helpDesk.releases.report.duplicates.pair', {
                added: pair.added.key,
                addedText: pair.added.text,
                other: pair.other.key,
                otherText: pair.other.text,
              })}{' '}
              <span className="hdGraphHint">{pair.similarity.toFixed(3)}</span>
              {pair.byState ? <span className="hdGraphHint hdReleaseHint">{t(locale, 'helpDesk.releases.report.duplicates.byState')}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

export function FaqCheckReport({ locale, report }: Props) {
  const uid = useId()
  const suites = report.suites ?? []
  const limits = limitsOf(report)
  const misses = report.misses as unknown as FaqModelMiss[]
  const tabs: Tab[] = ['suites', 'slices', 'misses', 'spend', ...(report.collisions ? (['duplicates'] as const) : [])]
  const [tab, setTab] = useState<Tab>('suites')

  // 左右方向键在页签之间移动（WAI-ARIA tabs）
  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    const at = tabs.indexOf(tab)
    const next = tabs[(at + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
    setTab(next)
    document.getElementById(`${uid}-tab-${next}`)?.focus()
  }

  return (
    <section className="hdCheckReport" aria-label={t(locale, 'helpDesk.releases.report.label')}>
      <div className="hdReviewTabs hdCheckTabs" role="tablist" aria-label={t(locale, 'helpDesk.releases.report.label')} onKeyDown={onKey}>
        {tabs.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`${uid}-tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`${uid}-panel`}
            tabIndex={tab === key ? 0 : -1}
            className={`hdReviewTab${tab === key ? ' hdReviewTabOn' : ''}`}
            onClick={() => setTab(key)}
          >
            {t(locale, `helpDesk.releases.report.tabs.${key}`)}
            {key === 'misses' && misses.length > 0 ? ` ${misses.length}` : ''}
            {key === 'duplicates' && report.collisions && report.collisions.length > 0 ? ` ${report.collisions.length}` : ''}
          </button>
        ))}
      </div>
      <div className="hdCheckPanel" role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-tab-${tab}`} tabIndex={0}>
        {tab === 'suites' ? <SuiteTable locale={locale} limits={limits} suites={suites.filter((suite) => !isSlice(suite))} /> : null}
        {tab === 'slices' ? <SuiteTable locale={locale} limits={limits} suites={suites.filter(isSlice)} /> : null}
        {tab === 'misses' ? <MissTable locale={locale} misses={misses} /> : null}
        {tab === 'spend' ? <SpendView locale={locale} metrics={report.metrics} /> : null}
        {tab === 'duplicates' ? <DuplicateList locale={locale} pairs={report.collisions ?? []} /> : null}
      </div>
    </section>
  )
}
