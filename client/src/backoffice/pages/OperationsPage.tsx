import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import type {
  BannerLocalizedEntry,
  CourseList,
  CourseSummary,
  DiscoveryBanner,
  PopularCourseItem,
  PopularCourses,
} from '../contracts/course';
import { boRequest } from '../lib/api';
import { localizedName } from '../lib/i18n/localized';
import { useResizableColumns } from '../components/resizableColumns';
import { liveStatusLabel } from './course-editor/shared-utils';
import { formatDateTime } from '../lib/i18n/format';

const L = (locale: string, zh: string, en: string) => (locale.startsWith('zh') ? zh : en);

const inputStyle: React.CSSProperties = { width: '100%', padding: 10, border: '1px solid #d9e0ea', borderRadius: 8, boxSizing: 'border-box', fontSize: 14 };
const labelStyle: React.CSSProperties = { display: 'block', fontWeight: 600, margin: '12px 0 6px', color: '#25314C', fontSize: 13 };
const buttonStyle: React.CSSProperties = { padding: '8px 14px', border: '1px solid #d9e0ea', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 };
const primaryBtn: React.CSSProperties = { ...buttonStyle, background: '#2B58C8', color: '#fff', border: '1px solid #2B58C8' };
const card: React.CSSProperties = { border: '1px solid #E8EDF5', borderRadius: 14, padding: 20, background: '#fff', marginTop: 18 };

/**
 * Operations（PRD §19）：Popular Courses + Discovery Banner。
 * 修改后 Publish 立即在本环境网站生效，不生成课程版本。
 */
