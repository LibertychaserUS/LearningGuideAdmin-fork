import { useEffect, useMemo, useRef, useState } from 'react';

import type { CourseDetail, Lesson } from '../../contracts/course';
import { boRequest } from '../../lib/api';
import { formatBytes, uploadFileWithProgress, uploadMediaInChunks } from '../../lib/upload';
import { useMediaLimits } from '../../lib/mediaLimits';
import { UploadProgress } from '../../components/UploadProgress';
import { UnderstandingPanel } from './UnderstandingPanel';
import { ExhibitDrawer } from './ExhibitDrawer';
import { TextEditor } from './TextEditor';
import { Chip, Field, Modal, TimeInput } from './shared';
import { L, buttonStyle, card, dangerBtn, exhibitTypeLabel, inputStyle, labelStyle, languageLabel, localizeMissing, fmtDuration, fmtDate, primaryBtn, readingTypeLabel } from './shared-utils';
import type { Locale } from '../../lib/i18n/config';
import { serverText } from '../../lib/i18n/serverText';
import { pickLocalized } from '../../lib/i18n/localized';

type UploadResult = { id: string; kind?: string; originalName?: string };

type VideoUploadState = {
  phase: 'uploading' | 'processing' | 'assigning' | 'done' | 'error' | 'cancelled';
  fileName: string;
  size: number;
  pct: number;
  loaded: number;
  startedAt: number;
  elapsedMs: number;
  assetId?: string;
  durationSeconds?: number | null;
  error?: string;
};

type ExhibitUploadState = {
  index: number;
  total: number;
  fileName: string;
  pct: number;
} | null;

function loc(lesson: Lesson | undefined, language: string) {
  if (!lesson || !Array.isArray(lesson.localizations)) return undefined;
  return lesson.localizations.find((item) => item.language === language) ?? lesson.localizations[0];
}

function parseTextLearningPoints(html: string) {
  const matches = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)];
  return matches.map((match, index) => {
    const heading = match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? html.length) : html.length;
    const body = html.slice(start, end).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
    return { heading, hasBody: Boolean(body) };
  });
}

