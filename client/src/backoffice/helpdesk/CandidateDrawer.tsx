import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import {
  CANDIDATE_LIMITS,
  DISMISS_REASONS,
  phrasingsFromPicks,
  type AcceptCandidateBody,
  type CandidateDetail,
  type CandidateRevision,
  type DismissReason,
  type FaqCandidate,
  type FaqNodeSummary,
  type HelpdeskFaq,
} from '../contracts/helpdesk'
import type { FaqDraft } from '../lib/helpdeskFaqs'
import {
  acceptCandidate,
  dismissCandidate,
  getCandidate,
  getCandidateDraft,
  newIdempotencyKey,
} from '../lib/helpdeskApi'
import {
  canDecide,
  cleanExampleIndexes,
  decisionKey,
  faqDraftFromCandidate,
  hasPlaceholder,
  sourceMixEntries,
  textSegments,
  type DecisionKey,
} from '../lib/helpdeskFlywheel'
import { errorMessage, faqCategoryLabel } from '../lib/helpdeskFormat'
import { cardTime, longDate } from '../lib/helpdeskView'
import type { Locale } from '../lib/i18n/config'
import { t } from '../lib/i18n/messages'
import { FaqPicker } from './FaqPicker'
import { useModal } from './useModal'

/**
 * FAQ 候选详情（v5 Part G4，没有 Figma 画板，沿用 FAQ / 版本发布抽屉的样式，待视觉验收）：
 * - 话题、提议的问题（AI 只提议问题，从不写答案）、条数、首次 / 最近出现；
 * - 脱敏例句（占位符标成「已隐藏的个人信息」）：可勾选成问法与评测用例，含占位符的不能勾；
 * - 原因构成、相关节点（最接近的 FAQ 与相似度、上一级问题、屏幕上的卡片）、来自哪张工单；
 * - 审计记录（创建、加进更多问题、接受、驳回、合并：谁、什么时候）。
 * 动作只给 FULL 且只对待处理的候选：新 FAQ（打开预填的 FAQ 编辑器，保存后页面接受）、加问法（选目标 FAQ）、
 * 加成追问（选上一级问题，再写追问）、驳回（原因；「其他」要备注）。决定带 version 与 Idempotency-Key
 *（同一个决定重试沿用）；别人先改了 → 重新载入并提示。
 */

export type Compose = {
  candidate: FaqCandidate
  /** update_faq：卡片审核里「改这张卡」，打开已有的卡（faq），保存后接受。 */
  as: 'new_faq' | 'follow_up' | 'update_faq'
  parentId: string | null
  phrasings: number[]
  version: number
  /** 新卡的预填；update_faq 没有（编辑已有的卡）。 */
  initial?: FaqDraft
  draftSources: string[]
  /** update_faq：要改的那张卡。 */
  faq?: HelpdeskFaq
  /** 卡片审核里选的主位置（new_faq / follow_up 在结构不为空时必填）。 */
  placementNodeId?: string | null
}

type Mode = 'view' | 'phrasing' | 'followUp' | 'dismiss'
type Notice = { tone: 'status' | 'alert'; text: string } | null

type Props = {
  locale: Locale
  candidateId: string
  canWrite: boolean
  onClose: () => void
  /** 候选变了（接受、驳回）：队列刷新。 */
  onChanged: () => void
  /** 新 FAQ / 追问：交给页面打开预填的 FAQ 编辑器。 */
  onCompose: (compose: Compose) => void
  /** 打开另一个候选（合并到的那一个）。 */
  onOpenCandidate?: (candidateId: string) => void
}

const when = (iso: string | null, locale: Locale) => (iso ? `${longDate(iso, locale)} ${cardTime(iso, locale)}` : '—')

