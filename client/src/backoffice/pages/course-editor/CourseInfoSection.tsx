import { useMemo, useRef, useState } from 'react';

import type { CourseDetail, CourseLocalization } from '../../contracts/course';
import { boRequest } from '../../lib/api';
import { formatBytes, uploadFileWithProgress } from '../../lib/upload';
import { useMediaLimits } from '../../lib/mediaLimits';
import { UploadProgress } from '../../components/UploadProgress';
import { Chip, Field, Modal } from './shared';
import { L, buttonStyle, card, dangerBtn, inputStyle, labelStyle, languageLabel, learningModeLabel, primaryBtn } from './shared-utils';

type Category = { id: string; name: string };

type LearnRow = { en: string; zh: string };
type ProvidesRow = { type: string; key?: string; icon?: number; en: string; zh: string };

// PRD §11.2 / §11.3 建议长度（英 / 中）。不设硬性上限：超出只标黄提示，不阻止保存和发布。
const SUGGESTED_LENGTH = {
  titleEn: 30,
  titleZh: 14,
  shortDescriptionEn: 225,
  shortDescriptionZh: 100,
  overviewEn: 650,
  overviewZh: 380,
  learnEn: 55,
  learnZh: 25,
} as const;

// 提示用黄色，沿用现有 amber Chip 的色值，保证和页面其它"未完成/提示"一致。
const OVER_LIMIT_TEXT = '#9A6B00';
const OVER_LIMIT_BORDER = '#E0A800';
const OVER_LIMIT_BACKGROUND = '#FFFBEB';

function lengthInputStyle(count: number, limit: number): React.CSSProperties {
  return count > limit
    ? { ...inputStyle, borderColor: OVER_LIMIT_BORDER, background: OVER_LIMIT_BACKGROUND }
    : inputStyle;
}

/** 建议长度计数：超出时数字与提示文案标黄（PRD 原文 "Longer than recommended"）。 */
function LengthHint({ locale, count, limit }: { locale: string; count: number; limit: number }) {
  const over = count > limit;
  return (
    <div className="fieldHint">
      <span style={over ? { color: OVER_LIMIT_TEXT } : undefined}>{`${count} / ${limit}`}</span>
      {over && <span style={{ color: OVER_LIMIT_TEXT }}> · {L(locale, '超过建议长度', 'Longer than recommended')}</span>}
    </div>
  );
}

function LengthField({
  locale,
  label,
  count,
  limit,
  children,
}: {
  locale: string;
  label: string;
  count: number;
  limit: number;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label className="fieldLabel">{label}</label>
      {children}
      <LengthHint locale={locale} count={count} limit={limit} />
    </div>
  );
}

const PRESETS = [
  { key: 'VIDEO_TEXT', en: 'Video & text dual-mode learning', zh: '视频与文本双模式学习' },
  { key: 'EXHIBITS', en: 'Multiple reference exhibits', zh: '多个参考展品' },
  { key: 'AI_ASSISTANT', en: 'AI-powered learning assistant', zh: 'AI 学习助手' },
  { key: 'AI_GUIDED', en: 'AI-guided deep comprehension', zh: 'AI 引导深度理解' },
  { key: 'READINGS', en: 'Extended readings for context', zh: '延伸阅读' },
  { key: 'BILINGUAL', en: 'Bilingual: Chinese / English', zh: '中英双语' },
];

function loc(course: CourseDetail, language: string): CourseLocalization | undefined {
  return course.localizations.find((item) => item.language === language);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) =>
          typeof item === 'string'
            ? item
            : ((item as { title?: string; text?: string } | null)?.title ??
              (item as { text?: string } | null)?.text ??
              ''),
        )
        .filter(Boolean)
    : [];
}

function providerList(value: unknown): Array<{ type: string; title: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === 'string') return { type: 'custom', title: item };
    const record = item as { type?: string; title?: string; text?: string };
    return { type: record.type ?? 'custom', title: record.title ?? record.text ?? '' };
  });
}