export function OperationsPage() {
  const { locale = 'en-GB' } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'popular' | 'banner'>('popular');
  const [popular, setPopular] = useState<PopularCourses | null>(null);
  const [banner, setBanner] = useState<DiscoveryBanner | null>(null);
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [addCourseId, setAddCourseId] = useState('');
  const [bannerLanguage, setBannerLanguage] = useState<'en-GB' | 'zh-CN'>('en-GB');
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState('');
  const popularTable = useResizableColumns({
    storageKey: 'operations-popular-courses',
    defaultWidths: [50, 320, 150, 120, 240],
  });

  const fetchLoad = useCallback(() => {
    return Promise.all([
      boRequest<PopularCourses>('/api/backoffice/operations/popular-courses'),
      boRequest<DiscoveryBanner>('/api/backoffice/operations/discovery-banner'),
      boRequest<CourseList>('/api/backoffice/courses?page=1&pageSize=100'),
    ]).then(([popularResult, bannerResult, coursesResult]) => {
      setBusy(false);
      if (popularResult.success) setPopular(popularResult.data);
      if (bannerResult.success) setBanner(bannerResult.data);
      if (coursesResult.success) setCourses(coursesResult.data.courses);
    });
  }, []);

  const load = useCallback(() => {
    setBusy(true);
    return fetchLoad();
  }, [fetchLoad]);

  useEffect(() => {
    void fetchLoad();
  }, [fetchLoad]);

  const onlineCourses = useMemo(() => courses.filter((course) => course.liveStatus === 'ONLINE'), [courses]);
  const unusedCourses = useMemo(
    () => onlineCourses.filter((course) => !(popular?.items ?? []).some((item) => item.courseId === course.id)),
    [onlineCourses, popular],
  );

  function setItems(items: PopularCourseItem[]) {
    setPopular((current) => current ? { ...current, items: items.map((item, index) => ({ ...item, sortOrder: index })) } : current);
  }

  function addCourse() {
    const course = unusedCourses.find((item) => item.id === addCourseId);
    if (!course || !popular) return;
    setItems([
      ...popular.items,
      {
        courseId: course.id,
        sortOrder: popular.items.length,
        code: course.code,
        title: course.title,
        category: course.category ?? null,
        liveStatus: course.liveStatus,
        trialEnabled: course.trialEnabled,
        coverUrl: `/api/backoffice/courses/${course.id}/cover`,
        invalid: false,
      },
    ]);
    setAddCourseId('');
  }

  function move(index: number, direction: -1 | 1) {
    if (!popular) return;
    const next = [...popular.items];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setItems(next);
  }

  async function savePopular() {
    if (!popular) return;
    setBusy(true);
    const result = await boRequest<PopularCourses>('/api/backoffice/operations/popular-courses', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: popular.items.map((item, index) => ({ courseId: item.courseId, sortOrder: index })) }),
    });
    setBusy(false);
    if (result.success) {
      setPopular(result.data);
      setNotice(L(locale, '热门课程已保存，发布后立即生效。', 'Popular Courses saved. Publish to make it live.'));
    } else {
      setNotice(`Save failed: ${result.error}`);
    }
  }

  async function publish(section: 'popular' | 'banner') {
    setBusy(true);
    const result = await boRequest('/api/backoffice/operations/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ section }),
    });
    setBusy(false);
    if (result.success) {
      setNotice(L(locale, '已发布，立即在本环境网站生效（不生成课程版本）。', 'Published. Effective immediately in this environment (no course version created).'));
      await load();
    } else {
      setNotice(`Publish failed: ${result.error}`);
    }
  }

  async function saveBanner() {
    if (!banner) return;
    setBusy(true);
    const result = await boRequest<DiscoveryBanner>('/api/backoffice/operations/discovery-banner', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: banner.enabled, courseId: banner.courseId, localized: banner.localized }),
    });
    setBusy(false);
    if (result.success) {
      setBanner(result.data);
      setNotice(L(locale, '横幅已保存，发布后立即生效。', 'Banner saved. Publish to make it live.'));
    } else {
      setNotice(`Save failed: ${result.error}`);
    }
  }

  function updateLocalized(field: keyof BannerLocalizedEntry, value: string) {
    setBanner((current) => {
      if (!current) return current;
      const localized = { ...(current.localized ?? {}) };
      localized[bannerLanguage] = { ...(localized[bannerLanguage] ?? {}), [field]: value };
      return { ...current, localized };
    });
  }

  const localizedEntry = banner?.localized?.[bannerLanguage] ?? {};
  const featureCourse = courses.find((course) => course.id === banner?.courseId);

  return (
    <section className="card cardGrow" style={{ overflow: 'auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <button type="button" style={buttonStyle} onClick={() => navigate(`/${locale}/course`)}>← {L(locale, '课程列表', 'Course Overview')}</button>
          <h1 style={{ margin: '10px 0 0', fontSize: 24 }}>{L(locale, '运营位', 'Operations')}</h1>
          <p style={{ margin: '6px 0 0', opacity: 0.7, fontSize: 13 }}>
            {L(locale, '运营位不设草稿；发布后立即生效，不生成课程版本。两套环境各自配置。', 'Operations has no draft; Publish takes effect immediately and creates no course version. Each environment is configured separately.')}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" style={{ ...buttonStyle, fontWeight: 600, borderColor: tab === 'popular' ? '#2B58C8' : '#d9e0ea', color: tab === 'popular' ? '#2B58C8' : '#25314C' }} onClick={() => setTab('popular')}>{L(locale, '热门课程', 'Popular Courses')}</button>
          <button type="button" style={{ ...buttonStyle, fontWeight: 600, borderColor: tab === 'banner' ? '#2B58C8' : '#d9e0ea', color: tab === 'banner' ? '#2B58C8' : '#25314C' }} onClick={() => setTab('banner')}>{L(locale, '发现横幅', 'Discovery Banner')}</button>
        </div>
      </header>

      {notice && <p role="status" style={{ padding: 10, background: /fail|error|invalid/i.test(notice) ? '#FDECEC' : '#F3F7FF', borderRadius: 8, marginTop: 14 }}>{notice}</p>}

      {tab === 'popular' && popular && (
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, '热门课程（1–6 门）', 'Popular Courses (1–6)')}</h2>
              <p style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.65 }}>
                {L(locale, '只列出已上线课程；卡片内容读取课程信息。课程失效后保留并标红，发布前需替换。', 'Only Online courses can be added. Card content comes from Course Information. Offline courses stay marked red until replaced.')}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select value={addCourseId} onChange={(event) => setAddCourseId(event.target.value)} style={{ padding: 8, borderRadius: 8, minWidth: 220 }}>
                <option value="">{L(locale, '选择已上线课程', 'Select an Online course')}</option>
                {unusedCourses.map((course) => <option key={course.id} value={course.id}>{course.code} · {course.title}</option>)}
              </select>
              <button type="button" style={buttonStyle} disabled={!addCourseId || popular.items.length >= 6 || busy} onClick={addCourse}>{L(locale, '+ 添加', '+ Add course')}</button>
              <button type="button" style={primaryBtn} disabled={busy} onClick={() => void savePopular()}>{L(locale, '保存', 'Save')}</button>
              <button type="button" style={primaryBtn} disabled={busy} onClick={() => void publish('popular')}>{L(locale, '发布', 'Publish')}</button>
            </div>
          </div>
          <div className="tableScroll" style={{ marginTop: 14 }}>
            <table className="table" style={popularTable.tableStyle}>
              {popularTable.colGroup}
              <thead><tr><th>#{popularTable.resizeHandle(0)}</th><th>{L(locale, '课程', 'Course')}{popularTable.resizeHandle(1)}</th><th>{L(locale, '分类', 'Category')}{popularTable.resizeHandle(2)}</th><th>{L(locale, '状态', 'Status')}{popularTable.resizeHandle(3)}</th><th>{popularTable.resizeHandle(4)}</th></tr></thead>
            <tbody>
              {popular.items.map((item, index) => (
                <tr key={item.courseId} style={item.invalid ? { background: '#FFF7F7' } : undefined}>
                  <td>{index + 1}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      {item.coverUrl ? <img src={item.coverUrl} alt="" style={{ width: 56, height: 38, objectFit: 'cover', borderRadius: 6, border: '1px solid #E8EDF5' }} /> : <div style={{ width: 56, height: 38, borderRadius: 6, background: '#EEF1F6' }} />}
                      <div>
                        <strong>{item.title}</strong>
                        <div style={{ fontSize: 12, opacity: 0.7 }}>{item.code}</div>
                      </div>
                    </div>
                  </td>
                  <td>{item.category ? localizedName(locale, item.category) : '—'}</td>
                  <td style={{ color: item.invalid ? '#b42318' : '#1E7A3C', fontWeight: 600 }}>
                    {liveStatusLabel(locale, item.liveStatus)}{item.invalid ? ` · ${L(locale, '需替换', 'replace')}` : ''}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button type="button" style={buttonStyle} disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
                      <button type="button" style={buttonStyle} disabled={index === popular.items.length - 1} onClick={() => move(index, 1)}>↓</button>
                      <button type="button" style={{ ...buttonStyle, color: '#b42318' }} onClick={() => setItems(popular.items.filter((entry) => entry.courseId !== item.courseId))}>{L(locale, '移除', 'Remove')}</button>
                    </div>
                  </td>
                </tr>
              ))}
              {popular.items.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', padding: 20, opacity: 0.7 }}>{L(locale, '尚未配置。', 'Nothing configured yet.')}</td></tr>}
            </tbody>
            </table>
          </div>
          <p style={{ fontSize: 12, opacity: 0.65, marginTop: 12 }}>
            {L(locale, '最近发布', 'Last published')}: {formatDateTime(locale, popular.publishedAt)}
          </p>
        </div>
      )}

      {tab === 'banner' && banner && (
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, '发现横幅', 'Discovery Banner')}</h2>
              <p style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.65 }}>
                {L(locale, '单例、不轮播；推荐课程必须已上线且已开启试看；中英文文案均必填。', 'Single instance, no carousel; the featured course must be Online with Trial enabled; EN and ZH copy are required.')}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ fontSize: 14 }}><input type="checkbox" checked={banner.enabled} onChange={(event) => setBanner({ ...banner, enabled: event.target.checked })} /> {L(locale, '显示横幅', 'Show banner')}</label>
              <button type="button" style={buttonStyle} disabled={busy} onClick={() => void saveBanner()}>{L(locale, '保存', 'Save')}</button>
              <button type="button" style={primaryBtn} disabled={busy} onClick={() => void publish('banner')}>{L(locale, '发布', 'Publish')}</button>
            </div>
          </div>
          {banner.invalid && (
            <p style={{ color: '#b42318', background: '#FDECEC', padding: '8px 12px', borderRadius: 8, fontSize: 13 }}>
              {L(locale, '当前横幅已停止展示：课程未上线或试看已关闭。请更换课程并重新发布。', 'The banner is currently hidden: the course is not Online or Trial is disabled. Replace the course and publish again.')}
            </p>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <label style={labelStyle}>{L(locale, '推荐课程（已上线且开启试看）', 'Featured course (Online + Trial)')}
                <select
                  value={banner.courseId ?? ''}
                  onChange={(event) => setBanner({ ...banner, courseId: event.target.value || null })}
                  style={inputStyle}
                >
                  <option value="">—</option>
                  {onlineCourses.filter((course) => course.trialEnabled).map((course) => <option key={course.id} value={course.id}>{course.code} · {course.title}</option>)}
                </select>
              </label>
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <button type="button" style={{ ...buttonStyle, fontWeight: bannerLanguage === 'en-GB' ? 700 : 400 }} onClick={() => setBannerLanguage('en-GB')}>EN</button>
                <button type="button" style={{ ...buttonStyle, fontWeight: bannerLanguage === 'zh-CN' ? 700 : 400 }} onClick={() => setBannerLanguage('zh-CN')}>{L(locale, '中文', 'Chinese')}</button>
              </div>
              <label style={labelStyle}>{L(locale, '主标题', 'Headline')}<input value={localizedEntry.headline ?? ''} onChange={(event) => updateLocalized('headline', event.target.value)} style={inputStyle} /></label>
              <label style={labelStyle}>{L(locale, '副标题', 'Subheading')}<input value={localizedEntry.subheading ?? ''} onChange={(event) => updateLocalized('subheading', event.target.value)} style={inputStyle} /></label>
              <label style={labelStyle}>{L(locale, '按钮文案', 'Button label')}<input value={localizedEntry.buttonLabel ?? ''} onChange={(event) => updateLocalized('buttonLabel', event.target.value)} style={inputStyle} /></label>
            </div>
            <div>
              <h3 style={{ marginTop: 0, fontSize: 15 }}>{L(locale, '横幅预览', 'Banner preview')}</h3>
              <div
                style={{
                  borderRadius: 16,
                  padding: 24,
                  color: '#fff',
                  minHeight: 220,
                  background: 'linear-gradient(135deg, #1D2B50, #2B58C8)',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'flex-end',
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 26, fontWeight: 700 }}>{localizedEntry.headline || L(locale, '主标题', 'Headline')}</div>
                <div style={{ fontSize: 15, opacity: 0.9 }}>{localizedEntry.subheading || L(locale, '副标题', 'Subheading')}</div>
                <div style={{ alignSelf: 'flex-start', marginTop: 6, padding: '8px 16px', borderRadius: 999, background: '#fff', color: '#1D2B50', fontWeight: 700, fontSize: 13 }}>
                  {localizedEntry.buttonLabel || L(locale, '开始试看', 'Start trial')}
                </div>
                {featureCourse && <div style={{ fontSize: 12, opacity: 0.8 }}>{featureCourse.code} · {featureCourse.title}</div>}
              </div>
            </div>
          </div>
          <p style={{ fontSize: 12, opacity: 0.65, marginTop: 12 }}>
            {L(locale, '最近发布', 'Last published')}: {formatDateTime(locale, banner.publishedAt)}
          </p>
        </div>
      )}
    </section>
  );
}
