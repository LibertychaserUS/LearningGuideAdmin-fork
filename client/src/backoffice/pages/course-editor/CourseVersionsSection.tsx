import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CourseDetail, CourseVersion, HistoryPage } from '../../contracts/course';
import { boRequest } from '../../lib/api';
import { useResizableColumns } from '../../components/resizableColumns';
import { Field, Modal } from './shared';
import { L, buttonStyle, card, dangerBtn, fmtDate, inputStyle, liveStatusLabel, primaryBtn } from './shared-utils';
import { historyActionLabel, historyDetailText } from './versionHistory';

type VersionWithCreator = CourseVersion & {
  /** 服务端 listVersions 关联员工后返回的显示名。 */
  createdByName?: string | null;
  createdBy?: string | null;
};

/** PRD §15.5：Published 列显示 发布日期 · 操作人。显示名优先，其次登录邮箱 @ 前的部分。 */
export function versionOperatorLabel(version: VersionWithCreator): string {
  const displayName = version.createdByName?.trim();
  if (displayName) return displayName;
  const creator = version.createdBy?.trim();
  if (!creator) return '—';
  const at = creator.indexOf('@');
  if (at > 0) return creator.slice(0, at);
  // 没有可显示的名称时不把内部员工 UUID 当操作人显示。
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(creator)) return '—';
  return creator;
}

/** 版本编号方式由环境配置决定（PRD §15.3）：Sandbox 用 X.Y，Production 用 Version N。 */
export type VersionNumberingMode = 'sandbox' | 'production';

/**
 * PRD §15.5 Source 列：
 * - Production：导入显示 Sandbox X.Y，回退显示 Restored from Version N，本地发布显示 —。
 * - Sandbox：只有导出过的版本显示 Exported + 日期，其余为 —。
 */
export function versionSourceLabel(
  version: CourseVersion,
  locale: string,
  mode: VersionNumberingMode,
): string {
  if (mode === 'production') {
    if (version.sourceEnvironment) {
      return [version.sourceEnvironment, version.sourceVersionLabel].filter(Boolean).join(' ');
    }
    if (version.sourceVersionLabel) {
      return `${L(locale, '恢复自', 'Restored from')} ${version.sourceVersionLabel}`;
    }
    return '—';
  }
  if (version.exportedAt) {
    return `${L(locale, '已导出', 'Exported')} ${fmtDate(version.exportedAt, locale)}`;
  }
  return '—';
}