function presetKeyFor(title: string): string | undefined {
  const normalized = title.trim().toLowerCase();
  return PRESETS.find(
    (preset) =>
      preset.en.toLowerCase() === normalized || preset.zh.toLowerCase() === normalized,
  )?.key;
}

export function CourseInfoSection({
  locale,
  course,
  categories,
  busy,
  setBusy,
  onReload,
  onNotice,
  onNext,
}: {
  locale: string;
  course: CourseDetail;
  categories: Category[];
  busy: boolean;
  setBusy: (value: boolean) => void;
  onReload: () => Promise<void>;
  onNotice: (message: string) => void;
  onNext: () => void;
}) {
  const en = loc(course, 'en-GB') ?? loc(course, 'en');
  const zh = loc(course, 'zh-CN') ?? loc(course, 'zh');
  const [slug, setSlug] = useState(course.slug);
  const [categoryId, setCategoryId] = useState(course.categoryId ?? '');
  const [titleEn, setTitleEn] = useState(en?.title ?? '');
  const [titleZh, setTitleZh] = useState(zh?.title ?? '');
  const [descEn, setDescEn] = useState(en?.shortDescription ?? '');
  const [descZh, setDescZh] = useState(zh?.shortDescription ?? '');
  const [overviewEn, setOverviewEn] = useState(en?.overview ?? '');
  const [overviewZh, setOverviewZh] = useState(zh?.overview ?? '');
  const [learnRows, setLearnRows] = useState<LearnRow[]>([]);
  const [providesRows, setProvidesRows] = useState<ProvidesRow[]>([]);
  const [addMenu, setAddMenu] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customEn, setCustomEn] = useState('');
  const [customZh, setCustomZh] = useState('');
  const [customIcon, setCustomIcon] = useState(0);
  const [languageOpen, setLanguageOpen] = useState(false);
  const [newLanguage, setNewLanguage] = useState('zh-CN');
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverPct, setCoverPct] = useState<number | null>(null);
  const [coverError, setCoverError] = useState('');
  const mediaLimits = useMediaLimits();
  const learnFocus = useRef<HTMLInputElement | null>(null);

  const [previousCourse, setPreviousCourse] = useState<typeof course | null>(null);
  if (previousCourse !== course) {
    setPreviousCourse(course);

    const enLoc = loc(course, 'en-GB') ?? loc(course, 'en');
    const zhLoc = loc(course, 'zh-CN') ?? loc(course, 'zh');
    setSlug(course.slug);
    setCategoryId(course.categoryId ?? '');
    setTitleEn(enLoc?.title ?? '');
    setTitleZh(zhLoc?.title ?? '');
    setDescEn(enLoc?.shortDescription ?? '');
    setDescZh(zhLoc?.shortDescription ?? '');
    setOverviewEn(enLoc?.overview ?? '');
    setOverviewZh(zhLoc?.overview ?? '');
    const enLearn = stringList(enLoc?.whatYouLearn);
    const zhLearn = stringList(zhLoc?.whatYouLearn);
    setLearnRows(
      Array.from({ length: Math.max(enLearn.length, zhLearn.length) }, (_, index) => ({
        en: enLearn[index] ?? '',
        zh: zhLearn[index] ?? '',
      })),
    );
    const enProvides = providerList(enLoc?.provides);
    const zhProvides = providerList(zhLoc?.provides);
    setProvidesRows(
      Array.from({ length: Math.max(enProvides.length, zhProvides.length) }, (_, index) => {
        const enItem = enProvides[index];
        const zhItem = zhProvides[index];
        const key = enItem ? presetKeyFor(enItem.title) : zhItem ? presetKeyFor(zhItem.title) : undefined;
        return {
          type: key ? 'preset' : 'custom',
          key,
          icon: 0,
          en: enItem?.title ?? '',
          zh: zhItem?.title ?? '',
        };
      }),
    );

  }

  const incompleteLearn = learnRows.filter((row) => !row.en.trim() || !row.zh.trim()).length;
  const incompleteProvides = providesRows.filter((row) => !row.en.trim() || !row.zh.trim()).length;
  const canAddProvide = providesRows.length < 6;
  const existingLanguages = useMemo(() => new Set(course.learningLanguages), [course.learningLanguages]);
  const languageOptions = ['en-GB', 'zh-CN'].filter((language) => !existingLanguages.has(language));

  function addLearnRow() {
    setLearnRows((rows) => [...rows, { en: '', zh: '' }]);
    setTimeout(() => learnFocus.current?.focus(), 0);
  }

  function moveLearn(index: number, direction: -1 | 1) {
    setLearnRows((rows) => {
      const next = [...rows];
      const target = index + direction;
      if (target < 0 || target >= next.length) return rows;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function addPreset(key: string) {
    const preset = PRESETS.find((item) => item.key === key);
    if (!preset || providesRows.some((row) => row.key === key) || !canAddProvide) return;
    setProvidesRows((rows) => [...rows, { type: 'preset', key, en: preset.en, zh: preset.zh }]);
    setAddMenu(false);
  }

  function addCustom() {
    if (!customEn.trim() || !customZh.trim() || !canAddProvide) return;
    setProvidesRows((rows) => [
      ...rows,
      { type: 'custom', icon: customIcon, en: customEn.trim(), zh: customZh.trim() },
    ]);
    setCustomOpen(false);
    setAddMenu(false);
    setCustomEn('');
    setCustomZh('');
    setCustomIcon(0);
  }

  function moveProvide(index: number, direction: -1 | 1) {
    setProvidesRows((rows) => {
      const next = [...rows];
      const target = index + direction;
      if (target < 0 || target >= next.length) return rows;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function readCover(file: File): Promise<{ ok: boolean; message?: string }> {
    const invalidMessage = L(locale, '请使用 400 × 185 px 或同比例更大的 JPG 或 PNG。', 'Use a JPG or PNG at 400 × 185 px or larger, same ratio');
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      return { ok: false, message: invalidMessage };
    }
    const bitmap = await createImageBitmap(file);
    const ratio = 400 / 185;
    const close = Math.abs(bitmap.width / bitmap.height - ratio) < 0.03;
    if (bitmap.width < 400 || bitmap.height < 185 || !close) {
      return { ok: false, message: invalidMessage };
    }
    return { ok: true };
  }

  async function uploadCover(file: File) {
    if (mediaLimits && file.size > mediaLimits.imageBytes) {
      setCoverError(
        L(
          locale,
          `封面超过单文件上限 ${formatBytes(mediaLimits.imageBytes)}（当前 ${formatBytes(file.size)}）。`,
          `Cover exceeds the ${formatBytes(mediaLimits.imageBytes)} per-file limit (this file is ${formatBytes(file.size)}).`,
        ),
      );
      return;
    }
    const valid = await readCover(file);
    if (!valid.ok) {
      setCoverError(valid.message ?? L(locale, '请使用 400 × 185 px 或同比例更大的 JPG 或 PNG。', 'Use a JPG or PNG at 400 × 185 px or larger, same ratio'));
      return;
    }
    setCoverBusy(true);
    setCoverError('');
    setCoverPct(0);
    const result = await uploadFileWithProgress(`/api/backoffice/courses/${course.id}/cover`, file, setCoverPct);
    setCoverPct(null);
    setCoverBusy(false);
    if (result.success) {
      onNotice(L(locale, '封面已上传。', 'Cover uploaded.'));
      await onReload();
    } else {
      setCoverError(result.errorMessage ?? L(locale, '封面上传失败。', 'Cover upload failed.'));
    }
  }

  async function removeCover() {
    if (!window.confirm(L(locale, '移除当前封面？', 'Remove the current cover?'))) return;
    setCoverBusy(true);
    const result = await boRequest(`/api/backoffice/courses/${course.id}/cover`, { method: 'DELETE' });
    setCoverBusy(false);
    if (result.success) {
      onNotice(L(locale, '封面已移除。', 'Cover removed.'));
      await onReload();
    } else {
      setCoverError(result.message ?? L(locale, '移除封面失败。', 'Could not remove the cover.'));
    }
  }

  async function save(next: boolean) {
    setBusy(true);
    const core = await boRequest(`/api/backoffice/courses/${course.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: slug.trim() || undefined,
        categoryId: categoryId || null,
      }),
    });
    const learnEn = learnRows.map((row) => row.en.trim()).filter(Boolean);
    const learnZh = learnRows.map((row) => row.zh.trim()).filter(Boolean);
    const provideEn = providesRows.map((row) => ({
      type: row.type,
      key: row.key,
      icon: row.icon,
      title: row.en.trim(),
    }));
    const provideZh = providesRows.map((row) => ({
      type: row.type,
      key: row.key,
      icon: row.icon,
      title: row.zh.trim(),
    }));
    const existingLanguages = new Set(course.localizations.map((item) => item.language));
    // 课程只教一种语言时，另一种语言的标题往往为空。若照旧无条件 PUT，
    // 会新建一条 title 为空的本地化记录，列表接口取到它时课程名就会变空。
    const saveLoc = (language: string, title: string, description: string, overview: string, learn: string[], provides: unknown[]) => {
      if (!title && !existingLanguages.has(language)) {
        return Promise.resolve({ success: true as const });
      }
      return boRequest(`/api/backoffice/courses/${course.id}/localizations/${encodeURIComponent(language)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          shortDescription: description.trim() || null,
          overview: overview.trim() || null,
          whatYouLearn: learn,
          provides,
        }),
      });
    };
    const [enResult, zhResult] = await Promise.all([
      saveLoc('en-GB', titleEn.trim(), descEn, overviewEn, learnEn, provideEn),
      saveLoc('zh-CN', titleZh.trim(), descZh, overviewZh, learnZh, provideZh),
    ]);
    setBusy(false);
    if (core.success && enResult.success && zhResult.success) {
      onNotice(L(locale, '课程信息已保存。', 'Course information saved.'));
      await onReload();
      if (next) onNext();
    } else {
      const failure = !core.success ? core : !enResult.success ? enResult : zhResult;
      onNotice(`${L(locale, '保存失败', 'Save failed')}: ${(failure as { message?: string; error?: string }).message ?? (failure as { error?: string }).error}`);
    }
  }

  async function addLanguage() {
    if (!newLanguage) return;
    setBusy(true);
    const nextLanguages = [...course.learningLanguages, newLanguage];
    const updated = await boRequest(`/api/backoffice/courses/${course.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ learningLanguages: nextLanguages }),
    });
    if (updated.success) {
      // 只登记学习语言，不预建空标题的本地化记录：空标题会让课程列表取到
      // 空白课程名，等用户在「课程信息」里填好该语言的标题后再自动创建。
      setLanguageOpen(false);
      onNotice(L(locale, `已添加学习语言 ${newLanguage}。`, `Learning language ${newLanguage} added.`));
      await onReload();
    } else {
      onNotice(`${L(locale, '添加语言失败', 'Add language failed')}: ${updated.message ?? updated.error}`);
    }
    setBusy(false);
  }

  return (
    <div>
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, '基础信息', 'Basics')}</h2>
            <p style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.65 }}>
              {L(locale, '课程信息是学生端课程卡片和详情页的唯一数据源。所有中英文字段均为必填。', 'Course Information is the single source for learner cards and the course page. All EN and ZH fields are required.')}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Chip tone={incompleteLearn || incompleteProvides || !titleEn.trim() || !titleZh.trim() ? 'amber' : 'green'}>
              {incompleteLearn || incompleteProvides || !titleEn.trim() || !titleZh.trim() ? L(locale, '未完成', 'Incomplete') : L(locale, '已完成', 'Complete')}
            </Chip>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 18, marginTop: 16 }}>
          <Field label={L(locale, '分类 *', 'Category *')}>
            <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} style={inputStyle}>
              <option value="">{L(locale, '未分类', 'Uncategorized')}</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </select>
          </Field>
          <Field
            label={L(locale, '课程封面 *', 'Course cover *')}
            hint={
              mediaLimits
                ? L(locale, `400 × 185 px 或同比例更大尺寸，JPG 或 PNG，单文件最大 ${formatBytes(mediaLimits.imageBytes)}。`, `400 × 185 px or larger, same ratio. JPG or PNG, up to ${formatBytes(mediaLimits.imageBytes)}.`)
                : L(locale, '400 × 185 px 或同比例更大尺寸，JPG 或 PNG。', '400 × 185 px or larger, same ratio. JPG or PNG.')
            }
          >
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              {course.cover ? (
                <img src={`/api/backoffice/courses/${course.id}/cover`} alt="" style={{ width: 120, height: 56, objectFit: 'cover', borderRadius: 8, border: '1px solid #E8EDF5' }} />
              ) : (
                <div style={{ width: 120, height: 56, borderRadius: 8, background: '#F3F5F9', display: 'grid', placeItems: 'center', fontSize: 12, color: '#5A6577' }}>
                  {L(locale, '未上传', 'No image')}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <label style={{ ...buttonStyle, display: 'inline-flex', alignItems: 'center', cursor: coverBusy ? 'not-allowed' : 'pointer' }}>
                  {course.cover ? L(locale, '替换图片', 'Replace image') : L(locale, '上传封面', 'Upload cover')}
                  <input
                    type="file"
                    accept="image/png,image/jpeg"
                    disabled={coverBusy}
                    style={{ display: 'none' }}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void uploadCover(file);
                      event.currentTarget.value = '';
                    }}
                  />
                </label>
                {course.cover && <button type="button" style={dangerBtn} disabled={coverBusy} onClick={() => void removeCover()}>{L(locale, '移除', 'Remove')}</button>}
              </div>
            </div>
            {coverBusy && (
              <UploadProgress
                tone="active"
                title={L(locale, '正在上传封面…', 'Uploading cover…')}
                pct={coverPct ?? 0}
              />
            )}
            {coverError && <div style={{ fontSize: 12, color: '#b42318', marginTop: 6 }}>{coverError}</div>}
          </Field>
        </div>

        <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: '#F7F9FC', display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
          <span><strong>{L(locale, '学习模式', 'Learning mode')}:</strong> {learningModeLabel(locale, course.learningMode)}</span>
          <span><strong>{L(locale, '学习语言', 'Learning languages')}:</strong> {course.learningLanguages.map((language) => languageLabel(locale, language)).join(', ')}</span>
          <span style={{ opacity: 0.65 }}>{L(locale, '— 创建后锁定', '— locked at creation')}</span>
          {languageOptions.length > 0 && (
            <button type="button" style={buttonStyle} onClick={() => { setNewLanguage(languageOptions[0]); setLanguageOpen(true); }}>
              + {L(locale, '添加学习语言', 'Add learning language')}
            </button>
          )}
        </div>

        <Field label={L(locale, '短名', 'Slug')}>
          <input value={slug} onChange={(event) => setSlug(event.target.value)} style={inputStyle} />
        </Field>
      </div>

      <div style={card}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, '标题与简介', 'Title and descriptions')}</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginTop: 12 }}>
          <div>
            <label style={labelStyle}>{L(locale, '英文', 'English')}</label>
            <LengthField locale={locale} label={L(locale, '课程名称 *', 'Course title *')} count={titleEn.length} limit={SUGGESTED_LENGTH.titleEn}>
              <input value={titleEn} onChange={(event) => setTitleEn(event.target.value)} style={lengthInputStyle(titleEn.length, SUGGESTED_LENGTH.titleEn)} />
            </LengthField>
            <LengthField locale={locale} label={L(locale, '简述 *', 'Short description *')} count={descEn.length} limit={SUGGESTED_LENGTH.shortDescriptionEn}>
              <textarea rows={4} value={descEn} onChange={(event) => setDescEn(event.target.value)} style={lengthInputStyle(descEn.length, SUGGESTED_LENGTH.shortDescriptionEn)} />
            </LengthField>
            <LengthField locale={locale} label={L(locale, '课程概览 *', 'Overview *')} count={overviewEn.length} limit={SUGGESTED_LENGTH.overviewEn}>
              <textarea rows={7} value={overviewEn} onChange={(event) => setOverviewEn(event.target.value)} style={lengthInputStyle(overviewEn.length, SUGGESTED_LENGTH.overviewEn)} />
            </LengthField>
          </div>
          <div>
            <label style={labelStyle}>{L(locale, '中文', 'Chinese')}</label>
            <LengthField locale={locale} label={L(locale, '课程名称 *', 'Course title *')} count={titleZh.length} limit={SUGGESTED_LENGTH.titleZh}>
              <input value={titleZh} onChange={(event) => setTitleZh(event.target.value)} style={lengthInputStyle(titleZh.length, SUGGESTED_LENGTH.titleZh)} />
            </LengthField>
            <LengthField locale={locale} label={L(locale, '简述 *', 'Short description *')} count={descZh.length} limit={SUGGESTED_LENGTH.shortDescriptionZh}>
              <textarea rows={4} value={descZh} onChange={(event) => setDescZh(event.target.value)} style={lengthInputStyle(descZh.length, SUGGESTED_LENGTH.shortDescriptionZh)} />
            </LengthField>
            <LengthField locale={locale} label={L(locale, '课程概览 *', 'Overview *')} count={overviewZh.length} limit={SUGGESTED_LENGTH.overviewZh}>
              <textarea rows={7} value={overviewZh} onChange={(event) => setOverviewZh(event.target.value)} style={lengthInputStyle(overviewZh.length, SUGGESTED_LENGTH.overviewZh)} />
            </LengthField>
          </div>
        </div>
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, '你将学到什么', "What you'll learn")}</h2>
            <p style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.65 }}>{L(locale, '推荐 6 条 · 至少 4 条 · 可排序', '6 recommended · minimum 4 · drag to reorder')}</p>
          </div>
          <Chip tone={learnRows.length < 4 || incompleteLearn ? 'amber' : 'green'}>
            {learnRows.length} {L(locale, '条', 'items')} · {learnRows.length < 4 ? L(locale, '至少 4 条', 'minimum 4') : learnRows.length < 6 ? L(locale, '推荐 6 条', '6 recommended') : L(locale, '已足够', 'ready')}
          </Chip>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '46px 1fr 1fr 92px', gap: 8, marginTop: 12, fontSize: 12, fontWeight: 600, color: '#5A6577' }}>
          <span>#</span><span>{L(locale, '英文', 'English')}</span><span>{L(locale, '中文', 'Chinese')}</span><span />
        </div>
        {learnRows.map((row, index) => (
          <div key={index} style={{ display: 'grid', gridTemplateColumns: '46px 1fr 1fr 92px', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <span style={{ fontSize: 13 }}>{index + 1}</span>
            <div>
              <input ref={index === learnRows.length - 1 ? learnFocus : undefined} value={row.en} onChange={(event) => setLearnRows((rows) => rows.map((item, i) => i === index ? { ...item, en: event.target.value } : item))} style={lengthInputStyle(row.en.length, SUGGESTED_LENGTH.learnEn)} />
              <LengthHint locale={locale} count={row.en.length} limit={SUGGESTED_LENGTH.learnEn} />
            </div>
            <div>
              <input value={row.zh} onChange={(event) => setLearnRows((rows) => rows.map((item, i) => i === index ? { ...item, zh: event.target.value } : item))} style={lengthInputStyle(row.zh.length, SUGGESTED_LENGTH.learnZh)} />
              <LengthHint locale={locale} count={row.zh.length} limit={SUGGESTED_LENGTH.learnZh} />
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button type="button" style={{ ...buttonStyle, padding: '6px 8px' }} onClick={() => moveLearn(index, -1)}>↑</button>
              <button type="button" style={{ ...buttonStyle, padding: '6px 8px' }} onClick={() => moveLearn(index, 1)}>↓</button>
              <button type="button" style={{ ...dangerBtn, padding: '6px 8px' }} onClick={() => setLearnRows((rows) => rows.filter((_, i) => i !== index))}>×</button>
            </div>
          </div>
        ))}
        <button type="button" style={{ ...buttonStyle, marginTop: 12 }} onClick={addLearnRow}>+ {L(locale, '添加一项', 'Add item')}</button>
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, '本课程提供', 'This course provides')}</h2>
            <p style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.65 }}>{L(locale, '最多 6 条 · 6 条推荐 · 可排序', 'Up to 6 · 6 recommended · drag to reorder')}</p>
          </div>
          <Chip tone={providesRows.length < 4 || incompleteProvides ? 'amber' : 'green'}>
            {providesRows.length} / 6 · {providesRows.length < 4 ? L(locale, '至少 4 条', 'minimum 4') : providesRows.length < 6 ? L(locale, '推荐 6 条', '6 recommended') : '6 / 6'}
          </Chip>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '46px 1fr 1fr 92px', gap: 8, marginTop: 12, fontSize: 12, fontWeight: 600, color: '#5A6577' }}>
          <span>#</span><span>{L(locale, '英文', 'English')}</span><span>{L(locale, '中文', 'Chinese')}</span><span />
        </div>
        {providesRows.map((row, index) => {
          const preset = row.key ? PRESETS.find((item) => item.key === row.key) : undefined;
          return (
            <div key={`${row.key ?? 'custom'}-${index}`} style={{ display: 'grid', gridTemplateColumns: '46px 1fr 1fr 92px', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <span style={{ fontSize: 13 }}>{index + 1}</span>
              <div>
                <input value={row.en} readOnly={row.type === 'preset'} onChange={(event) => setProvidesRows((rows) => rows.map((item, i) => i === index ? { ...item, en: event.target.value } : item))} style={{ ...inputStyle, background: row.type === 'preset' ? '#F5F7FA' : '#fff' }} />
                {preset && <div style={{ fontSize: 11, color: '#5A6577', marginTop: 2 }}>{L(locale, '预设', 'Preset')}</div>}
              </div>
              <input value={row.zh} readOnly={row.type === 'preset'} onChange={(event) => setProvidesRows((rows) => rows.map((item, i) => i === index ? { ...item, zh: event.target.value } : item))} style={{ ...inputStyle, background: row.type === 'preset' ? '#F5F7FA' : '#fff' }} />
              <div style={{ display: 'flex', gap: 4 }}>
                <button type="button" style={{ ...buttonStyle, padding: '6px 8px' }} onClick={() => moveProvide(index, -1)}>↑</button>
                <button type="button" style={{ ...buttonStyle, padding: '6px 8px' }} onClick={() => moveProvide(index, 1)}>↓</button>
                <button type="button" style={{ ...dangerBtn, padding: '6px 8px' }} onClick={() => setProvidesRows((rows) => rows.filter((_, i) => i !== index))}>×</button>
              </div>
            </div>
          );
        })}
        <div style={{ position: 'relative', marginTop: 12 }}>
          <button type="button" style={buttonStyle} disabled={!canAddProvide} onClick={() => setAddMenu((value) => !value)}>
            + {canAddProvide ? L(locale, '添加一项', 'Add item') : L(locale, '已满 6 项', 'Full · 6 / 6')}
          </button>
          {addMenu && canAddProvide && (
            <div style={{ position: 'absolute', zIndex: 5, marginTop: 6, width: 330, background: '#fff', border: '1px solid #E8EDF5', borderRadius: 10, boxShadow: '0 8px 20px rgba(15,23,42,0.1)', padding: 8 }}>
              {PRESETS.map((preset) => {
                const added = providesRows.some((row) => row.key === preset.key);
                return (
                  <button key={preset.key} type="button" disabled={added} onClick={() => addPreset(preset.key)} style={{ display: 'flex', justifyContent: 'space-between', width: '100%', border: 0, background: 'none', padding: '8px 10px', textAlign: 'left', cursor: added ? 'not-allowed' : 'pointer', opacity: added ? 0.45 : 1, borderRadius: 6 }}>
                    <span>{preset.en}<div style={{ fontSize: 11, opacity: 0.65 }}>{preset.zh}</div></span>
                    <span style={{ fontSize: 11 }}>{added ? L(locale, '已添加', 'Added') : ''}</span>
                  </button>
                );
              })}
              <button type="button" onClick={() => { setCustomOpen(true); setAddMenu(false); }} style={{ width: '100%', border: 0, borderTop: '1px solid #EEF1F6', background: 'none', padding: '9px 10px', textAlign: 'left', cursor: 'pointer', color: '#2B58C8', fontWeight: 600 }}>
                + {L(locale, '自定义项', 'Custom item')}
              </button>
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
        <button type="button" style={primaryBtn} disabled={busy} onClick={() => void save(false)}>{L(locale, '保存', 'Save')}</button>
        <button type="button" style={buttonStyle} disabled={busy} onClick={() => void save(true)}>{L(locale, '保存并下一步', 'Save & next')}</button>
      </div>

      {customOpen && (
        <Modal title={L(locale, '自定义项', 'Custom item')} onClose={() => setCustomOpen(false)}>
          <Field label={L(locale, '图标', 'Icon')}>
            <div style={{ display: 'flex', gap: 8 }}>
              {[0, 1].map((icon) => (
                <button key={icon} type="button" onClick={() => setCustomIcon(icon)} style={{ ...buttonStyle, borderColor: customIcon === icon ? '#2B58C8' : '#d9e0ea', color: customIcon === icon ? '#2B58C8' : '#25314C' }}>
                  {L(locale, `通用图标 ${icon + 1}`, `Icon ${icon + 1}`)}
                </button>
              ))}
            </div>
          </Field>
          <Field label={L(locale, '英文 *', 'English *')}><input value={customEn} onChange={(event) => setCustomEn(event.target.value)} style={inputStyle} /></Field>
          <Field label={L(locale, '中文 *', 'Chinese *')}><input value={customZh} onChange={(event) => setCustomZh(event.target.value)} style={inputStyle} /></Field>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button type="button" style={primaryBtn} disabled={!customEn.trim() || !customZh.trim()} onClick={addCustom}>{L(locale, '添加', 'Add')}</button>
            <button type="button" style={buttonStyle} onClick={() => setCustomOpen(false)}>{L(locale, '取消', 'Cancel')}</button>
          </div>
        </Modal>
      )}

      {languageOpen && (
        <Modal title={L(locale, '添加学习语言', 'Add learning language')} onClose={() => setLanguageOpen(false)}>
          <p style={{ fontSize: 13, color: '#5A6577' }}>
            {L(locale, '添加后不能删除。所有课时需要补齐该语言的全套学习材料。', 'A language cannot be removed after it is added. Every lesson must then be completed in that language.')}
          </p>
          <Field label={L(locale, '要添加的语言', 'Language to add')}>
            <select value={newLanguage} onChange={(event) => setNewLanguage(event.target.value)} style={inputStyle}>
              {languageOptions.map((language) => <option key={language} value={language}>{languageLabel(locale, language)}</option>)}
            </select>
          </Field>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button type="button" style={primaryBtn} disabled={busy} onClick={() => void addLanguage()}>{L(locale, '添加', 'Add')}</button>
            <button type="button" style={buttonStyle} onClick={() => setLanguageOpen(false)}>{L(locale, '取消', 'Cancel')}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
