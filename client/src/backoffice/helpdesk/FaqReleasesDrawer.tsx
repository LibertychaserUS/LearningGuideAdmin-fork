import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

import type {
  FaqGraphCheckResult,
  FaqNodeRef,
  FaqRelease,
  FaqReleaseList,
  FaqSnapshotDiff,
  FaqSnapshotEdge,
  FaqWorkingCopy,
  GraphProblem,
} from '../contracts/helpdesk'
import {
  checkRelease,
  createRelease,
  getReleaseDiff,
  getWorkingCopy,
  listReleases,
  publishRelease,
  rollbackRelease,
  watchReleases,
  type HelpdeskResult,
} from '../lib/helpdeskApi'
import { errorMessage } from '../lib/helpdeskFormat'
import {
  diffTotal,
  evalRecall,
  modelReport,
  releaseActions,
  releaseStatusKey,
  USD_TO_CNY,
} from '../lib/helpdeskGraph'
import { cardTime, longDate } from '../lib/helpdeskView'
import { FaqCheckReport } from './FaqCheckReport'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { useModal } from './useModal'

/**
 * 「发布新版本」（helpdesk-v5-faq-graph-design §2.2 / §5.4）：
 * - 当前上线的版本；工作副本相对它的差异（问题、连接新增 / 修改 / 移除，问法增减）与图检查；
 * -「发布新版本」冻结工作副本 → 图检查 → 评测门（服务端），结果写进版本历史；工作副本没变 → 不新建；
 * - 版本历史：状态、检查、评测（recall@8）、每个版本的改动；能发布的「发布 vN」，曾经上线过的「回滚到此版本」
 *  （发布与回滚都先确认）；draft / rejected 可「重新检查」。
 * 检查在后台跑（owner 2026-11-03：检索检查 + 真流程检查；2026-11-06 起全部开发题、逐题和线上比，约 5–10 分钟）：抽屉开着时一直连着版本列表的
 * 长连接（SSE，watchReleases），进度和结果由服务端推，不定时重读；心跳停了显示「检查中断」，可以重新检查。
 * 写操作只给 helpDesk = FULL（服务端同样拒绝）；VIEW 只看。没有 Figma 画板：沿用 FAQ 抽屉、表格与确认框的
 * 样式（待视觉验收）。模态层同 FAQ 抽屉（useModal）。
 */

type Props = { locale: Locale; canWrite: boolean; onClose: () => void }
type Confirm = { action: 'publish' | 'rollback'; version: number } | null
type Notice = { tone: 'status' | 'alert'; text: string } | null

function ruleText(locale: Locale, problem: GraphProblem): string {
  const key = `helpDesk.graph.rules.${problem.rule}`
  const text = t(locale, key)
  return text === key ? problem.detail : text
}

const when = (iso: string | null, locale: Locale) => (iso ? `${longDate(iso, locale)} ${cardTime(iso, locale)}` : '—')