export function CourseContentSection({
  locale,
  course,
  activeLessonId,
  setActiveLessonId,
  contentLanguage,
  busy,
  setBusy,
  onReload,
  onNotice,
}: {
  locale: string;
  course: CourseDetail;
  activeLessonId: string;
  setActiveLessonId: (value: string) => void;
  contentLanguage: string;
  busy: boolean;
  setBusy: (value: boolean) => void;
  onReload: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [part, setPart] = useState<'study' | 'understanding'>('study');
  const [studyTab, setStudyTab] = useState<'video' | 'text'>('video');
  const [lessonCode, setLessonCode] = useState('');
  const [lessonTitleEn, setLessonTitleEn] = useState('');
  const [lessonTitleZh, setLessonTitleZh] = useState('');
  const [lessonDescEn, setLessonDescEn] = useState('');
  const [lessonDescZh, setLessonDescZh] = useState('');
  const [videoLps, setVideoLps] = useState<Array<{ code: string; title: string; timeSeconds: number }>>([]);
  const [triggerRows, setTriggerRows] = useState<Array<{ exhibitId: string; timeSeconds: number }>>([]);
  const [readingRows, setReadingRows] = useState<Array<{ type: string; title: string; author: string; whyRecommended: string }>>([]);
  const [textHtml, setTextHtml] = useState('');
  const [exhibitDrawer, setExhibitDrawer] = useState<'new' | string | null>(null);
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [allUnderstandingOpen, setAllUnderstandingOpen] = useState(false);
  const [allReadingsOpen, setAllReadingsOpen] = useState(false);
  const [allImportFile, setAllImportFile] = useState<File | null>(null);
  const [allImportLanguage, setAllImportLanguage] = useState(contentLanguage);
  const [allImportResult, setAllImportResult] = useState<{ added: number; errors: Array<{ row: number; message: string }>; byLesson?: Record<string, number> } | null>(null);
  const [readingImportFile, setReadingImportFile] = useState<File | null>(null);
  const [readingImportResult, setReadingImportResult] = useState<{ added: number; errors: Array<{ row: number; message: string }> } | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [videoUpload, setVideoUpload] = useState<VideoUploadState | null>(null);
  const [exhibitUpload, setExhibitUpload] = useState<ExhibitUploadState>(null);
  const [videoPreviewOpen, setVideoPreviewOpen] = useState(false);
  const videoAbortRef = useRef<AbortController | null>(null);
  const lastVideoFileRef = useRef<File | null>(null);

  const sortedLessons = useMemo(() => [...course.lessons].sort((a, b) => a.sortOrder - b.sortOrder), [course.lessons]);
  const activeLesson = sortedLessons.find((lesson) => lesson.id === activeLessonId) ?? sortedLessons[0];
  const hasVideo = course.learningMode !== 'TEXT_ONLY';
  const hasText = course.learningMode !== 'VIDEO_ONLY';
  const lessonCompleteness = (course.completeness.steps.content.lessons ?? []).find((item) => item.lessonId === activeLesson?.id);

  const [draftSource, setDraftSource] = useState<{
    lesson: Lesson | undefined;
    course: CourseDetail;
    language: string;
  } | null>(null);
  if (
    draftSource?.lesson !== activeLesson ||
    draftSource?.course !== course ||
    draftSource?.language !== contentLanguage
  ) {
    setDraftSource({ lesson: activeLesson, course, language: contentLanguage });
    if (activeLesson) {
      const en = loc(activeLesson, 'en-GB');
      const zh = loc(activeLesson, 'zh-CN');
      setLessonCode(activeLesson.code);
      setLessonTitleEn(en?.title ?? activeLesson.code);
      setLessonTitleZh(zh?.title ?? '');
      setLessonDescEn(en?.description ?? '');
      setLessonDescZh(zh?.description ?? '');
      const currentLoc = loc(activeLesson, contentLanguage);
      setVideoLps(
        activeLesson.learningPoints
          .filter((point) => point.language === contentLanguage && point.source === 'VIDEO')
          .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
          .map((point) => ({
            code: point.code,
            title: point.title,
            timeSeconds: point.timeSeconds ?? 0,
          })),
      );
      setTriggerRows(
        (activeLesson.triggers ?? [])
          .filter((trigger) => trigger.language === contentLanguage)
          .map((trigger) => ({ exhibitId: trigger.exhibitId, timeSeconds: trigger.timeSeconds })),
      );
      setReadingRows(
        activeLesson.readings
          .filter((reading) => reading.language === 'en-GB' || reading.language === contentLanguage)
          .map((reading) => ({
            type: reading.type,
            title: reading.title,
            author: reading.author ?? '',
            whyRecommended: reading.whyRecommended ?? '',
          })),
      );
      setTextHtml(currentLoc?.textHtml ?? '');
    }
  }

  const [studyMode, setStudyMode] = useState<boolean | null>(null);
  if (studyMode !== hasVideo) {
    setStudyMode(hasVideo);
    setStudyTab(hasVideo ? 'video' : 'text');
  }

  const [importLanguage, setImportLanguage] = useState(contentLanguage);
  if (importLanguage !== contentLanguage) {
    setImportLanguage(contentLanguage);
    setAllImportLanguage(contentLanguage);
  }

  const selectedLessonId = activeLesson?.id;
  const [uploadLessonId, setUploadLessonId] = useState(selectedLessonId);
  if (uploadLessonId !== selectedLessonId) {
    setUploadLessonId(selectedLessonId);
    setVideoUpload(null);
    setExhibitUpload(null);
    setVideoPreviewOpen(false);
  }
  useEffect(() => () => {
    videoAbortRef.current?.abort();
  }, [selectedLessonId]);

  const textLps = useMemo(() => parseTextLearningPoints(textHtml), [textHtml]);
  const videoDuration = loc(activeLesson, contentLanguage)?.videoDurationSeconds ?? null;
  const exhibits = activeLesson?.exhibits ?? [];

  async function importDocx(file: File): Promise<string | null> {
    setBusy(true);
    const form = new FormData();
    form.append('file', file);
    const result = await boRequest<{ html: string }>(`/api/backoffice/courses/${course.id}/docx`, { method: 'POST', body: form });
    setBusy(false);
    if (!result.success) {
      onNotice(`${L(locale, '导入 Word 失败', 'Word import failed')}: ${result.message ?? result.error}`);
      return null;
    }
    return result.data.html;
  }

  async function saveLessonInfo() {
    if (!activeLesson) return;
    setBusy(true);
    // 同一语言的课时信息与正文必须顺序保存：并发写同一条 LessonLocalization
    // 会互相覆盖（后写入的请求用旧值把 textHtml 清空，导致文本学习点丢失）。
    const requests = [
      () => boRequest(`/api/backoffice/courses/${course.id}/lessons/${activeLesson.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ language: 'en-GB', code: lessonCode, title: lessonTitleEn, description: lessonDescEn }),
      }),
      () => boRequest(`/api/backoffice/courses/${course.id}/lessons/${activeLesson.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ language: 'zh-CN', code: lessonCode, title: lessonTitleZh, description: lessonDescZh }),
      }),
    ];
    if (hasText) {
      requests.push(() =>
        boRequest(`/api/backoffice/courses/${course.id}/lessons/${activeLesson.id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ language: contentLanguage, textHtml }),
        }),
      );
    }
    const results = [];
    for (const request of requests) results.push(await request());
    setBusy(false);
    if (results.every((result) => result.success)) {
      onNotice(L(locale, '课时信息已保存。', 'Lesson information saved.'));
      await onReload();
    } else {
      const failed = results.find((result) => !result.success);
      onNotice(`${L(locale, '保存失败', 'Save failed')}: ${failed?.message ?? failed?.error}`);
    }
  }

  async function saveStudy() {
    if (!activeLesson) return;
    await saveLessonInfo();
    setBusy(true);
    if (hasVideo) {
      const lpResult = await boRequest(`/api/backoffice/courses/${course.id}/lessons/${activeLesson.id}/learning-points`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ language: contentLanguage, points: videoLps }),
      });
      if (!lpResult.success) {
        setBusy(false);
        onNotice(`${L(locale, '学习点保存失败', 'Learning point save failed')}: ${lpResult.message ?? lpResult.error}`);
        return;
      }
      const triggerResult = await boRequest(`/api/backoffice/courses/${course.id}/lessons/${activeLesson.id}/triggers`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ language: contentLanguage, triggers: triggerRows }),
      });
      if (!triggerResult.success) {
        setBusy(false);
        onNotice(`${L(locale, '触发点保存失败', 'Trigger save failed')}: ${triggerResult.message ?? triggerResult.error}`);
        return;
      }
    }
    const readingResult = await boRequest(`/api/backoffice/courses/${course.id}/lessons/${activeLesson.id}/readings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'en-GB', readings: readingRows }),
    });
    setBusy(false);
    if (readingResult.success) {
      onNotice(L(locale, '学习与探索已保存。', 'Study & Exploration saved.'));
      await onReload();
    } else {
      onNotice(`${L(locale, '阅读保存失败', 'Reading save failed')}: ${readingResult.message ?? readingResult.error}`);
    }
  }

  function uploadFailureText(code: string, detail?: string) {
    if (code === 'NETWORK_ERROR') {
      return L(locale, '上传中断：网络不稳定或连接被关闭，请重试。', 'Upload interrupted: network dropped or the connection closed. Please retry.');
    }
    if (code === 'TIMEOUT') {
      return L(locale, '上传超时：网络过慢或服务无响应，请重试。', 'Upload timed out: slow network or no response from the server. Please retry.');
    }
    if (code === 'MEDIA_TOO_LARGE') {
      return L(locale, `文件超过大小限制：${detail ?? ''}`, `File exceeds the size limit: ${detail ?? ''}`);
    }
    if (detail && detail.trim()) return L(locale, `上传失败：${detail}`, `Upload failed: ${detail}`);
    return L(locale, `上传失败：${code}`, `Upload failed: ${code}`);
  }

  async function uploadVideo(file: File, startedAt: number) {
    if (!activeLesson) return;
    if (mediaLimits && file.size > mediaLimits.videoBytes) {
      const message = L(
        locale,
        `视频超过单文件上限 ${formatBytes(mediaLimits.videoBytes)}（当前 ${formatBytes(file.size)}）。`,
        `Video exceeds the ${formatBytes(mediaLimits.videoBytes)} per-file limit (this file is ${formatBytes(file.size)}).`,
      );
      lastVideoFileRef.current = null;
      setVideoUpload({
        phase: 'error',
        fileName: file.name,
        size: file.size,
        pct: 0,
        loaded: 0,
        startedAt,
        elapsedMs: 0,
        error: message,
      });
      onNotice(message);
      return;
    }
    const lessonId = activeLesson.id;
    lastVideoFileRef.current = file;
    const controller = new AbortController();
    videoAbortRef.current = controller;
    setVideoUpload({ phase: 'uploading', fileName: file.name, size: file.size, pct: 0, loaded: 0, startedAt, elapsedMs: 0 });

    const result = await uploadMediaInChunks<UploadResult>({
      courseId: course.id,
      file,
      callbacks: {
        signal: controller.signal,
        onProgress: (progress) => {
          const elapsedMs = Date.now() - startedAt;
          setVideoUpload((prev) =>
            prev && {
              ...prev,
              phase: 'uploading',
              pct: progress.pct,
              loaded: progress.loaded,
              elapsedMs,
            },
          );
        },
        onProcessing: () =>
          setVideoUpload((prev) => prev && { ...prev, phase: 'processing', pct: 100, loaded: prev.size }),
      },
    });
    videoAbortRef.current = null;

    if (!result.success) {
      if (result.cancelled) {
        setVideoUpload((prev) => prev && { ...prev, phase: 'cancelled', pct: 0, loaded: 0 });
        onNotice(L(locale, '已取消上传。', 'Upload cancelled.'));
        return;
      }
      const message = uploadFailureText(result.error, result.errorMessage);
      setVideoUpload((prev) => prev && { ...prev, phase: 'error', error: message });
      onNotice(message);
      return;
    }

    setVideoUpload((prev) => prev && { ...prev, phase: 'assigning', assetId: result.data.id });
    const assigned = await boRequest<{ assetId: string; durationSeconds: number | null }>(
      `/api/backoffice/courses/${course.id}/lessons/${lessonId}/video`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ language: contentLanguage, assetId: result.data.id }),
      },
    );
    if (!assigned.success) {
      const message = `${L(locale, '视频已上传，但绑定到课时失败', 'Video uploaded, but assigning it to the lesson failed')}: ${assigned.message ?? assigned.error}`;
      setVideoUpload((prev) => prev && { ...prev, phase: 'error', error: message });
      onNotice(message);
      return;
    }
    setVideoUpload((prev) =>
      prev && { ...prev, phase: 'done', pct: 100, durationSeconds: assigned.data.durationSeconds },
    );
    onNotice(L(locale, '视频已上传并绑定到当前课时。', 'Video uploaded and assigned to this lesson.'));
    await onReload();
  }

  function cancelVideoUpload() {
    videoAbortRef.current?.abort();
  }

  async function batchUploadExhibits(files: FileList | null) {
    if (!files || !activeLesson) return;
    const list = Array.from(files);
    setBusy(true);
    const failures: string[] = [];
    let uploadedCount = 0;
    for (let index = 0; index < list.length; index++) {
      const file = list[index];
      setExhibitUpload({ index: index + 1, total: list.length, fileName: file.name, pct: 0 });
      const form = new FormData();
      form.append('file', file);
      const uploaded = await uploadFileWithProgress<UploadResult>(
        `/api/backoffice/courses/${course.id}/media`,
        file,
        (pct) => setExhibitUpload({ index: index + 1, total: list.length, fileName: file.name, pct }),
      );
      if (!uploaded.success) {
        failures.push(`${file.name}（${uploaded.errorMessage ?? uploaded.error}）`);
        continue;
      }
      const type =
        uploaded.data.kind === 'VIDEO' ? 'VIDEO' : uploaded.data.kind === 'MODEL3D' ? 'MODEL3D' : 'IMAGE';
      const created = await boRequest(`/api/backoffice/courses/${course.id}/lessons/${activeLesson.id}/exhibits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, mediaAssetId: uploaded.data.id, localized: {} }),
      });
      if (!created.success) {
        failures.push(`${file.name}（${created.message ?? created.error}）`);
        continue;
      }
      uploadedCount += 1;
    }
    setExhibitUpload(null);
    setBusy(false);
    if (failures.length > 0) {
      onNotice(
        L(
          locale,
          `已上传 ${uploadedCount}/${list.length} 个展品，失败：${failures.join('；')}`,
          `Uploaded ${uploadedCount}/${list.length} exhibits. Failed: ${failures.join('; ')}`,
        ),
      );
    } else {
      onNotice(L(locale, '展品已上传，点击「补全」填写信息。', 'Exhibits uploaded; click Complete to finish details.'));
    }
    await onReload();
  }

  async function addLesson() {
    const title = window.prompt(L(locale, '课时标题', 'Lesson title'))?.trim();
    if (!title) return;
    setBusy(true);
    const result = await boRequest<CourseDetail>(`/api/backoffice/courses/${course.id}/lessons`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, language: contentLanguage }),
    });
    setBusy(false);
    if (result.success) {
      const newest = [...result.data.lessons].sort((a, b) => b.sortOrder - a.sortOrder)[0];
      if (newest) setActiveLessonId(newest.id);
      await onReload();
    } else {
      onNotice(`${L(locale, '添加课时失败', 'Could not add lesson')}: ${result.message ?? result.error}`);
    }
  }

  async function deleteLesson() {
    if (!activeLesson) return;
    if (!window.confirm(L(locale, '确认移除该课时？下次发布后才会从网站消失。', 'Remove this lesson? It disappears from the website after the next Publish.'))) return;
    setBusy(true);
    const result = await boRequest<CourseDetail>(`/api/backoffice/courses/${course.id}/lessons/${activeLesson.id}`, { method: 'DELETE' });
    setBusy(false);
    if (result.success) {
      setActiveLessonId(result.data.lessons[0]?.id ?? '');
      await onReload();
    } else {
      onNotice(`${L(locale, '删除失败', 'Delete failed')}: ${result.message ?? result.error}`);
    }
  }

  async function moveLesson(direction: -1 | 1) {
    if (!activeLesson) return;
    const ordered = [...sortedLessons];
    const index = ordered.findIndex((lesson) => lesson.id === activeLesson.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ordered.length) return;
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    setBusy(true);
    const result = await boRequest<CourseDetail>(`/api/backoffice/courses/${course.id}/lessons/reorder`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lessonIds: ordered.map((lesson) => lesson.id) }),
    });
    setBusy(false);
    if (result.success) await onReload();
    else onNotice(`${L(locale, '排序失败', 'Reorder failed')}: ${result.message ?? result.error}`);
  }

  async function runAllUnderstandingImport() {
    if (!allImportFile) return;
    setImportBusy(true);
    const form = new FormData();
    form.append('file', allImportFile);
    const result = await boRequest<{ added: number; byLesson: Record<string, number>; errors: Array<{ row: number; message: string }> }>(
      `/api/backoffice/courses/${course.id}/understanding/import?language=${encodeURIComponent(allImportLanguage)}`,
      { method: 'POST', body: form },
    );
    setImportBusy(false);
    if (result.success) {
      setAllImportResult({ added: result.data.added, byLesson: result.data.byLesson, errors: result.data.errors ?? [] });
      if (result.data.added > 0) await onReload();
    } else {
      setAllImportResult({ added: 0, errors: [{ row: 0, message: result.message ?? result.error }] });
    }
  }

  async function runReadingImport() {
    if (!readingImportFile) return;
    setImportBusy(true);
    const form = new FormData();
    form.append('file', readingImportFile);
    const result = await boRequest<{ added: number; errors: Array<{ row: number; message: string }> }>(`/api/backoffice/courses/${course.id}/readings/import`, { method: 'POST', body: form });
    setImportBusy(false);
    if (result.success) {
      setReadingImportResult({ added: result.data.added, errors: result.data.errors ?? [] });
      if (result.data.added > 0) await onReload();
    } else {
      setReadingImportResult({ added: 0, errors: [{ row: 0, message: result.message ?? result.error }] });
    }
  }

  const currentVideoLoc = activeLesson ? loc(activeLesson, contentLanguage) : undefined;
  const mediaLimits = useMediaLimits();
  // PRD 12.5.1：Lesson 时长 = 视频时长；Course 时长 = 全部 Lesson 时长之和。
  const courseDurationSeconds = sortedLessons.reduce(
    (sum, lesson) => sum + (loc(lesson, contentLanguage)?.videoDurationSeconds ?? 0),
    0,
  );
  const videoBusy =
    videoUpload?.phase === 'uploading' ||
    videoUpload?.phase === 'processing' ||
    videoUpload?.phase === 'assigning';

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 20, marginTop: 18 }}>
      <aside style={{ ...card, marginTop: 0, padding: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>{L(locale, '课时', 'Lessons')}</h3>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" style={{ ...buttonStyle, padding: '4px 8px' }} onClick={() => setImportMenuOpen((value) => !value)}>{L(locale, '导入', 'Import')}</button>
            <button type="button" style={{ ...buttonStyle, padding: '4px 8px' }} onClick={() => void addLesson()}>+ {L(locale, '添加', 'Add')}</button>
          </div>
        </div>
        {importMenuOpen && (
          <div style={{ marginBottom: 10, border: '1px solid #E8EDF5', borderRadius: 8, overflow: 'hidden' }}>
            <button type="button" style={{ width: '100%', border: 0, background: '#fff', padding: '8px 10px', textAlign: 'left', cursor: 'pointer' }} onClick={() => { setAllUnderstandingOpen(true); setImportMenuOpen(false); }}>{L(locale, '理解测试（全部课时）', 'Understanding (all lessons)')}</button>
            <button type="button" style={{ width: '100%', border: 0, borderTop: '1px solid #EEF1F6', background: '#fff', padding: '8px 10px', textAlign: 'left', cursor: 'pointer' }} onClick={() => { setAllReadingsOpen(true); setImportMenuOpen(false); }}>{L(locale, '推荐阅读（全部课时）', 'Recommended reading (all lessons)')}</button>
          </div>
        )}
        {sortedLessons.map((lesson) => {
          const completeness = (course.completeness.steps.content.lessons ?? []).find((item) => item.lessonId === lesson.id);
          const title = loc(lesson, contentLanguage)?.title ?? lesson.code;
          const meta = part === 'study'
            ? `${loc(lesson, contentLanguage)?.videoDurationSeconds ? `${Math.round((loc(lesson, contentLanguage)?.videoDurationSeconds ?? 0) / 60)}:${String(Math.round((loc(lesson, contentLanguage)?.videoDurationSeconds ?? 0) % 60)).padStart(2, '0')}` : '—'} · ${lesson.learningPoints.filter((point) => point.language === contentLanguage && point.source === 'VIDEO').length} ${L(locale, '学习点', 'LPs')} · ${lesson.exhibits.length} ${L(locale, '个展品', 'exhibits')}`
            : `${lesson.questions.length} ${L(locale, '题', 'questions')} · ${lesson.applicationTest ? L(locale, '有应用测试', 'App test') : L(locale, '无应用测试', 'no App test')}`;
          return (
            <button key={lesson.id} type="button" title={completeness && completeness.missing.length > 0 ? completeness.missing.map((item) => localizeMissing(locale, item)).join(locale.startsWith('zh') ? '；' : '; ') : undefined} onClick={() => setActiveLessonId(lesson.id)} style={{ ...buttonStyle, display: 'block', width: '100%', textAlign: 'left', marginBottom: 6, borderColor: activeLessonId === lesson.id ? '#2B58C8' : '#E8EDF5', background: activeLessonId === lesson.id ? '#F5F8FF' : '#fff' }}>
              <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontWeight: 600 }}>{lesson.sortOrder}. {title}</span>
                <span>{completeness?.studyComplete ? '✓' : '!'}{completeness?.understandingComplete ? '✓' : '!'}</span>
              </span>
              <span style={{ display: 'block', fontSize: 11, color: '#5A6577', marginTop: 2 }}>{meta}</span>
            </button>
          );
        })}
        {sortedLessons.length === 0 && <p style={{ opacity: 0.7, fontSize: 13 }}>{L(locale, '暂无课时。', 'No lessons yet.')}</p>}
      </aside>

      {activeLesson ? (
        <div>
          <div style={{ ...card, marginTop: 0, padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, '课时', 'Lesson')} {activeLesson.sortOrder} · {loc(activeLesson, contentLanguage)?.title ?? activeLesson.code}</h2>
                <div style={{ fontSize: 12, color: '#5A6577', marginTop: 4 }}>{activeLesson.code} · {activeLesson.id}</div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button type="button" title={lessonCompleteness && lessonCompleteness.missing.length > 0 ? lessonCompleteness.missing.map((item) => localizeMissing(locale, item)).join(locale.startsWith('zh') ? '；' : '; ') : undefined} style={{ ...buttonStyle, borderColor: part === 'study' ? '#2B58C8' : '#d9e0ea', color: part === 'study' ? '#2B58C8' : '#25314C', fontWeight: 600 }} onClick={() => setPart('study')}>{L(locale, '学习与探索', 'Study & Exploration')} {lessonCompleteness?.studyComplete ? '✓' : '!'}</button>
                <button type="button" style={{ ...buttonStyle, borderColor: part === 'understanding' ? '#2B58C8' : '#d9e0ea', color: part === 'understanding' ? '#2B58C8' : '#25314C', fontWeight: 600 }} onClick={() => setPart('understanding')}>{L(locale, '理解', 'Understanding')} {lessonCompleteness?.understandingComplete ? '✓' : '!'}</button>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginTop: 12 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <Chip tone={activeLesson.localizations.find((item) => item.language === contentLanguage)?.video ? 'green' : 'grey'}>{L(locale, '视频', 'Video')} {activeLesson.localizations.find((item) => item.language === contentLanguage)?.video ? '✓' : '—'}</Chip>
                <Chip>{fmtDuration(activeLesson.localizations.find((item) => item.language === contentLanguage)?.videoDurationSeconds)}</Chip>
                <Chip>{L(locale, '学习点', 'LPs')} {activeLesson.learningPoints.filter((point) => point.language === contentLanguage).length}</Chip>
                <Chip>{L(locale, '展品', 'Exhibits')} {activeLesson.exhibits.length}</Chip>
                <Chip>{L(locale, '知识测试', 'Knowledge')} {activeLesson.questions.length}</Chip>
                <Chip>{L(locale, '阅读', 'Reading')} {activeLesson.readings.length}</Chip>
                <Chip tone={activeLesson.applicationTest ? 'green' : 'grey'}>{L(locale, '应用测试', 'Application')} {activeLesson.applicationTest ? '✓' : '—'}</Chip>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button type="button" style={{ ...buttonStyle, padding: '4px 8px' }} disabled={busy} onClick={() => void moveLesson(-1)}>↑</button>
                <button type="button" style={{ ...buttonStyle, padding: '4px 8px' }} disabled={busy} onClick={() => void moveLesson(1)}>↓</button>
                <button type="button" style={{ ...dangerBtn, padding: '4px 8px' }} disabled={busy} onClick={() => void deleteLesson()}>{L(locale, '移除', 'Remove')}</button>
              </div>
            </div>
          </div>

          <div style={{ ...card, marginTop: 14, padding: 16 }}>
            <h3 style={{ margin: 0, fontSize: 16 }}>{L(locale, '课时信息', 'Lesson info')}</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 10 }}>
              <div>
                <label style={labelStyle}>{L(locale, '英文', 'English')}</label>
                <Field label={L(locale, '课时 ID', 'Lesson ID')}><input value={lessonCode} onChange={(event) => setLessonCode(event.target.value)} style={inputStyle} /></Field>
                <Field label={L(locale, '课时标题 *', 'Lesson title *')}><input value={lessonTitleEn} onChange={(event) => setLessonTitleEn(event.target.value)} style={inputStyle} /></Field>
                <Field label={L(locale, '课时简介 *', 'Lesson description *')}><textarea rows={2} value={lessonDescEn} onChange={(event) => setLessonDescEn(event.target.value)} style={inputStyle} /></Field>
              </div>
              <div>
                <label style={labelStyle}>{L(locale, '中文', 'Chinese')}</label>
                <Field label={L(locale, '课时标题 *', 'Lesson title *')}><input value={lessonTitleZh} onChange={(event) => setLessonTitleZh(event.target.value)} style={inputStyle} /></Field>
                <Field label={L(locale, '课时简介 *', 'Lesson description *')}><textarea rows={2} value={lessonDescZh} onChange={(event) => setLessonDescZh(event.target.value)} style={inputStyle} /></Field>
              </div>
            </div>
          </div>

          {part === 'study' && (
            <>
              <div style={{ ...card, marginTop: 14, padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: 16 }}>{L(locale, '展品', 'Exhibits')}</h3>
                    <p style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.65 }}>{L(locale, '列表顺序就是学生端探索页中该课时的展品顺序。', "The list order is the exhibit order in the learner's Exploration.")}</p>
                    {mediaLimits && (
                      <p style={{ margin: '2px 0 0', fontSize: 12, opacity: 0.65 }}>
                        {L(
                          locale,
                          `单文件上限：图片 ${formatBytes(mediaLimits.imageBytes)} · 视频 ${formatBytes(mediaLimits.videoBytes)} · 3D ${formatBytes(mediaLimits.modelBytes)}`,
                          `Per-file limits: image ${formatBytes(mediaLimits.imageBytes)} · video ${formatBytes(mediaLimits.videoBytes)} · 3D ${formatBytes(mediaLimits.modelBytes)}`,
                        )}
                      </p>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: '#5A6577' }}>{exhibits.length} {L(locale, '个展品', 'in Exploration')}</span>
                    <label style={{ ...buttonStyle, cursor: busy ? 'not-allowed' : 'pointer' }}>
                      + {L(locale, '批量上传', 'Upload exhibits')}
                      <input type="file" multiple disabled={busy} style={{ display: 'none' }} onChange={(event) => { void batchUploadExhibits(event.target.files); event.currentTarget.value = ''; }} />
                    </label>
                  </div>
                </div>
                {exhibitUpload && (
                  <UploadProgress
                    tone="active"
                    title={L(
                      locale,
                      `正在上传展品 ${exhibitUpload.index}/${exhibitUpload.total}：${exhibitUpload.fileName}`,
                      `Uploading exhibit ${exhibitUpload.index}/${exhibitUpload.total}: ${exhibitUpload.fileName}`,
                    )}
                    pct={exhibitUpload.pct}
                  />
                )}
                <div style={{ marginTop: 10 }}>
                  {exhibits.map((exhibit) => {
                    const title = pickLocalized(exhibit.localized, 'title', contentLanguage, exhibit.code);
                    const complete = Boolean(exhibit.media && exhibit.thumbnail && (exhibit.localized?.[contentLanguage]?.title || exhibit.localized?.['en-GB']?.title) && (exhibit.localized?.[contentLanguage]?.description || exhibit.localized?.['en-GB']?.description));
                    return (
                      <div key={exhibit.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', border: `1px solid ${complete ? '#E8EDF5' : '#F5C7A8'}`, borderRadius: 10, padding: 10, marginTop: 8, background: complete ? '#fff' : '#FFF8F2' }}>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                          {exhibit.thumbnail ? <img src={`/api/backoffice/courses/${course.id}/media/${exhibit.thumbnail.id}`} alt="" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6 }} /> : <div style={{ width: 44, height: 44, borderRadius: 6, background: '#EEF1F6' }} />}
                          <div>
                            <strong>{title}</strong>
                            <div style={{ fontSize: 11, color: '#5A6577' }}>{exhibit.code} · {exhibitTypeLabel(locale, exhibit.type)}</div>
                          </div>
                        </div>
                        <button type="button" style={buttonStyle} onClick={() => setExhibitDrawer(exhibit.id)}>{complete ? L(locale, '编辑', 'Edit') : L(locale, '补全', 'Complete')}</button>
                      </div>
                    );
                  })}
                  {exhibits.length === 0 && <p style={{ opacity: 0.7, fontSize: 13, marginTop: 10 }}>{L(locale, '暂无展品。', 'No exhibits yet.')}</p>}
                </div>
              </div>

              <div style={{ ...card, marginTop: 14, padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {hasVideo && <button type="button" style={{ ...buttonStyle, borderColor: studyTab === 'video' ? '#2B58C8' : '#d9e0ea', color: studyTab === 'video' ? '#2B58C8' : '#25314C', fontWeight: 600 }} onClick={() => setStudyTab('video')}>{L(locale, '视频', 'Video')}</button>}
                    {hasText && <button type="button" style={{ ...buttonStyle, borderColor: studyTab === 'text' ? '#2B58C8' : '#d9e0ea', color: studyTab === 'text' ? '#2B58C8' : '#25314C', fontWeight: 600 }} onClick={() => setStudyTab('text')}>{L(locale, '文字', 'Text')}</button>}
                  </div>
                  <div style={{ fontSize: 12, color: '#5A6577' }}>{L(locale, '内容语言', 'Content language')} {languageLabel(locale, contentLanguage)}</div>
                </div>

                {studyTab === 'video' && hasVideo && (
                  <div style={{ marginTop: 14 }}>
                    {currentVideoLoc?.video ? (
                      <div style={{ border: '1px solid #C7E8D3', background: '#F4FBF6', borderRadius: 10, padding: '12px 14px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
                            <Chip tone="green">✓ {L(locale, '视频已上传', 'Video uploaded')}</Chip>
                            <strong style={{ fontSize: 14, wordBreak: 'break-all' }}>
                              {currentVideoLoc.video.originalName?.trim()
                                ? currentVideoLoc.video.originalName
                                : `${L(locale, '视频文件', 'Video file')} #${currentVideoLoc.video.id.slice(0, 8)}`}
                            </strong>
                          </div>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <button
                              type="button"
                              style={{ ...buttonStyle, padding: '4px 10px' }}
                              onClick={() => setVideoPreviewOpen((value) => !value)}
                            >
                              {videoPreviewOpen ? L(locale, '收起预览', 'Hide preview') : L(locale, '预览', 'Preview')}
                            </button>
                            <label style={{ ...buttonStyle, padding: '4px 10px', cursor: busy || videoBusy ? 'not-allowed' : 'pointer', opacity: busy || videoBusy ? 0.6 : 1 }}>
                              {videoBusy ? L(locale, '上传中…', 'Uploading…') : L(locale, '替换视频', 'Replace video')}
                              <input type="file" accept="video/mp4,video/quicktime,video/webm" disabled={busy || videoBusy} style={{ display: 'none' }} onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (!file) return; if (currentVideoLoc?.video && !window.confirm(L(locale, '替换后该课时学员的播放进度会清零（课程完成状态不变）。确认替换？', 'Replacing resets learners’ playback position for this lesson (course completion is kept). Continue?'))) return; void uploadVideo(file, Date.now()); }} />
                            </label>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: '8px 20px', flexWrap: 'wrap', marginTop: 10, fontSize: 12, color: '#3B4A63' }}>
                          <span>
                            <span style={{ color: '#5A6577' }}>{L(locale, '时长（自动读取）', 'Duration (auto-read)')}</span>{' '}
                            <strong>{fmtDuration(currentVideoLoc.videoDurationSeconds)}</strong>
                          </span>
                          <span>
                            <span style={{ color: '#5A6577' }}>{L(locale, '文件大小', 'File size')}</span>{' '}
                            <strong>{currentVideoLoc.video.size ? formatBytes(currentVideoLoc.video.size) : '—'}</strong>
                          </span>
                          <span>
                            <span style={{ color: '#5A6577' }}>{L(locale, '格式', 'Format')}</span>{' '}
                            <strong>{(currentVideoLoc.video.extension ?? 'video').toUpperCase()}</strong>
                          </span>
                          <span>
                            <span style={{ color: '#5A6577' }}>{L(locale, '上传时间', 'Uploaded')}</span> {fmtDate(currentVideoLoc.video.createdAt, locale)}
                          </span>
                        </div>
                        <div style={{ marginTop: 6, fontSize: 12, color: '#5A6577' }}>
                          {L(locale, '本课时长', 'Lesson length')} {fmtDuration(currentVideoLoc.videoDurationSeconds)} · {L(locale, '课程总时长', 'Course length')} {fmtDuration(courseDurationSeconds)}
                        </div>
                        <div style={{ marginTop: 2, fontSize: 12, color: '#8A6D00' }}>
                          {L(
                            locale,
                            '替换视频后，该课时学员的播放进度会清零（课程完成状态保持不变）。',
                            'Replacing the video resets learners’ playback position for this lesson (course completion is kept).',
                          )}
                        </div>
                        {videoPreviewOpen && (
                          <video
                            controls
                            preload="metadata"
                            src={`/api/backoffice/courses/${course.id}/media/${currentVideoLoc.video.id}`}
                            style={{ width: '100%', maxHeight: 320, marginTop: 10, borderRadius: 8, background: '#000' }}
                          />
                        )}
                      </div>
                    ) : (
                      <div style={{ border: '1px dashed #C9D3E3', borderRadius: 10, padding: '14px', background: '#FAFBFD', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                        <div>
                          <strong style={{ fontSize: 13 }}>{L(locale, '尚未上传视频', 'No video yet')}</strong>
                          <div style={{ fontSize: 12, color: '#5A6577', marginTop: 4 }}>
                            {L(
                              locale,
                              '上传后系统会自动读取视频时长（无需手填），并作为本课时长与学习点、触发点的时间轴。',
                              'After upload the duration is read from the file automatically (no manual entry); it becomes the lesson length and the timeline for learning points and triggers.',
                            )}
                          </div>
                        </div>
                        <label style={{ ...buttonStyle, cursor: busy || videoBusy ? 'not-allowed' : 'pointer', opacity: busy || videoBusy ? 0.6 : 1 }}>
                          {videoBusy ? L(locale, '上传中…', 'Uploading…') : L(locale, '上传视频', 'Upload video')}
                          <input type="file" accept="video/mp4,video/quicktime,video/webm" disabled={busy || videoBusy} style={{ display: 'none' }} onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadVideo(file, Date.now()); event.currentTarget.value = ''; }} />
                        </label>
                      </div>
                    )}
                    <p style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.65 }}>
                      {mediaLimits
                        ? L(
                            locale,
                            `支持 MP4 / MOV / WebM，单文件最大 ${formatBytes(mediaLimits.videoBytes)}。大文件会自动分块上传并显示进度，可随时取消或重试。`,
                            `MP4 / MOV / WebM, up to ${formatBytes(mediaLimits.videoBytes)} per file. Large files upload in chunks with live progress and can be cancelled or retried.`,
                          )
                        : L(
                            locale,
                            '支持 MP4 / MOV / WebM。大文件会自动分块上传并显示进度，可随时取消或重试。',
                            'MP4 / MOV / WebM. Large files upload in chunks with live progress, and can be cancelled or retried.',
                          )}
                    </p>
                    {videoUpload && videoUpload.phase === 'uploading' && (
                      <UploadProgress
                        tone="active"
                        title={L(locale, `正在上传 ${videoUpload.fileName}`, `Uploading ${videoUpload.fileName}`)}
                        pct={videoUpload.pct}
                        loaded={videoUpload.loaded}
                        total={videoUpload.size}
                        elapsedMs={videoUpload.elapsedMs}
                        onCancel={cancelVideoUpload}
                        cancelLabel={L(locale, '取消上传', 'Cancel upload')}
                      />
                    )}
                    {videoUpload && videoUpload.phase === 'processing' && (
                      <UploadProgress
                        tone="active"
                        title={L(locale, '已上传，服务端正在校验并保存视频…', 'Uploaded. The server is validating and saving the video…')}
                        pct={100}
                        detail={L(locale, `文件大小 ${formatBytes(videoUpload.size)}`, `Size ${formatBytes(videoUpload.size)}`)}
                      />
                    )}
                    {videoUpload && videoUpload.phase === 'assigning' && (
                      <UploadProgress
                        tone="active"
                        title={L(locale, '正在绑定到当前课时…', 'Assigning the video to this lesson…')}
                        pct={100}
                      />
                    )}
                    {videoUpload && videoUpload.phase === 'done' && (
                      <UploadProgress
                        tone="success"
                        title={L(locale, `已完成上传：${videoUpload.fileName}`, `Upload complete: ${videoUpload.fileName}`)}
                        pct={100}
                        detail={`${formatBytes(videoUpload.size)} · ${L(locale, '时长（自动读取）', 'Duration (auto-read)')} ${fmtDuration(videoUpload.durationSeconds)}`}
                      />
                    )}
                    {videoUpload && videoUpload.phase === 'error' && (
                      <UploadProgress
                        tone="error"
                        title={L(locale, '视频上传失败', 'Video upload failed')}
                        detail={videoUpload.error}
                      />
                    )}
                    {videoUpload && videoUpload.phase === 'cancelled' && (
                      <UploadProgress
                        tone="muted"
                        title={L(locale, '已取消上传', 'Upload cancelled')}
                        detail={videoUpload.fileName}
                      />
                    )}
                    {videoUpload && (videoUpload.phase === 'error' || videoUpload.phase === 'cancelled') && (
                      <div style={{ marginTop: 8 }}>
                        <button
                          type="button"
                          style={primaryBtn}
                          disabled={busy || videoBusy}
                          onClick={() => {
                            const file = lastVideoFileRef.current;
                            if (file) void uploadVideo(file, Date.now());
                          }}
                        >
                          {L(locale, '重试上传', 'Retry upload')}
                        </button>
                      </div>
                    )}
                    <div style={{ marginTop: 14 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <strong style={{ fontSize: 14 }}>{L(locale, '学习点', 'Learning points')}</strong>
                        <button type="button" style={buttonStyle} onClick={() => setVideoLps((rows) => [...rows, { code: `V${rows.length + 1}`, title: '', timeSeconds: 0 }])}>+ {L(locale, '添加学习点', 'Add learning point')}</button>
                      </div>
                      <div style={{ fontSize: 12, color: '#5A6577', marginTop: 4 }}>{L(locale, '时间（mm:ss）+ 标题', 'Time (mm:ss) + title')}</div>
                      {videoLps.map((point, index) => {
                        const beyond = videoDuration !== null && point.timeSeconds > videoDuration;
                        return (
                          <div key={index} style={{ display: 'grid', gridTemplateColumns: '70px 1fr 110px 40px', gap: 8, marginTop: 8, alignItems: 'center' }}>
                            <span style={{ fontSize: 12, color: '#5A6577' }}>{activeLesson.sortOrder}.{index + 1}</span>
                            <input value={point.title} onChange={(event) => setVideoLps((rows) => rows.map((item, i) => i === index ? { ...item, title: event.target.value } : item))} placeholder={L(locale, '学习点标题', 'Learning point title')} style={inputStyle} />
                            <TimeInput seconds={point.timeSeconds} onChange={(seconds) => setVideoLps((rows) => rows.map((item, i) => i === index ? { ...item, timeSeconds: seconds ?? 0 } : item))} placeholder="mm:ss" style={{ ...inputStyle, borderColor: beyond ? '#b42318' : '#d9e0ea' }} />
                            <button type="button" style={{ ...dangerBtn, padding: '6px 8px' }} onClick={() => setVideoLps((rows) => rows.filter((_, i) => i !== index))}>×</button>
                            {beyond && <div style={{ gridColumn: '1 / -1', fontSize: 11, color: '#b42318' }}>{L(locale, '超出视频时长', 'Beyond video length')} ({fmtDuration(videoDuration)})</div>}
                          </div>
                        );
                      })}
                    </div>

                    <div style={{ marginTop: 16 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <strong style={{ fontSize: 14 }}>{L(locale, '展品触发点', 'Exhibit triggers')}</strong>
                        <button type="button" style={buttonStyle} onClick={() => setTriggerRows((rows) => [...rows, { exhibitId: exhibits[0]?.id ?? '', timeSeconds: 0 }])}>+ {L(locale, '添加触发点', 'Add trigger')}</button>
                      </div>
                      {triggerRows.map((trigger, index) => (
                        <div key={index} style={{ display: 'grid', gridTemplateColumns: '1fr 110px 40px', gap: 8, marginTop: 8, alignItems: 'center' }}>
                          <select value={trigger.exhibitId} onChange={(event) => setTriggerRows((rows) => rows.map((item, i) => i === index ? { ...item, exhibitId: event.target.value } : item))} style={inputStyle}>
                            <option value="">{L(locale, '选择展品', 'Choose an exhibit')}</option>
                            {exhibits.map((exhibit) => <option key={exhibit.id} value={exhibit.id}>{pickLocalized(exhibit.localized, 'title', contentLanguage, exhibit.code)}</option>)}
                          </select>
                          <TimeInput seconds={trigger.timeSeconds} onChange={(seconds) => setTriggerRows((rows) => rows.map((item, i) => i === index ? { ...item, timeSeconds: seconds ?? 0 } : item))} placeholder="mm:ss" style={inputStyle} />
                          <button type="button" style={{ ...dangerBtn, padding: '6px 8px' }} onClick={() => setTriggerRows((rows) => rows.filter((_, i) => i !== index))}>×</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {studyTab === 'text' && hasText && (
                  <div style={{ marginTop: 14 }}>
                    <TextEditor
                      locale={locale}
                      value={textHtml}
                      onChange={setTextHtml}
                      exhibits={exhibits}
                      language={contentLanguage}
                      onImportDocx={importDocx}
                      onNotice={onNotice}
                    />
                    <div style={{ marginTop: 12, fontSize: 13 }}>
                      <strong>{L(locale, '学习点识别区', 'Learning points')}</strong>
                      <p style={{ fontSize: 12, color: '#5A6577', marginTop: 4 }}>{L(locale, '仅一级标题识别为学习点；一级标题文本即学习点标题。', 'Only Heading 1 becomes a learning point; its text is the title.')}</p>
                      {textLps.length === 0 ? (
                        <p style={{ color: '#b42318', marginTop: 6 }}>{L(locale, '未识别到学习点。请把每个学习点标题设置为一级标题（H1）。', 'No learning points found. Set each learning point title as Heading 1 (H1).')}</p>
                      ) : (
                        textLps.map((point, index) => (
                          <div key={index} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 8px', border: `1px solid ${point.heading && point.hasBody ? '#E8EDF5' : '#F5C7A8'}`, borderRadius: 6, marginTop: 6 }}>
                            <span style={{ fontSize: 12 }}>{activeLesson.sortOrder}.{index + 1} {point.heading || L(locale, '标题文本', 'Heading text')}</span>
                            <span style={{ fontSize: 11, color: point.hasBody ? '#1E7A3C' : '#b42318' }}>{point.hasBody ? L(locale, '正常', 'OK') : L(locale, '该标题下没有正文', 'No text under this heading')}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div style={{ ...card, marginTop: 14, padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: 16 }}>{L(locale, '推荐阅读', 'Recommended reading')}</h3>
                    <p style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.65 }}>{L(locale, '只有英文一份列表；所有学员看到同一份。', 'One English list only; all learners see the same list.')}</p>
                  </div>
                  <button type="button" style={buttonStyle} onClick={() => setReadingRows((rows) => [...rows, { type: 'BOOK', title: '', author: '', whyRecommended: '' }])}>+ {L(locale, '添加阅读', 'Add reading')}</button>
                </div>
                {readingRows.map((reading, index) => (
                  <div key={index} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 1fr 1.4fr 40px', gap: 8, marginTop: 8, alignItems: 'center' }}>
                    <select value={reading.type} onChange={(event) => setReadingRows((rows) => rows.map((item, i) => i === index ? { ...item, type: event.target.value } : item))} style={inputStyle}>
                      <option value="BOOK">{readingTypeLabel(locale, 'BOOK')}</option>
                      <option value="ARTICLE">{readingTypeLabel(locale, 'ARTICLE')}</option>
                      <option value="PAPER">{readingTypeLabel(locale, 'PAPER')}</option>
                      <option value="OTHER">{readingTypeLabel(locale, 'OTHER')}</option>
                    </select>
                    <input value={reading.title} onChange={(event) => setReadingRows((rows) => rows.map((item, i) => i === index ? { ...item, title: event.target.value } : item))} placeholder={L(locale, '标题', 'Title')} style={inputStyle} />
                    <input value={reading.author} onChange={(event) => setReadingRows((rows) => rows.map((item, i) => i === index ? { ...item, author: event.target.value } : item))} placeholder={L(locale, '作者', 'Author')} style={inputStyle} />
                    <input value={reading.whyRecommended} onChange={(event) => setReadingRows((rows) => rows.map((item, i) => i === index ? { ...item, whyRecommended: event.target.value } : item))} placeholder={L(locale, '推荐理由', 'Why we recommend it')} style={inputStyle} />
                    <button type="button" style={{ ...dangerBtn, padding: '6px 8px' }} onClick={() => setReadingRows((rows) => rows.filter((_, i) => i !== index))}>×</button>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
                <button type="button" style={primaryBtn} disabled={busy} onClick={() => void saveStudy()}>{L(locale, '保存', 'Save')}</button>
              </div>
            </>
          )}

          {part === 'understanding' && (
            <UnderstandingPanel
              locale={locale}
              courseId={course.id}
              lesson={activeLesson}
              language={contentLanguage}
              busy={busy}
              setBusy={setBusy}
              onSaved={onReload}
              onNotice={onNotice}
            />
          )}
        </div>
      ) : (
        <div style={card}><p style={{ margin: 0, opacity: 0.7 }}>{L(locale, '添加一个课时开始编辑。', 'Add a lesson to start editing.')}</p></div>
      )}

      {exhibitDrawer && activeLesson && (
        <ExhibitDrawer
          locale={locale}
          courseId={course.id}
          lesson={activeLesson}
          exhibit={exhibitDrawer === 'new' ? undefined : exhibits.find((exhibit) => exhibit.id === exhibitDrawer)}
          learningLanguages={course.learningLanguages}
          busy={busy}
          setBusy={setBusy}
          onSaved={onReload}
          onNotice={onNotice}
          onClose={() => setExhibitDrawer(null)}
        />
      )}

      {allUnderstandingOpen && (
        <Modal title={L(locale, '导入理解题', 'Import Understanding')} onClose={() => { setAllUnderstandingOpen(false); setAllImportFile(null); setAllImportResult(null); }}>
          <p style={{ fontSize: 13, color: '#5A6577' }}>{L(locale, '全部课时 ·', 'All lessons ·')} {languageLabel(locale, allImportLanguage)}</p>
          <Field label={L(locale, '语言', 'Language')}>
            <select value={allImportLanguage} onChange={(event) => setAllImportLanguage(event.target.value)} style={inputStyle}>
              {course.learningLanguages.map((language) => <option key={language} value={language}>{languageLabel(locale, language)}</option>)}
            </select>
          </Field>
          <Field label={L(locale, '上传 .xlsx 或 .csv', 'Upload .xlsx or .csv')}>
            <input type="file" accept=".xlsx,.csv" onChange={(event) => { setAllImportFile(event.target.files?.[0] ?? null); setAllImportResult(null); }} />
          </Field>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" style={primaryBtn} disabled={!allImportFile || importBusy} onClick={() => void runAllUnderstandingImport()}>{importBusy ? L(locale, '导入中…', 'Importing…') : L(locale, '导入', 'Import')}</button>
            <button type="button" style={buttonStyle} onClick={() => window.open(`/api/backoffice/courses/${course.id}/understanding/template`, '_blank')}>{L(locale, '下载模板', 'Download template')}</button>
          </div>
          {allImportResult && (
            <div style={{ marginTop: 12, fontSize: 13 }}>
              <p style={{ fontWeight: 600 }}>{L(locale, '已导入', 'Imported')} {allImportResult.added} {L(locale, '题', 'questions')}</p>
              {allImportResult.byLesson && Object.entries(allImportResult.byLesson).map(([lessonCode, count]) => (
                <p key={lessonCode}>{lessonCode} · Knowledge Test +{count}</p>
              ))}
              {allImportResult.errors.map((error, index) => (
                <p key={index} style={{ color: '#b42318' }}>{L(locale, '第', 'Row')} {error.row} · {serverText(error.message, locale as Locale)}</p>
              ))}
              <button type="button" style={primaryBtn} onClick={() => { setAllUnderstandingOpen(false); setAllImportFile(null); setAllImportResult(null); }} disabled={allImportResult.added === 0}>
                {L(locale, `导入 ${allImportResult.added} 题`, `Import ${allImportResult.added} questions`)}
              </button>
            </div>
          )}
        </Modal>
      )}

      {allReadingsOpen && (
        <Modal title={L(locale, '导入推荐阅读', 'Import recommended reading')} onClose={() => { setAllReadingsOpen(false); setReadingImportFile(null); setReadingImportResult(null); }}>
          <Field label={L(locale, '上传 .xlsx 或 .csv', 'Upload .xlsx or .csv')}>
            <input type="file" accept=".xlsx,.csv" onChange={(event) => { setReadingImportFile(event.target.files?.[0] ?? null); setReadingImportResult(null); }} />
          </Field>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" style={primaryBtn} disabled={!readingImportFile || importBusy} onClick={() => void runReadingImport()}>{importBusy ? L(locale, '导入中…', 'Importing…') : L(locale, '导入', 'Import')}</button>
          </div>
          {readingImportResult && (
            <div style={{ marginTop: 12, fontSize: 13 }}>
              <p style={{ fontWeight: 600 }}>{L(locale, '已导入', 'Imported')} {readingImportResult.added} {L(locale, '条', 'readings')}</p>
              {readingImportResult.errors.map((error, index) => (
                <p key={index} style={{ color: '#b42318' }}>{L(locale, '第', 'Row')} {error.row} · {serverText(error.message, locale as Locale)}</p>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