export function CourseVersionsSection({
  locale,
  course,
  versions,
  history,
  historyPage,
  setHistoryPage,
  busy,
  setBusy,
  onReload,
  onNotice,
  canPublish = true,
  versionNumberingMode,
}: {
  locale: string;
  course: CourseDetail;
  versions: CourseVersion[];
  history: HistoryPage | null;
  historyPage: number;
  setHistoryPage: (value: number) => void;
  busy: boolean;
  setBusy: (value: boolean) => void;
  onReload: () => Promise<void>;
  onNotice: (message: string) => void;
  /** REQ-0236：发布、删草稿、导入导出、上下线、恢复版本只给 Course=Full。 */
  canPublish?: boolean;
  /** 测试或调用方可直接指定；未指定时从 /api/backoffice/environment 读取。 */
  versionNumberingMode?: VersionNumberingMode;
}) {
  const navigate = useNavigate();
  const [publishOpen, setPublishOpen] = useState(false);
  const [notifyLearners, setNotifyLearners] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [restoreVersion, setRestoreVersion] = useState<CourseVersion | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [statusTarget, setStatusTarget] = useState<'ONLINE' | 'HIDDEN' | 'OFFLINE'>('ONLINE');
  const [statusReason, setStatusReason] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [exportVersion, setExportVersion] = useState('live');
  const [exportBusy, setExportBusy] = useState(false);
  const [fetchedNumberingMode, setFetchedNumberingMode] = useState<VersionNumberingMode>('sandbox');

  useEffect(() => {
    if (versionNumberingMode) return;
    let active = true;
    void boRequest<{ versionNumberingMode?: VersionNumberingMode }>('/api/backoffice/environment').then((result) => {
      if (active && result.success && result.data.versionNumberingMode) {
        setFetchedNumberingMode(result.data.versionNumberingMode);
      }
    });
    return () => {
      active = false;
    };
  }, [versionNumberingMode]);

  const numberingMode = versionNumberingMode ?? fetchedNumberingMode;

  const liveVersion = versions.find((version) => version.isLive);
  const sortedVersions = [...versions].sort((a, b) => b.versionNo - a.versionNo);
  const versionsTable = useResizableColumns({ storageKey: 'course-editor-versions', defaultWidths: [110, 170, 180, 150, 240] });
  const historyTable = useResizableColumns({ storageKey: 'course-editor-history', defaultWidths: [160, 140, 140, 578] });


  async function publish() {
    if (!course.completeness.canPublish) {
      onNotice(course.completeness.publishBlockers.join('\n'));
      return;
    }
    setBusy(true);
    const result = await boRequest(`/api/backoffice/courses/${course.id}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notifyLearners }),
    });
    setBusy(false);
    if (result.success) {
      setPublishOpen(false);
      onNotice(L(locale, '发布成功。', 'Published successfully.'));
      await onReload();
    } else {
      onNotice(`${L(locale, '发布失败', 'Publish failed')}: ${result.message ?? result.error}`);
    }
  }

  async function deleteDraft() {
    setBusy(true);
    const result = await boRequest(`/api/backoffice/courses/${course.id}/delete-draft`, { method: 'POST' });
    setBusy(false);
    if (result.success) {
      setDeleteOpen(false);
      onNotice(L(locale, '草稿已删除。', 'Draft deleted.'));
      await onReload();
    } else {
      onNotice(`${L(locale, '删除草稿失败', 'Delete draft failed')}: ${result.message ?? result.error}`);
    }
  }

  async function restore() {
    if (!restoreVersion) return;
    setBusy(true);
    const result = await boRequest(`/api/backoffice/courses/${course.id}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ versionId: restoreVersion.id }),
    });
    setBusy(false);
    if (result.success) {
      setRestoreVersion(null);
      onNotice(L(locale, '版本已恢复到草稿。', 'Version restored to the draft.'));
      await onReload();
    } else {
      onNotice(`${L(locale, '恢复失败', 'Restore failed')}: ${result.message ?? result.error}`);
    }
  }

  async function changeStatus() {
    if (!statusReason.trim()) {
      onNotice(L(locale, '请填写原因。', 'Reason is required.'));
      return;
    }
    setBusy(true);
    const result = await boRequest(`/api/backoffice/courses/${course.id}/live-status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: statusTarget, reason: statusReason }),
    });
    setBusy(false);
    if (result.success) {
      setStatusOpen(false);
      setStatusReason('');
      onNotice(L(locale, '状态已更新。', 'Status updated.'));
      await onReload();
    } else {
      onNotice(`${L(locale, '状态更新失败', 'Status update failed')}: ${result.message ?? result.error}`);
    }
  }

  async function importPackage() {
    if (!importFile) return;
    setImportBusy(true);
    const form = new FormData();
    form.append('file', importFile);
    const uploaded = await boRequest<{ jobId: string }>(`/api/backoffice/courses/${course.id}/import`, { method: 'POST', body: form });
    if (!uploaded.success) {
      setImportBusy(false);
      onNotice(`${L(locale, '导入失败', 'Import failed')}: ${uploaded.message ?? uploaded.error}`);
      return;
    }
    const confirm = await boRequest(`/api/backoffice/courses/import/${uploaded.data.jobId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ onConflict: 'ABORT', overwriteDraft: true }),
    });
    setImportBusy(false);
    if (confirm.success) {
      setImportOpen(false);
      setImportFile(null);
      onNotice(L(locale, '课程包已导入草稿。', 'Package imported into the draft.'));
      await onReload();
    } else {
      onNotice(`${L(locale, '导入失败', 'Import failed')}: ${confirm.message ?? confirm.error}`);
    }
  }

  async function exportPackage() {
    setExportBusy(true);
    const start = await boRequest<{ jobId: string }>(`/api/backoffice/courses/${course.id}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: exportVersion }),
    });
    if (!start.success) {
      setExportBusy(false);
      onNotice(`${L(locale, '导出失败', 'Export failed')}: ${start.message ?? start.error}`);
      return;
    }
    for (let attempt = 0; attempt < 120; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const status = await boRequest<{ status: string; progress: number; error?: string }>(`/api/backoffice/courses/export/${start.data.jobId}`);
      if (!status.success) continue;
      if (status.data.status === 'READY') {
        window.location.href = `/api/backoffice/courses/export/${start.data.jobId}/download`;
        setExportBusy(false);
        onNotice(L(locale, '课程包正在下载。', 'Course package is downloading.'));
        return;
      }
      if (status.data.status === 'FAILED') {
        setExportBusy(false);
        onNotice(`${L(locale, '导出失败', 'Export failed')}: ${status.data.error ?? 'unknown'}`);
        return;
      }
    }
    setExportBusy(false);
    onNotice(L(locale, '导出超时。', 'Export timed out.'));
  }

  // PRD §15.2：空缺 Lesson 用两位序号（Lesson 06），多个 Lesson 并列在同一行。
  const emptyLessonLabels = course.completeness.steps.content.lessons
    .map((lesson, index) => ({ lesson, index }))
    .filter(({ lesson }) => !lesson.studyComplete || !lesson.understandingComplete)
    .map(({ index }) => `${L(locale, '课时', 'Lesson')} ${String(index + 1).padStart(2, '0')}`);
  const gaps = [
    !course.completeness.steps.courseInformation.complete ? L(locale, '课程信息', 'Course Information') : null,
    emptyLessonLabels.length
      ? `${L(locale, '课程内容', 'Course Content')}: ${emptyLessonLabels.join(', ')}`
      : null,
    !course.completeness.steps.trial.complete ? L(locale, '试看设置', 'Trial') : null,
  ].filter(Boolean) as string[];

  return (
    <div>
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, '当前', 'Current')}</h2>
            <p style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.65 }}>{L(locale, '草稿 + 线上版本。发布和状态操作都在此页。', 'Draft and live version. Publish and status actions are on this page.')}</p>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14 }}>
          <div style={{ border: '1px solid #E8EDF5', borderRadius: 10, padding: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>{L(locale, '草稿', 'DRAFT')}</div>
            <div style={{ fontSize: 13 }}>
              {course.hasDraft ? L(locale, '未发布', 'Not published') : L(locale, '无草稿', 'No draft')}
              {course.hasDraft ? ` · ${L(locale, `已完成 ${course.completeness.completedSteps}/3 步`, `${course.completeness.completedSteps} of 3 steps complete`)}` : ''}
            </div>
            {canPublish && <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <button type="button" style={primaryBtn} disabled={busy || !course.hasDraft || !course.completeness.canPublish} onClick={() => setPublishOpen(true)}>
                {L(locale, '发布', 'Publish')}
              </button>
              <button type="button" style={dangerBtn} disabled={busy || !course.hasDraft || !liveVersion} onClick={() => setDeleteOpen(true)}>
                {L(locale, '删除草稿', 'Delete draft')}
              </button>
              <button type="button" style={buttonStyle} disabled={busy} onClick={() => setImportOpen(true)}>
                {L(locale, '导入课程包', 'Import package')}
              </button>
            </div>}
          </div>
          <div style={{ border: '1px solid #E8EDF5', borderRadius: 10, padding: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>{L(locale, '线上', 'LIVE')}</div>
            <div style={{ fontSize: 13 }}>
              {liveVersion ? `${liveVersion.versionLabel} · ${liveVersion.isLive ? L(locale, '线上', 'Live') : ''} · ${fmtDate(liveVersion.wentLiveAt ?? liveVersion.createdAt, locale)}` : L(locale, '从未发布', 'Not published')}
            </div>
            <div style={{ fontSize: 12, color: '#5A6577', marginTop: 4 }}>{liveStatusLabel(locale, course.liveStatus)}</div>
            {canPublish && <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <button type="button" style={buttonStyle} disabled={busy || !liveVersion} onClick={() => { setStatusTarget(course.liveStatus === 'ONLINE' ? 'HIDDEN' : 'ONLINE'); setStatusOpen(true); }}>
                {L(locale, '更改状态', 'Change status')}
              </button>
              <button type="button" style={buttonStyle} disabled={busy || !liveVersion || exportBusy} onClick={() => void exportPackage()}>
                {exportBusy ? L(locale, '导出中…', 'Exporting…') : L(locale, '导出课程包', 'Export package')}
              </button>
            </div>}
            {canPublish && <div style={{ marginTop: 8 }}>
              <label style={{ fontSize: 12 }}>{L(locale, '导出版本', 'Export version')}</label>
              <select value={exportVersion} onChange={(event) => setExportVersion(event.target.value)} style={{ marginLeft: 8, padding: 4 }}>
                <option value="live">{L(locale, '线上版本', 'Live')}</option>
                <option value="working">{L(locale, '草稿', 'Working')}</option>
              </select>
            </div>}
          </div>
        </div>
      </div>

      <div style={card}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, '版本', 'Versions')}</h2>
        <table className="table" style={{ ...versionsTable.tableStyle, marginTop: 12 }}>
          {versionsTable.colGroup}
          <thead>
            <tr>
              <th>{L(locale, '版本', 'Version')}{versionsTable.resizeHandle(0)}</th>
              <th>{L(locale, '发布时间', 'Published')}{versionsTable.resizeHandle(1)}</th>
              <th>{L(locale, '来源', 'Source')}{versionsTable.resizeHandle(2)}</th>
              <th>{L(locale, '操作', 'Actions')}{versionsTable.resizeHandle(3)}</th>
            </tr>
          </thead>
          <tbody>
            {sortedVersions.map((version) => (
              <tr key={version.id}>
                <td>{version.versionLabel}{version.isLive ? ` · ${L(locale, '线上', 'Live')}` : ''}</td>
                <td>{fmtDate(version.wentLiveAt ?? version.createdAt, locale)} · {versionOperatorLabel(version)}</td>
                <td>{versionSourceLabel(version, locale, numberingMode)}</td>
                <td>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button type="button" style={buttonStyle} onClick={() => navigate(`/${locale}/course/${course.id}/preview?versionId=${version.id}`)}>{L(locale, '查看', 'View')}</button>
                    {canPublish && !version.isLive && <button type="button" style={buttonStyle} disabled={busy} onClick={() => setRestoreVersion(version)}>{L(locale, '恢复', 'Restore')}</button>}
                  </div>
                </td>
              </tr>
            ))}
            {sortedVersions.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', padding: 18, opacity: 0.7 }}>{L(locale, '暂无版本。', 'No versions yet.')}</td></tr>}
          </tbody>
        </table>
      </div>

      <div style={card}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, '历史记录', 'History')}</h2>
        <table className="table" style={{ ...historyTable.tableStyle, marginTop: 12 }}>
          {historyTable.colGroup}
          <thead>
            <tr>
              <th>{L(locale, '时间', 'Time')}{historyTable.resizeHandle(0)}</th>
              <th>{L(locale, '操作人', 'Operator')}{historyTable.resizeHandle(1)}</th>
              <th>{L(locale, '操作', 'Action')}{historyTable.resizeHandle(2)}</th>
              <th style={{ textAlign: 'left' }}>{L(locale, '详情', 'Detail')}{historyTable.resizeHandle(3)}</th>
            </tr>
          </thead>
          <tbody>
            {(history?.items ?? []).map((item) => (
              <tr key={item.id}>
                <td>{fmtDate(item.time, locale)}</td>
                <td>{item.operator}</td>
                <td>{historyActionLabel(item.action, locale)}{item.versionNo ? <span style={{ opacity: 0.6 }}> · v{item.versionNo}</span> : null}</td>
                <td className="cellWrap" style={{ fontSize: 12, opacity: 0.8 }}>{historyDetailText(item, locale)}</td>
              </tr>
            ))}
            {(history?.items.length ?? 0) === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', padding: 18, opacity: 0.7 }}>{L(locale, '暂无记录。', 'No history yet.')}</td></tr>}
          </tbody>
        </table>
        {history && history.pages > 1 && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'center' }}>
            <button type="button" style={buttonStyle} disabled={historyPage <= 1} onClick={() => setHistoryPage(Math.max(1, historyPage - 1))}>←</button>
            <span style={{ fontSize: 13, alignSelf: 'center' }}>{history.page} / {history.pages}</span>
            <button type="button" style={buttonStyle} disabled={historyPage >= history.pages} onClick={() => setHistoryPage(Math.min(history.pages, historyPage + 1))}>→</button>
          </div>
        )}
      </div>

      {publishOpen && (
        <Modal title={L(locale, '发布', 'Publish')} onClose={() => setPublishOpen(false)}>
          <p style={{ fontSize: 13 }}>{L(locale, '发布后，草稿在本环境网站生效并生成版本号。课程状态不改变。', 'Publishing makes the draft live on this website and creates a version. The course status does not change.')}</p>
          <p style={{ fontSize: 12, color: '#5A6577', marginTop: 6 }}>{L(locale, '完成度', 'Content')}: {L(locale, `已完成 ${course.completeness.completedSteps}/3 步`, `${course.completeness.completedSteps} of 3 steps complete`)}</p>
          {gaps.length > 0 && (
            <div style={{ marginTop: 8, background: '#FFF6E5', padding: 10, borderRadius: 8, fontSize: 12 }}>
              <strong>{L(locale, '部分字段为空', 'Some fields are empty')}</strong>
              {gaps.map((gap) => <div key={gap}>{gap}</div>)}
              <div style={{ marginTop: 4 }}>{L(locale, '仍可发布。', 'You can still publish.')}</div>
            </div>
          )}
          <label style={{ display: 'block', marginTop: 12, fontSize: 13 }}>
            <input type="checkbox" checked={notifyLearners} onChange={(event) => setNotifyLearners(event.target.checked)} /> {L(locale, '通知已报名学员', 'Notify enrolled learners')}
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button type="button" style={primaryBtn} disabled={busy} onClick={() => void publish()}>{L(locale, '发布', 'Publish')}</button>
            <button type="button" style={buttonStyle} onClick={() => setPublishOpen(false)}>{L(locale, '取消', 'Cancel')}</button>
          </div>
        </Modal>
      )}

      {deleteOpen && (
        <Modal title={L(locale, '删除草稿', 'Delete draft')} onClose={() => setDeleteOpen(false)}>
          <p style={{ fontSize: 13 }}>{L(locale, '草稿被删除，包括导入的课程包。网站继续使用当前线上版本。此操作不可撤销。', 'The draft is deleted, including any imported package. The website keeps the live version. This cannot be undone.')}</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button type="button" style={dangerBtn} disabled={busy} onClick={() => void deleteDraft()}>{L(locale, '删除草稿', 'Delete draft')}</button>
            <button type="button" style={buttonStyle} onClick={() => setDeleteOpen(false)}>{L(locale, '取消', 'Cancel')}</button>
          </div>
        </Modal>
      )}

      {restoreVersion && (
        <Modal title={L(locale, '恢复版本', 'Restore version')} onClose={() => setRestoreVersion(null)}>
          <p style={{ fontSize: 13 }}>{L(locale, '旧版本内容复制到草稿，替换当前草稿。发布后才会生效。', 'The old version is copied into the draft and replaces the current draft. It goes live only after publish.')}</p>
          <div style={{ fontSize: 12, color: '#5A6577', marginTop: 8 }}>
            <div>{L(locale, '恢复版本', 'Restore')}: {restoreVersion.versionLabel}</div>
            <div>{L(locale, '发布为', 'Goes live as')}: {L(locale, '新版本', 'a new version')}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button type="button" style={primaryBtn} disabled={busy} onClick={() => void restore()}>{L(locale, '恢复', 'Restore')}</button>
            <button type="button" style={buttonStyle} onClick={() => setRestoreVersion(null)}>{L(locale, '取消', 'Cancel')}</button>
          </div>
        </Modal>
      )}

      {statusOpen && (
        <Modal title={L(locale, '更改状态', 'Change status')} onClose={() => setStatusOpen(false)}>
          <p style={{ fontSize: 13 }}>{L(locale, '更改状态不生成版本。', 'Changing the status does not create a version.')}</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            {(['ONLINE', 'HIDDEN', 'OFFLINE'] as const).map((status) => (
              <button key={status} type="button" onClick={() => setStatusTarget(status)} style={{ ...buttonStyle, borderColor: statusTarget === status ? '#2B58C8' : '#d9e0ea', color: statusTarget === status ? '#2B58C8' : '#25314C', fontWeight: statusTarget === status ? 700 : 400 }}>
                {liveStatusLabel(locale, status)}
              </button>
            ))}
          </div>
          <Field label={L(locale, '原因 *', 'Reason *')}>
            <textarea rows={3} value={statusReason} onChange={(event) => setStatusReason(event.target.value)} style={inputStyle} />
          </Field>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button type="button" style={primaryBtn} disabled={busy || !statusReason.trim()} onClick={() => void changeStatus()}>{L(locale, '更改状态', 'Change status')}</button>
            <button type="button" style={buttonStyle} onClick={() => setStatusOpen(false)}>{L(locale, '取消', 'Cancel')}</button>
          </div>
        </Modal>
      )}

      {importOpen && (
        <Modal title={L(locale, '导入课程包', 'Import package')} onClose={() => setImportOpen(false)}>
          <p style={{ fontSize: 13 }}>{L(locale, '课程包替换当前课程的草稿。线上版本不变，直到发布。', 'The package replaces the draft of this course. What is live does not change until you publish.')}</p>
          <Field label={L(locale, '上传 .zip', 'Upload .zip')}>
            <input type="file" accept=".zip,.lgcourse.zip" onChange={(event) => setImportFile(event.target.files?.[0] ?? null)} />
          </Field>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button type="button" style={primaryBtn} disabled={!importFile || importBusy} onClick={() => void importPackage()}>{importBusy ? L(locale, '导入中…', 'Importing…') : L(locale, '导入', 'Import')}</button>
            <button type="button" style={buttonStyle} onClick={() => setImportOpen(false)}>{L(locale, '取消', 'Cancel')}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}