function Example({ text, locale }: { text: string; locale: Locale }) {
  return (
    <>
      {textSegments(text).map((segment, index) =>
        segment.placeholder ? (
          <mark key={index} className="hdPlaceholder">
            {segment.text}
          </mark>
        ) : (
          // 纯文字直接是文本节点：包一层 span 会让可访问名称在边界丢掉空格
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
      {hasPlaceholder(text) ? (
        <>
          {' '}
          <span className="hdSrOnly">{t(locale, 'helpDesk.candidates.hiddenDetail')}</span>
        </>
      ) : null}
    </>
  )
}

export function CandidateDrawer({ locale, candidateId, canWrite, onClose, onChanged, onCompose, onOpenCandidate }: Props) {
  const uid = useId()
  const zh = locale === 'zh-CN'
  const [detail, setDetail] = useState<CandidateDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('view')
  const [picks, setPicks] = useState<number[]>([])
  const [target, setTarget] = useState<string | null>(null)
  const [parent, setParent] = useState<string | null>(null)
  const [reason, setReason] = useState<DismissReason | ''>('')
  const [note, setNote] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [noticeShown, setNoticeShown] = useState(0)
  const keyRef = useRef<DecisionKey | null>(null)
  const drawerRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const noticeRef = useRef<HTMLDivElement>(null)
  const loadedFor = useRef<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Esc：表单开着 → 关表单；正在发送决定或取草稿时不动（和点遮罩一样），结果还要显示出来
  useModal(
    () => drawerRef.current,
    () => {
      if (busy) return
      if (mode !== 'view') closeForm()
      else onClose()
    },
  )

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => opener?.focus?.()
  }, [])

  useEffect(() => {
    if (noticeShown) noticeRef.current?.focus()
  }, [noticeShown])

  function adopt(data: CandidateDetail) {
    setDetail(data)
    setLoadError(null)
    // 第一次载入（或换了候选）时给缺省值：勾上能当问法的例句，目标与上一级用候选建议的
    if (loadedFor.current !== data.candidate.id) {
      loadedFor.current = data.candidate.id
      setPicks(cleanExampleIndexes(data.candidate.examples))
      setTarget(data.candidate.relatedNodeId)
      setParent(data.candidate.parentNodeId)
    }
  }

  async function load(): Promise<CandidateDetail | null> {
    const result = await getCandidate(candidateId)
    if (result.ok) {
      adopt(result.data)
      return result.data
    }
    setLoadError(result.code)
    return null
  }

  useEffect(() => {
    let live = true
    void getCandidate(candidateId).then((result) => {
      if (!live) return
      if (result.ok) adopt(result.data)
      else setLoadError(result.code)
    })
    return () => {
      live = false
    }
    // 只在打开（或换候选）时读；之后每个决定后 load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateId])

  function say(next: Notice) {
    setNotice(next)
    setNoticeShown((value) => value + 1)
  }

  function closeForm() {
    setMode('view')
    setSubmitted(false)
  }

  function open(next: Mode) {
    setNotice(null)
    setSubmitted(false)
    setMode(next)
  }

  /** 一个决定：失败（没变）重试沿用 key；别人先改了 → 重新载入并提示；成功 → 重新载入、队列刷新。 */
  async function decideWith<T>(
    body: unknown,
    send: (key: string) => Promise<{ ok: true; data: T } | { ok: false; code: string; status: number }>,
    success: (data: T) => string,
  ) {
    if (busy) return
    setBusy(true)
    keyRef.current = decisionKey(keyRef.current, body, newIdempotencyKey)
    const result = await send(keyRef.current.key)
    if (result.ok) {
      keyRef.current = null
      await load()
      setMode('view')
      setSubmitted(false)
      say({ tone: 'status', text: success(result.data) })
      onChanged()
    } else {
      if (result.code === 'CANDIDATE_CHANGED' || result.code === 'CANDIDATE_NOT_FOUND') await load()
      say({ tone: 'alert', text: errorMessage(locale, result.code) })
    }
    setBusy(false)
  }

  function togglePick(index: number, on: boolean) {
    setPicks((current) => (on ? [...current, index].sort((a, b) => a - b) : current.filter((value) => value !== index)))
  }

  function addPhrasings(candidate: FaqCandidate) {
    setSubmitted(true)
    if (!target || picks.length === 0) return
    const body: AcceptCandidateBody = { as: 'add_phrasing', faqId: target, phrasings: picks, version: candidate.version }
    void decideWith(
      body,
      (key) => acceptCandidate(candidate.id, body, key),
      (data) =>
        [
          data.phrasingsAdded === 1
            ? t(locale, 'helpDesk.candidates.addedOne', { skipped: data.phrasingsSkipped })
            : t(locale, 'helpDesk.candidates.addedMany', { added: data.phrasingsAdded, skipped: data.phrasingsSkipped }),
          ...((data.heldOut ?? 0) > 0 ? [t(locale, 'helpDesk.candidates.heldOut', { held: data.heldOut ?? 0 })] : []),
        ].join(' '),
    )
  }

  const cleanNote = note.trim().replace(/\s+/g, ' ')
  const noteTooLong = [...cleanNote].length > CANDIDATE_LIMITS.noteMax
  const noteMissing = reason === 'other' && cleanNote === ''

  function dismiss(candidate: FaqCandidate) {
    setSubmitted(true)
    if (!reason || noteMissing || noteTooLong) return
    const body = { reason, ...(cleanNote ? { note: cleanNote } : {}), version: candidate.version }
    void decideWith(
      body,
      (key) => dismissCandidate(candidate.id, body, key),
      () => t(locale, 'helpDesk.candidates.dismissed'),
    )
  }

  /** 新 FAQ / 追问：取预填，交给页面打开 FAQ 编辑器（保存后由页面接受候选）。 */
  async function compose(candidate: FaqCandidate, as: 'new_faq' | 'follow_up') {
    if (busy) return
    if (as === 'follow_up') {
      setSubmitted(true)
      if (!parent) return
    }
    setBusy(true)
    setNotice(null)
    const result = await getCandidateDraft(candidate.id)
    // 抽屉在取草稿时关掉了：不再自己打开 FAQ 编辑器
    if (!mounted.current) return
    setBusy(false)
    if (!result.ok) {
      say({ tone: 'alert', text: errorMessage(locale, result.code) })
      return
    }
    onCompose({
      candidate,
      as,
      parentId: as === 'follow_up' ? parent : null,
      phrasings: picks,
      version: result.data.version,
      initial: faqDraftFromCandidate(result.data, as),
      draftSources: result.data.answerDraft?.sources ?? [],
    })
  }

  function nodeName(nodes: FaqNodeSummary[], id: string | null): string | null {
    if (!id) return null
    const found = nodes.find((node) => node.id === id)
    return found ? (zh ? found.questionZh : found.questionEn) : id
  }

  function historyText(revision: CandidateRevision): string {
    const action = t(locale, `helpDesk.candidates.revision.${revision.action}`)
    const who = revision.employeeName
      ? t(locale, 'helpDesk.candidates.byName', { name: revision.employeeName })
      : revision.employeeId
        ? t(locale, 'helpDesk.candidates.byStaff', { id: revision.employeeId.slice(0, 8) })
        : t(locale, 'helpDesk.candidates.byJob')
    return t(locale, 'helpDesk.candidates.historyItem', {
      action: action.startsWith('helpDesk.') ? revision.action : action,
      who,
      when: when(revision.at, locale),
    })
  }

  function decidedText(candidate: FaqCandidate): string | null {
    const at = when(candidate.decidedAt, locale)
    if (candidate.status === 'accepted')
      return t(locale, 'helpDesk.candidates.decided.accepted', {
        as: t(locale, `helpDesk.candidates.suggestion.${candidate.acceptedAs ?? candidate.suggestion}`),
        when: at,
      })
    if (candidate.status === 'dismissed')
      return t(locale, 'helpDesk.candidates.decided.dismissed', {
        reason: candidate.reason ? t(locale, `helpDesk.candidates.reasons.${candidate.reason}`) : '—',
        when: at,
      })
    if (candidate.status === 'merged') return t(locale, 'helpDesk.candidates.decided.merged', { when: at })
    return null
  }

  function body(data: CandidateDetail): ReactNode {
    const { candidate, nodes, revisions } = data
    const decidable = canDecide(candidate, canWrite)
    const mix = sourceMixEntries(candidate.sourceMix)
    const decided = decidedText(candidate)
    const nodeRows = (
      [
        ['related', candidate.relatedNodeId],
        ['parent', candidate.parentNodeId],
        ['shown', candidate.shownNodeId],
        ['accepted', candidate.acceptedFaqId],
      ] as const
    ).filter(([, id]) => id !== null)
    const suggested = (ids: (string | null)[]) =>
      ids.flatMap((id) => nodes.filter((node) => node.id === id && node.type === 'answer'))
    const picksError = submitted && mode === 'phrasing' && picks.length === 0
    const targetError = submitted && mode === 'phrasing' && !target
    const parentError = submitted && mode === 'followUp' && !parent
    const sortedRevisions = [...revisions].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))

    return (
      <>
        <div className="hdCandidateHead">
          <h3 className="hdCandidateTopic">{candidate.topic}</h3>
          <div className="hdCandidateTags">
            <span className={`hdFaqChip hdCandidateStatus hdCandidateStatus-${candidate.status}`}>
              {t(locale, `helpDesk.candidates.status.${candidate.status}`)}
            </span>
            <span className="hdGraphTag">{t(locale, `helpDesk.candidates.suggestion.${candidate.suggestion}`)}</span>
            <span className="hdGraphTag">{t(locale, `helpDesk.candidates.origin.${candidate.origin}`)}</span>
            {candidate.category ? <span className="hdGraphTag">{faqCategoryLabel(locale, candidate.category)}</span> : null}
          </div>
        </div>

        <div className="hdField">
          <p className="hdFieldLabel">{t(locale, 'helpDesk.candidates.proposed')}</p>
          <p className="hdCandidateQuestion">{candidate.proposedQuestion}</p>
          <p className="hdGraphHint">{t(locale, `helpDesk.candidates.labelSource.${candidate.labelSource}`)}</p>
        </div>
        <p className="hdCandidateMeta">
          <span>
            {candidate.turnCount === 1
              ? t(locale, 'helpDesk.candidates.turnsOne')
              : t(locale, 'helpDesk.candidates.turns', { count: candidate.turnCount })}
          </span>
          <span className="hdGraphHint">
            {t(locale, 'helpDesk.candidates.seen', {
              first: longDate(candidate.firstSeenAt, locale),
              last: longDate(candidate.lastSeenAt, locale),
            })}
          </span>
        </p>
        {decided ? (
          <div className="hdCandidateDecided">
            <p className="hdReleaseLive">{decided}</p>
            {candidate.reasonNote ? <p className="hdGraphHint">{candidate.reasonNote}</p> : null}
            {candidate.status === 'merged' && candidate.mergedInto && onOpenCandidate ? (
              <button type="button" className="hdFaqPreview" onClick={() => onOpenCandidate(candidate.mergedInto as string)}>
                {t(locale, 'helpDesk.candidates.openMerged')}
              </button>
            ) : null}
          </div>
        ) : null}

        <section className="hdGraphSection" aria-labelledby={`${uid}-examples`}>
          <h4 className="hdGraphTitle" id={`${uid}-examples`}>
            {t(locale, 'helpDesk.candidates.examples')}
          </h4>
          {decidable ? (
            <p className="hdGraphHint" id={`${uid}-examples-hint`}>
              {t(locale, 'helpDesk.candidates.examplesHint')}
            </p>
          ) : null}
          <ul className="hdCandidateExamples">
            {candidate.examples.map((example, index) => (
              <li key={`${index}-${example.turnId ?? ''}`} lang={example.locale}>
                {decidable ? (
                  <label className="hdCheck hdGraphCheck">
                    <input
                      type="checkbox"
                      className="hdCheckInput"
                      checked={picks.includes(index)}
                      disabled={hasPlaceholder(example.text)}
                      aria-describedby={`${uid}-examples-hint`}
                      onChange={(event) => togglePick(index, event.target.checked)}
                    />
                    <span>
                      <Example text={example.text} locale={locale} />
                    </span>
                  </label>
                ) : (
                  <Example text={example.text} locale={locale} />
                )}
              </li>
            ))}
          </ul>
          {picksError ? <p className="hdFieldError">{t(locale, 'helpDesk.candidates.needExamples')}</p> : null}
        </section>

        {mix.length > 0 ? (
          <section className="hdGraphSection" aria-labelledby={`${uid}-mix`}>
            <h4 className="hdGraphTitle" id={`${uid}-mix`}>
              {t(locale, 'helpDesk.candidates.mixTitle')}
            </h4>
            <div className="hdCandidateMix">
              {mix.map(([key, count]) => (
                <span key={key} className="hdGraphTag">
                  {t(locale, 'helpDesk.candidates.mixItem', { label: t(locale, `helpDesk.candidates.mix.${key}`), count })}
                </span>
              ))}
            </div>
          </section>
        ) : null}

        <section className="hdGraphSection" aria-labelledby={`${uid}-nodes`}>
          <h4 className="hdGraphTitle" id={`${uid}-nodes`}>
            {t(locale, 'helpDesk.candidates.nodes')}
          </h4>
          {nodeRows.length === 0 ? <p className="hdGraphHint">{t(locale, 'helpDesk.candidates.none')}</p> : null}
          {nodeRows.length > 0 ? (
            <dl className="hdCandidateNodes">
              {nodeRows.map(([kind, id]) => (
                <div key={kind} className="hdCandidateNode">
                  <dt className="hdFieldLabel">{t(locale, `helpDesk.candidates.${kind}`)}</dt>
                  <dd>
                    <span>{nodeName(nodes, id)}</span>
                    {kind === 'related' && candidate.relatedScore !== null ? (
                      <span className="hdGraphHint hdCandidateScore">
                        {t(locale, 'helpDesk.candidates.relatedScore', { score: candidate.relatedScore.toFixed(2) })}
                      </span>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {candidate.ticketId ? (
            <p className="hdGraphHint">
              {t(locale, 'helpDesk.candidates.fromTicket')} ·{' '}
              <Link to={`/${locale}/help-desk/${encodeURIComponent(candidate.ticketId)}`}>{t(locale, 'helpDesk.candidates.openTicket')}</Link>
            </p>
          ) : null}
          {candidate.answerSources.length > 0 ? (
            <p className="hdGraphHint">{t(locale, 'helpDesk.candidates.draftSources', { count: candidate.answerSources.length })}</p>
          ) : null}
        </section>

        {decidable ? (
          <section className="hdGraphSection hdCandidateActions" aria-label={t(locale, 'helpDesk.actions.label')}>
            {mode === 'view' ? (
              <div className="hdReleaseActions">
                <button
                  type="button"
                  className="hdDrawerButton hdDrawerPrimary"
                  disabled={busy}
                  onClick={() => void compose(candidate, 'new_faq')}
                >
                  {t(locale, busy ? 'helpDesk.candidates.drafting' : 'helpDesk.candidates.newFaq')}
                </button>
                <button type="button" className="hdDrawerButton" disabled={busy} onClick={() => open('phrasing')}>
                  {t(locale, 'helpDesk.candidates.addPhrasing')}
                </button>
                <button type="button" className="hdDrawerButton" disabled={busy} onClick={() => open('followUp')}>
                  {t(locale, 'helpDesk.candidates.followUp')}
                </button>
                <button type="button" className="hdDrawerButton hdDrawerDanger" disabled={busy} onClick={() => open('dismiss')}>
                  {t(locale, 'helpDesk.candidates.dismiss')}
                </button>
              </div>
            ) : null}

            {mode === 'phrasing' ? (
              <div className="hdCandidateForm">
                <FaqPicker
                  locale={locale}
                  legend={t(locale, 'helpDesk.candidates.target')}
                  selected={target}
                  onSelect={setTarget}
                  suggested={suggested([candidate.relatedNodeId, candidate.shownNodeId])}
                  invalid={targetError}
                  describedBy={targetError ? `${uid}-target-error` : undefined}
                />
                {targetError ? (
                  <p className="hdFieldError" id={`${uid}-target-error`}>
                    {t(locale, 'helpDesk.candidates.needTarget')}
                  </p>
                ) : null}
                <div className="hdGraphFormActions">
                  <button
                    type="button"
                    className="hdDrawerButton hdDrawerPrimary"
                    disabled={busy}
                    onClick={() => addPhrasings(candidate)}
                  >
                    {busy
                      ? t(locale, 'helpDesk.candidates.saving')
                      : phrasingsFromPicks(picks.length) === 1
                        ? t(locale, 'helpDesk.candidates.addPhrasingsOne')
                        : t(locale, 'helpDesk.candidates.addPhrasingsMany', { count: phrasingsFromPicks(picks.length) })}
                  </button>
                  <button type="button" className="hdDrawerButton" disabled={busy} onClick={closeForm}>
                    {t(locale, 'helpDesk.candidates.cancel')}
                  </button>
                </div>
              </div>
            ) : null}

            {mode === 'followUp' ? (
              <div className="hdCandidateForm">
                <FaqPicker
                  locale={locale}
                  legend={t(locale, 'helpDesk.candidates.parentPick')}
                  selected={parent}
                  onSelect={setParent}
                  suggested={suggested([candidate.parentNodeId, candidate.shownNodeId, candidate.relatedNodeId])}
                  invalid={parentError}
                  describedBy={parentError ? `${uid}-parent-error` : undefined}
                />
                {parentError ? (
                  <p className="hdFieldError" id={`${uid}-parent-error`}>
                    {t(locale, 'helpDesk.candidates.needTarget')}
                  </p>
                ) : null}
                <div className="hdGraphFormActions">
                  <button
                    type="button"
                    className="hdDrawerButton hdDrawerPrimary"
                    disabled={busy}
                    onClick={() => void compose(candidate, 'follow_up')}
                  >
                    {t(locale, busy ? 'helpDesk.candidates.drafting' : 'helpDesk.candidates.writeFollowUp')}
                  </button>
                  <button type="button" className="hdDrawerButton" disabled={busy} onClick={closeForm}>
                    {t(locale, 'helpDesk.candidates.cancel')}
                  </button>
                </div>
              </div>
            ) : null}

            {mode === 'dismiss' ? (
              <div className="hdCandidateForm">
                <div className="hdField">
                  <label className="hdFieldLabel" htmlFor={`${uid}-reason`}>
                    {t(locale, 'helpDesk.candidates.reason')}
                    <span className="hdRequired" aria-hidden="true">
                      {' '}
                      *
                    </span>
                  </label>
                  <select
                    id={`${uid}-reason`}
                    className="hdDrawerSelect"
                    value={reason}
                    aria-invalid={submitted && !reason}
                    aria-describedby={submitted && !reason ? `${uid}-reason-error` : undefined}
                    onChange={(event) => setReason(event.target.value as DismissReason | '')}
                  >
                    <option value="" disabled>
                      {t(locale, 'helpDesk.candidates.reasonPlaceholder')}
                    </option>
                    {DISMISS_REASONS.map((value) => (
                      <option key={value} value={value}>
                        {t(locale, `helpDesk.candidates.reasons.${value}`)}
                      </option>
                    ))}
                  </select>
                  {submitted && !reason ? (
                    <p className="hdFieldError" id={`${uid}-reason-error`}>
                      {t(locale, 'helpDesk.candidates.needReason')}
                    </p>
                  ) : null}
                </div>
                <div className="hdField">
                  <label className="hdFieldLabel" htmlFor={`${uid}-note`}>
                    {t(locale, 'helpDesk.candidates.note')}
                  </label>
                  <textarea
                    id={`${uid}-note`}
                    className="hdTextarea hdCandidateNote"
                    value={note}
                    aria-invalid={submitted && (noteMissing || noteTooLong)}
                    aria-describedby={`${uid}-note-hint${submitted && (noteMissing || noteTooLong) ? ` ${uid}-note-error` : ''}`}
                    onChange={(event) => setNote(event.target.value)}
                  />
                  <p className="hdGraphHint" id={`${uid}-note-hint`}>
                    {t(locale, 'helpDesk.candidates.noteHint')}
                  </p>
                  {submitted && (noteMissing || noteTooLong) ? (
                    <p className="hdFieldError" id={`${uid}-note-error`}>
                      {noteMissing
                        ? t(locale, 'helpDesk.candidates.needNote')
                        : t(locale, 'helpDesk.candidates.noteTooLong', { max: CANDIDATE_LIMITS.noteMax })}
                    </p>
                  ) : null}
                </div>
                <div className="hdGraphFormActions">
                  <button
                    type="button"
                    className="hdDrawerButton hdDrawerDanger"
                    disabled={busy}
                    onClick={() => dismiss(candidate)}
                  >
                    {t(locale, busy ? 'helpDesk.candidates.saving' : 'helpDesk.candidates.confirmDismiss')}
                  </button>
                  <button type="button" className="hdDrawerButton" disabled={busy} onClick={closeForm}>
                    {t(locale, 'helpDesk.candidates.cancel')}
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="hdGraphSection" aria-labelledby={`${uid}-history`}>
          <h4 className="hdGraphTitle" id={`${uid}-history`}>
            {t(locale, 'helpDesk.candidates.history')}
          </h4>
          <ul className="hdReleaseList hdCandidateHistory" aria-labelledby={`${uid}-history`}>
            {sortedRevisions.map((revision) => (
              <li key={revision.id}>{historyText(revision)}</li>
            ))}
          </ul>
        </section>
      </>
    )
  }

  return (
    <div className="hdDrawerLayer">
      <div className="hdDrawerBackdrop" aria-hidden="true" onClick={() => (busy ? undefined : onClose())} />
      <aside
        ref={drawerRef}
        className="hdDrawer hdReleasesDrawer hdCandidateDrawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
      >
        <header className="hdDrawerHead">
          <div className="hdDrawerHeading">
            <h2 className="hdDrawerTitle" id={`${uid}-title`}>
              {t(locale, 'helpDesk.candidates.title')}
            </h2>
            <p className="hdDrawerSubtitle">{t(locale, 'helpDesk.candidates.subtitle')}</p>
          </div>
          <button ref={closeRef} type="button" className="hdDrawerClose" aria-label={t(locale, 'helpDesk.drawer.close')} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="hdDrawerBody" aria-busy={busy || (detail === null && !loadError)}>
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
          {loadError && !detail ? (
            <div className="hdNotice hdDrawerNotice hdDrawerAlert" role="alert">
              {errorMessage(locale, loadError)}
            </div>
          ) : null}
          {detail === null && !loadError ? <p className="hdGraphHint">{t(locale, 'helpDesk.candidates.loading')}</p> : null}
          {detail ? body(detail) : null}
        </div>
      </aside>
    </div>
  )
}