export function FaqReleasesDrawer({ locale, canWrite, onClose }: Props) {
  const uid = useId()
  const zh = locale === 'zh-CN'
  const [list, setList] = useState<FaqReleaseList | null>(null)
  const [working, setWorking] = useState<FaqWorkingCopy | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [diffs, setDiffs] = useState<Record<number, FaqSnapshotDiff | 'loading'>>({})
  // 展开了「检查详情」的版本
  const [details, setDetails] = useState<ReadonlySet<number>>(new Set())
  const drawerRef = useRef<HTMLElement>(null)
  const confirmRef = useRef<HTMLDivElement>(null)
  const confirmFocus = useRef<HTMLButtonElement>(null)
  // 打开确认框的按钮：取消（按钮或 Escape）后焦点还给它
  const confirmOpener = useRef<HTMLElement | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const noticeRef = useRef<HTMLDivElement>(null)

  useModal(
    () => confirmRef.current ?? drawerRef.current,
    () => (confirm ? setConfirm(null) : onClose()),
  )

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => opener?.focus?.()
  }, [])

  useEffect(() => {
    if (confirm) confirmFocus.current?.focus()
    else if (confirmOpener.current) {
      confirmOpener.current.focus()
      confirmOpener.current = null
    }
  }, [confirm])

  function ask(next: NonNullable<Confirm>, opener: HTMLElement) {
    confirmOpener.current = opener
    setConfirm(next)
  }

  useEffect(() => {
    if (notice) noticeRef.current?.focus()
  }, [notice])

  function apply([releases, copy]: [HelpdeskResult<FaqReleaseList>, HelpdeskResult<FaqWorkingCopy>]) {
    if (releases.ok) setList(releases.data)
    if (copy.ok) setWorking(copy.data)
    const failed = !releases.ok ? releases : !copy.ok ? copy : null
    setLoadError(failed && !failed.ok ? failed.code : null)
  }

  const load = () => Promise.all([listReleases(), getWorkingCopy()]).then(apply)

  useEffect(() => {
    let live = true
    void Promise.all([listReleases(), getWorkingCopy()]).then((results) => {
      if (live) apply(results)
    })
    return () => {
      live = false
    }
    // 只在打开时读一次；之后每个写操作成功后 load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 抽屉开着就连着：后台检查的进度、结果、中断都由服务端推过来（关掉抽屉就断开）
  useEffect(() => watchReleases(setList) ?? undefined, [])

  const nameOf = (node: { questionEn: string; questionZh: string }) => (zh ? node.questionZh : node.questionEn)

  /** 一个写操作：成功后重读历史与工作副本，提示结果（焦点给提示）。 */
  async function act(work: () => Promise<HelpdeskResult<FaqRelease>>, success: (release: FaqRelease) => string) {
    if (busy) return
    setBusy(true)
    setNotice(null)
    const result = await work()
    if (result.ok) {
      await load()
      setNotice({ tone: 'status', text: success(result.data) })
    } else setNotice({ tone: 'alert', text: errorMessage(locale, result.code) })
    setBusy(false)
  }

  function create() {
    const known = new Set((list?.releases ?? []).map((release) => release.version))
    void act(createRelease, (release) =>
      known.has(release.version)
        ? t(locale, 'helpDesk.releases.sameAsLatest', { version: release.version })
        : t(locale, release.status === 'evaluating' ? 'helpDesk.releases.createdChecking' : 'helpDesk.releases.created', {
            version: release.version,
          }),
    )
  }

  function confirmed() {
    if (!confirm) return
    const { action, version } = confirm
    // 确认了：焦点交给结果提示（act 之后），不回到按钮
    confirmOpener.current = null
    setConfirm(null)
    if (action === 'publish')
      void act(
        () => publishRelease(version),
        (release) => t(locale, 'helpDesk.releases.publishedNotice', { version: release.version }),
      )
    else
      void act(
        () => rollbackRelease(version),
        (release) => t(locale, 'helpDesk.releases.rolledBack', { version: release.version }),
      )
  }

  async function toggleDiff(version: number) {
    if (diffs[version]) {
      setDiffs(({ [version]: _gone, ...rest }) => rest)
      return
    }
    setDiffs((current) => ({ ...current, [version]: 'loading' }))
    const result = await getReleaseDiff(version)
    if (result.ok) setDiffs((current) => ({ ...current, [version]: result.data.diff }))
    else {
      setDiffs(({ [version]: _gone, ...rest }) => rest)
      setNotice({ tone: 'alert', text: errorMessage(locale, result.code) })
    }
  }

  const live = list?.releases.find((release) => release.version === list.published) ?? null

  function edgeName(edge: FaqSnapshotEdge, refs: Map<string, FaqNodeRef>): string {
    const name = (id: string) => {
      const ref = refs.get(id)
      return ref ? nameOf(ref) : id
    }
    return t(locale, 'helpDesk.releases.diff.edge', { parent: name(edge.parentId), child: name(edge.childId) })
  }

  function diffView(diff: FaqSnapshotDiff): ReactNode {
    if (diff.same) return <p className="hdGraphHint">{t(locale, 'helpDesk.releases.noChanges')}</p>
    const refs = new Map<string, FaqNodeRef>()
    for (const node of [...diff.nodes.added, ...diff.nodes.removed, ...diff.nodes.changed]) refs.set(node.id, node)
    const fields = (names: string[]) => names.map((name) => t(locale, `helpDesk.releases.fields.${name}`)).join(', ')
    const group = (key: string, items: ReactNode[]) =>
      items.length === 0 ? null : (
        <div className="hdReleaseGroup" key={key}>
          <p className="hdFieldLabel">{t(locale, `helpDesk.releases.diff.${key}`, { count: items.length })}</p>
          <ul className="hdReleaseList">{items}</ul>
        </div>
      )
    return (
      <div className="hdReleaseDiff">
        {group(
          'nodesAdded',
          diff.nodes.added.map((node) => <li key={node.id}>{nameOf(node)}</li>),
        )}
        {group(
          'nodesChanged',
          diff.nodes.changed.map((node) => (
            <li key={node.id}>
              {nameOf(node)} <span className="hdGraphHint">({fields(node.fields)})</span>
            </li>
          )),
        )}
        {group(
          'nodesRemoved',
          diff.nodes.removed.map((node) => <li key={node.id}>{nameOf(node)}</li>),
        )}
        {group(
          'edgesAdded',
          diff.edges.added.map((edge) => <li key={`${edge.parentId}>${edge.childId}`}>{edgeName(edge, refs)}</li>),
        )}
        {group(
          'edgesChanged',
          diff.edges.changed.map((change) => (
            <li key={`${change.after.parentId}>${change.after.childId}`}>
              {edgeName(change.after, refs)} <span className="hdGraphHint">({fields(change.fields)})</span>
            </li>
          )),
        )}
        {group(
          'edgesRemoved',
          diff.edges.removed.map((edge) => <li key={`${edge.parentId}>${edge.childId}`}>{edgeName(edge, refs)}</li>),
        )}
        {diff.phrasings.added + diff.phrasings.removed > 0 ? (
          <p className="hdGraphHint">{t(locale, 'helpDesk.releases.diff.phrasings', diff.phrasings)}</p>
        ) : null}
      </div>
    )
  }

  function checksView(checks: FaqGraphCheckResult): ReactNode {
    return (
      <div className="hdReleaseChecks">
        <p className={checks.passed ? 'hdReleasePass' : 'hdFieldError'}>
          {checks.passed
            ? t(locale, 'helpDesk.releases.checksPassed')
            : t(locale, 'helpDesk.releases.checksFailed', { count: checks.problems.length })}
        </p>
        <p className="hdGraphHint">{t(locale, 'helpDesk.releases.counts', checks.counts)}</p>
        {checks.problems.length > 0 ? (
          <ul className="hdReleaseList hdReleaseProblems">
            {checks.problems.map((problem, index) => (
              <li key={`${problem.rule}-${problem.nodeId ?? ''}-${index}`} className="hdFieldError">
                {problem.key ? <strong>{problem.key}</strong> : null}
                {problem.key ? ': ' : null}
                {ruleText(locale, problem)}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    )
  }

  /** 检查中：做到哪一步了。 */
  function progressText(release: FaqRelease): string {
    const progress = release.evaluation?.progress
    if (!progress) return t(locale, 'helpDesk.releases.progress.starting')
    const key = `helpDesk.releases.progress.${progress.stage}`
    const text = t(locale, key, { done: progress.done, total: progress.total })
    return text === key ? t(locale, 'helpDesk.releases.progress.starting') : text
  }

  /** 真流程检查的一行（错卡率、题数、花费）；没有这一份 → null。 */
  function modelText(release: FaqRelease): { text: string; hint: string | null } | null {
    const model = modelReport(release.evalReport)
    if (!model) return null
    const { wrongRate, cases, costUsd } = model.metrics ?? {}
    if (typeof wrongRate !== 'number' || typeof cases !== 'number' || cases === 0)
      return { text: t(locale, 'helpDesk.releases.modelNotRun'), hint: model.summary }
    return {
      text: t(locale, 'helpDesk.releases.model', {
        result: t(locale, model.passed ? 'helpDesk.releases.passed' : 'helpDesk.releases.failed'),
        wrong: (wrongRate * 100).toFixed(1),
        cases,
        cny: ((costUsd ?? 0) * USD_TO_CNY).toFixed(2),
      }),
      hint: model.passed ? null : model.summary,
    }
  }

  /** 「发布新版本」之前的估计（服务端按上线版本那次检查估）；没有 → null。 */
  function estimateText(): string | null {
    const estimate = working?.estimate
    if (!estimate) return null
    const vars = {
      questions: estimate.questions,
      single: estimate.single,
      followups: estimate.followups,
      paid: estimate.paid,
      cny: ((estimate.usd ?? 0) * USD_TO_CNY).toFixed(2),
      cap: (estimate.budgetUsd * USD_TO_CNY).toFixed(0),
    }
    return t(locale, estimate.basis === 'last_check' && estimate.usd !== null ? 'helpDesk.releases.estimate' : 'helpDesk.releases.estimateFirst', vars)
  }

  function toggleDetails(version: number) {
    setDetails((current) => {
      const next = new Set(current)
      if (next.has(version)) next.delete(version)
      else next.add(version)
      return next
    })
  }

  function evalText(release: FaqRelease): string {
    const report = release.evalReport
    if (!report || report.kind === 'skipped') return t(locale, 'helpDesk.releases.notRun')
    if (report.kind === 'rollback' && release.sourceVersion !== null)
      return t(locale, 'helpDesk.releases.rollbackOf', { version: release.sourceVersion })
    const recall = evalRecall(report)
    if (recall === null) return t(locale, report.passed ? 'helpDesk.releases.passed' : 'helpDesk.releases.failed')
    const value = (recall * 100).toFixed(1)
    return t(locale, report.passed ? 'helpDesk.releases.recall' : 'helpDesk.releases.recallFailed', { value })
  }

  return (
    <div className="hdDrawerLayer">
      <div className="hdDrawerBackdrop" aria-hidden="true" onClick={() => (confirm ? undefined : onClose())} />
      <aside ref={drawerRef} className="hdDrawer hdReleasesDrawer" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`}>
        <header className="hdDrawerHead">
          <div className="hdDrawerHeading">
            <h2 className="hdDrawerTitle" id={`${uid}-title`}>
              {t(locale, 'helpDesk.releases.title')}
            </h2>
            <p className="hdDrawerSubtitle">{t(locale, 'helpDesk.releases.subtitle')}</p>
          </div>
          <button ref={closeRef} type="button" className="hdDrawerClose" aria-label={t(locale, 'helpDesk.drawer.close')} onClick={onClose}>
            ×
          </button>
        </header>

        <div className="hdDrawerBody" aria-busy={busy || list === null}>
          {notice ? (
            <div
              ref={noticeRef}
              tabIndex={-1}
              className={`hdNotice hdDrawerNotice${notice.tone === 'alert' ? ' hdDrawerAlert' : ''}`}
              role={notice.tone}
            >
              {notice.text}
            </div>
          ) : null}
          {loadError ? (
            <div className="hdNotice hdDrawerNotice hdDrawerAlert" role="alert">
              {errorMessage(locale, loadError)}
            </div>
          ) : null}
          {list === null && !loadError ? <p className="hdGraphHint">{t(locale, 'helpDesk.releases.loading')}</p> : null}

          {list ? (
            <p className="hdReleaseLive">
              {list.published !== null ? t(locale, 'helpDesk.releases.live', { version: list.published }) : t(locale, 'helpDesk.releases.none')}
            </p>
          ) : null}

          {working ? (
            <section className="hdGraphSection" aria-labelledby={`${uid}-working`}>
              <h3 className="hdGraphTitle" id={`${uid}-working`}>
                {t(locale, 'helpDesk.releases.working')}
              </h3>
              {diffView(working.diff)}
              <h4 className="hdFieldLabel hdReleaseHeading">{t(locale, 'helpDesk.releases.checks')}</h4>
              {checksView(working.checks)}
              {canWrite ? (
                <div className="hdGraphFormActions">
                  <button
                    type="button"
                    className="hdDrawerButton hdDrawerPrimary"
                    disabled={busy}
                    aria-describedby={`${uid}-create-hint`}
                    onClick={create}
                  >
                    {t(locale, busy ? 'helpDesk.releases.creating' : 'helpDesk.releases.create')}
                  </button>
                  <span className="hdGraphHint" id={`${uid}-create-hint`}>
                    {t(locale, 'helpDesk.releases.createHint')}
                    {diffTotal(working.diff) === 0 && list?.published !== null ? ` ${t(locale, 'helpDesk.releases.noChanges')}` : ''}
                    {estimateText() ? <span className="hdReleaseHint hdReleaseEstimate">{estimateText()}</span> : null}
                  </span>
                </div>
              ) : null}
            </section>
          ) : null}

          {list ? (
            <section className="hdGraphSection" aria-labelledby={`${uid}-history`}>
              <h3 className="hdGraphTitle" id={`${uid}-history`}>
                {t(locale, 'helpDesk.releases.history')}
              </h3>
              {list.releases.length === 0 ? <p className="hdGraphHint">{t(locale, 'helpDesk.releases.empty')}</p> : null}
              {list.releases.length > 0 ? (
                <div className="hdFaqTableWrap">
                  <table className="hdFaqTable hdReleaseTable">
                    <thead>
                      <tr>
                        {(['version', 'status', 'published', 'result', 'actions'] as const).map((column) => (
                          <th key={column} scope="col">
                            {t(locale, `helpDesk.releases.columns.${column}`)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...list.releases]
                        .sort((a, b) => b.version - a.version)
                        .map((release) => {
                          const actions = releaseActions(release, list.published, live)
                          const diff = diffs[release.version]
                          const model = modelReport(release.evalReport)
                          const hasDetails = Boolean(model?.suites) && release.status !== 'evaluating'
                          const open = hasDetails && details.has(release.version)
                          return [
                            <tr key={release.version}>
                              <th scope="row">v{release.version}</th>
                              <td>
                                <span className={`hdFaqChip hdReleaseStatus hdReleaseStatus-${releaseStatusKey(release)}`}>
                                  {t(locale, `helpDesk.releases.status.${releaseStatusKey(release)}`)}
                                </span>
                              </td>
                              <td className="hdFaqDate">
                                {when(release.publishedAt, locale)}
                                <span className="hdGraphHint hdReleaseCreated">
                                  {t(locale, 'helpDesk.releases.createdOn', { date: when(release.createdAt, locale) })}
                                </span>
                              </td>
                              <td>
                                <span className="hdReleaseResult">
                                  {t(locale, 'helpDesk.releases.checksValue', {
                                    result: release.checks
                                      ? t(locale, release.checks.passed ? 'helpDesk.releases.passed' : 'helpDesk.releases.failed')
                                      : t(locale, 'helpDesk.releases.notRun'),
                                  })}
                                </span>
                                {release.status === 'evaluating' ? (
                                  release.evaluation?.state === 'interrupted' ? (
                                    <span className="hdGraphHint hdReleaseResult">{t(locale, 'helpDesk.releases.interruptedHint')}</span>
                                  ) : (
                                    <span className="hdReleaseResult hdReleaseProgress" role="status">
                                      {progressText(release)}
                                    </span>
                                  )
                                ) : (
                                  <>
                                    <span className="hdReleaseResult">{evalText(release)}</span>
                                    {release.evalReport && release.evalReport.misses.length > 0 && release.evalReport.kind !== 'model' ? (
                                      <span className="hdGraphHint hdReleaseResult">
                                        {t(locale, 'helpDesk.releases.misses', { count: release.evalReport.misses.length })}
                                      </span>
                                    ) : null}
                                    {(() => {
                                      const line = modelText(release)
                                      return line ? (
                                        <span className="hdReleaseResult" title={line.hint ?? undefined}>
                                          {line.text}
                                          {line.hint ? <span className="hdGraphHint hdReleaseHint">{line.hint}</span> : null}
                                        </span>
                                      ) : null
                                    })()}
                                  </>
                                )}
                              </td>
                              <td>
                                <div className="hdReleaseActions">
                                  <button
                                    type="button"
                                    className="hdLinkButton"
                                    aria-expanded={Boolean(diff)}
                                    onClick={() => void toggleDiff(release.version)}
                                  >
                                    {diff ? t(locale, 'helpDesk.releases.hideChanges') : t(locale, 'helpDesk.releases.showChanges', { version: release.version })}
                                  </button>
                                  {hasDetails ? (
                                    <button
                                      type="button"
                                      className="hdLinkButton"
                                      aria-expanded={open}
                                      onClick={() => toggleDetails(release.version)}
                                    >
                                      {t(locale, open ? 'helpDesk.releases.hideDetails' : 'helpDesk.releases.details')}
                                    </button>
                                  ) : null}
                                  {canWrite && actions.publish ? (
                                    <button
                                      type="button"
                                      className="hdDrawerButton hdDrawerPrimary"
                                      disabled={busy}
                                      onClick={(event) => ask({ action: 'publish', version: release.version }, event.currentTarget)}
                                    >
                                      {t(locale, 'helpDesk.releases.publish', { version: release.version })}
                                    </button>
                                  ) : null}
                                  {canWrite && actions.recheck ? (
                                    <button
                                      type="button"
                                      className="hdDrawerButton"
                                      disabled={busy}
                                      onClick={() =>
                                        void act(
                                          () => checkRelease(release.version),
                                          (checked) =>
                                            t(locale, checked.status === 'evaluating' ? 'helpDesk.releases.recheckStarted' : 'helpDesk.releases.rechecked', {
                                              version: checked.version,
                                            }),
                                        )
                                      }
                                    >
                                      {t(locale, 'helpDesk.releases.recheck')}
                                    </button>
                                  ) : null}
                                  {canWrite && actions.rollback ? (
                                    <button
                                      type="button"
                                      className="hdDrawerButton"
                                      disabled={busy}
                                      aria-label={t(locale, 'helpDesk.releases.rollbackLabel', { version: release.version })}
                                      onClick={(event) => ask({ action: 'rollback', version: release.version }, event.currentTarget)}
                                    >
                                      {t(locale, 'helpDesk.releases.rollback')}
                                    </button>
                                  ) : null}
                                </div>
                              </td>
                            </tr>,
                            diff ? (
                              <tr key={`${release.version}-diff`} className="hdReleaseDiffRow">
                                <td colSpan={5}>
                                  {diff === 'loading' ? <p className="hdGraphHint">{t(locale, 'helpDesk.releases.loading')}</p> : diffView(diff)}
                                  {release.checks && !release.checks.passed ? checksView(release.checks) : null}
                                </td>
                              </tr>
                            ) : null,
                            open && model ? (
                              <tr key={`${release.version}-details`} className="hdReleaseDiffRow">
                                <td colSpan={5}>
                                  <FaqCheckReport locale={locale} report={model} />
                                </td>
                              </tr>
                            ) : null,
                          ]
                        })}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>

        {confirm ? (
          <div className="hdConfirmLayer">
            <div ref={confirmRef} className="hdConfirm" role="alertdialog" aria-modal="true" aria-labelledby={`${uid}-confirm`}>
              <p className="hdConfirmText" id={`${uid}-confirm`}>
                {t(locale, confirm.action === 'publish' ? 'helpDesk.releases.publishConfirm' : 'helpDesk.releases.rollbackConfirm', {
                  version: confirm.version,
                })}
              </p>
              <div className="hdConfirmActions">
                <button ref={confirmFocus} type="button" className="hdDrawerButton" onClick={() => setConfirm(null)}>
                  {t(locale, 'helpDesk.releases.confirmNo')}
                </button>
                <button type="button" className="hdDrawerButton hdDrawerPrimary" onClick={confirmed}>
                  {t(locale, confirm.action === 'publish' ? 'helpDesk.releases.publishShort' : 'helpDesk.releases.rollbackYes')}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </aside>
    </div>
  )
}
