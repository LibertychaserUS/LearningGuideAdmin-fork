import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';

import type { PortalPreviewLink, PreviewCourse } from '../contracts/course';
import { providerItems, strings } from '../contracts/course';
import { boRequest } from '../lib/api';
import { localizedName } from '../lib/i18n/localized';
import { languageLabel, learningModeLabel, localizeMissing } from './course-editor/shared-utils';

const L = (locale: string, zh: string, en: string) => (locale.startsWith('zh') ? zh : en);

function fmtTotal(seconds: number, locale: string): string {
  if (!seconds) return '';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (locale.startsWith('zh')) return hours > 0 ? `${hours}小时${minutes}分钟` : `${minutes}分钟`;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function fmtMMSS(seconds: number | null): string {
  if (!seconds) return '';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
}

function price(value: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(value / 100);
}

/**
 * 学员视角预览（PRD §10/§15）：字段与 Portal 课程详情一致。
 * 只显示前台会显示的内容：未完成 Study 的 Lesson 不显示，未完成 Understanding 的测试不显示。
 */
export function CoursePreviewPage() {
  const { courseId = '', locale = 'en-GB' } = useParams();
  const [search] = useSearchParams();
  const versionId = search.get('versionId') ?? '';
  const [course, setCourse] = useState<PreviewCourse | null>(null);
  const [error, setError] = useState('');
  const [activeLessonId, setActiveLessonId] = useState('');
  const [portalOpening, setPortalOpening] = useState(false);
  const [portalError, setPortalError] = useState('');

  useEffect(() => {
    const query = versionId ? `?versionId=${encodeURIComponent(versionId)}` : '';
    boRequest<PreviewCourse>(`/api/backoffice/courses/${courseId}/preview${query}`).then((result) => {
      if (result.success) {
        setCourse(result.data);
        setActiveLessonId(result.data.lessons[0]?.id ?? '');
      } else {
        setError(L(locale, '加载失败：', 'Load failed: ') + result.error);
      }
    });
  }, [courseId, locale, versionId]);

  async function openPortalPreview() {
    setPortalOpening(true);
    setPortalError('');
    const popup = window.open('about:blank', '_blank');
    const query = new URLSearchParams({ locale });
    if (versionId) query.set('versionId', versionId);
    const result = await boRequest<PortalPreviewLink>(
      `/api/backoffice/courses/${courseId}/portal-preview?${query.toString()}`,
    );
    setPortalOpening(false);
    if (!result.success) {
      popup?.close();
      setPortalError(result.message ?? L(locale, '无法生成 Portal 预览链接。', 'Could not create Portal preview link.'));
      return;
    }
    if (popup) {
      popup.opener = null;
      popup.location.href = result.data.url;
      return;
    }
    window.open(result.data.url, '_blank', 'noopener,noreferrer');
  }

  const activeLesson = useMemo(
    () => course?.lessons.find((lesson) => lesson.id === activeLessonId) ?? course?.lessons[0] ?? null,
    [course, activeLessonId],
  );
  const pendingLessons = useMemo(
    () => (course?.completeness.steps.content.lessons ?? []).filter((lesson) => !lesson.studyComplete),
    [course],
  );

  if (error) return <section className="card cardGrow"><p>{error}</p></section>;
  if (!course) return <section className="card cardGrow"><p>{L(locale, '加载中…', 'Loading…')}</p></section>;

  const mediaUrl = (assetId: string) => `/api/backoffice/courses/${courseId}/media/${assetId}`;

  return (
    <section className="card cardGrow" style={{ overflow: 'auto', maxWidth: 1120, margin: '0 auto', padding: '24px 32px' }}>
      <nav style={{ fontSize: 13, opacity: 0.65, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Link to={`/${locale}/course/${courseId}`}>{L(locale, '← 返回编辑', '← Back to editor')}</Link>
        <span>·</span>
        <span>{course.versionLabel ? `${L(locale, '版本', 'Version')} ${course.versionLabel}（${L(locale, '只读', 'read-only')}）` : L(locale, '学员视角预览（草稿）', 'Learner view preview (draft)')}</span>
        <button
          type="button"
          onClick={openPortalPreview}
          disabled={portalOpening}
          style={{ marginLeft: 'auto', padding: '4px 10px', borderRadius: 8, border: '1px solid #2B58C8', background: '#fff', color: '#2B58C8', cursor: portalOpening ? 'wait' : 'pointer', opacity: portalOpening ? 0.6 : 1 }}
        >
          {portalOpening ? L(locale, '生成链接…', 'Creating link…') : L(locale, '在 Portal 中预览', 'Preview in Portal')}
        </button>
      </nav>
      {portalError && (
        <p style={{ background: '#FDECEC', color: '#A32020', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
          {portalError}
        </p>
      )}

      {course.versionLabel && (
        <p style={{ background: '#FFF6E5', color: '#9A6B00', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
          {L(locale, `正在查看 ${course.versionLabel} 的只读快照。`, `Viewing the read-only snapshot of ${course.versionLabel}.`)}
        </p>
      )}

      {course.coverUrl && <img src={course.coverUrl} alt="cover" style={{ width: '100%', maxHeight: 320, objectFit: 'cover', borderRadius: 16 }} />}

      {course.category && (
        <div style={{ marginTop: 20 }}>
          <span style={{ background: '#EEF3FF', color: '#2B58C8', borderRadius: 999, padding: '2px 10px', fontSize: 12 }}>{localizedName(locale, course.category)}</span>
        </div>
      )}
      <h1 style={{ margin: '12px 0 8px', fontSize: 30 }}>{course.title}</h1>
      {course.shortDescription && <p style={{ fontSize: 16, opacity: 0.8, margin: 0 }}>{course.shortDescription}</p>}
      <div style={{ marginTop: 10, opacity: 0.7, fontSize: 14 }}>
        {course.lessonCount} {L(locale, '节课', 'lessons')}
        {course.totalDurationSeconds ? ` · ${fmtTotal(course.totalDurationSeconds, locale)}` : ''} · {learningModeLabel(locale, course.learningMode)} · {course.learningLanguages.map((language) => languageLabel(locale, language)).join(', ')}
        {course.trial.enabled ? ` · ${L(locale, '试看', 'Trial')} ${course.trial.available ? '✓' : L(locale, '未完成', 'incomplete')}` : ` · ${L(locale, '无试看', 'No trial')}`}
      </div>

      {course.overview && (
        <div style={{ marginTop: 28 }}>
          <h2 style={{ fontSize: 20 }}>{L(locale, '课程概览', 'Overview')}</h2>
          <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{course.overview}</p>
        </div>
      )}

      {strings(course.whatYouLearn).length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 20 }}>{L(locale, "你将学到什么", "What you'll learn")}</h2>
          <ul style={{ lineHeight: 1.9 }}>{strings(course.whatYouLearn).map((item, index) => <li key={index}>{item}</li>)}</ul>
        </div>
      )}

      <div style={{ marginTop: 28, borderTop: '1px solid #E8EDF5', paddingTop: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ fontSize: 20, margin: 0 }}>{L(locale, '课程大纲', 'Course outline')}</h2>
          <span style={{ opacity: 0.7, fontSize: 14 }}>{course.lessonCount} {L(locale, '节课', 'lessons')}</span>
        </div>
        <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
          {course.lessons.map((lesson) => {
            const active = lesson.id === activeLesson?.id;
            return (
              <button
                key={lesson.id}
                onClick={() => setActiveLessonId(lesson.id)}
                style={{ textAlign: 'left', padding: '14px 16px', borderRadius: 12, border: active ? '1px solid #2B58C8' : '1px solid #E8EDF5', background: active ? '#F5F8FF' : '#fff', cursor: 'pointer' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <strong>{L(locale, '课时', 'Lesson')} {lesson.index}　{lesson.title}</strong>
                  <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {lesson.trial && <span style={{ fontSize: 12, color: '#2B58C8' }}>{L(locale, '试看', 'Trial')}</span>}
                    <span style={{ opacity: 0.7, fontSize: 13 }}>{fmtMMSS(lesson.videoDurationSeconds)}</span>
                  </span>
                </div>
                {lesson.description && <div style={{ opacity: 0.75, fontSize: 14, marginTop: 4 }}>{lesson.description}</div>}
              </button>
            );
          })}
          {course.lessons.length === 0 && (
            <div style={{ borderRadius: 12, border: '1px dashed #E0C48A', background: '#FFFBF0', padding: '12px 14px' }}>
              {pendingLessons.length === 0 ? (
                <>
                  <p style={{ margin: 0, opacity: 0.75 }}>
                    {L(
                      locale,
                      '保存成功不代表课时已达到学员端展示条件。学员大纲只显示学习与探索内容已完成的课时。',
                      'A successful save does not mean a lesson is ready for learners. The outline only shows lessons with completed Study & Exploration.',
                    )}
                  </p>
                  <p style={{ margin: '6px 0 0', fontSize: 13 }}>
                    <Link to={`/${locale}/course/${courseId}`}>{L(locale, '去编辑课程并添加课时', 'Open the editor to add lessons')}</Link>
                  </p>
                </>
              ) : (
                <>
                  <strong style={{ fontSize: 14 }}>
                    {L(
                      locale,
                      '学员端大纲只列出学习与探索内容已完成的课时，以下课时尚未完成：',
                      'The learner outline only lists lessons whose Study & Exploration is complete. Still incomplete:',
                    )}
                  </strong>
                  <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, lineHeight: 1.9 }}>
                    {pendingLessons.map((lesson) => {
                      const shown = lesson.missing.slice(0, 6).map((item) => localizeMissing(locale, item));
                      const rest = lesson.missing.length - shown.length;
                      return (
                        <li key={lesson.lessonId}>
                          <strong>{lesson.code}</strong>{' — '}
                          {shown.join(locale.startsWith('zh') ? '；' : '; ')}
                          {rest > 0 ? L(locale, ` 等共 ${lesson.missing.length} 项`, ` (+${rest} more)`) : ''}
                        </li>
                      );
                    })}
                  </ul>
                  <p style={{ margin: '8px 0 0', fontSize: 13 }}>
                    <Link to={`/${locale}/course/${courseId}`}>{L(locale, '返回编辑继续完善并保存', 'Back to the editor to finish and save')}</Link>
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {providerItems(course.provides).length > 0 && (
        <div style={{ marginTop: 28 }}>
          <h2 style={{ fontSize: 20 }}>{L(locale, '本课程提供', 'This course provides')}</h2>
          <ul style={{ lineHeight: 1.9 }}>{providerItems(course.provides).map((item, index) => <li key={index}>{item.title}</li>)}</ul>
        </div>
      )}

      {course.plans.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <h2 style={{ fontSize: 20 }}>{L(locale, '价格', 'Pricing')}</h2>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {course.plans.map((plan) => (
              <div key={plan.id} style={{ border: '1px solid #E8EDF5', borderRadius: 12, padding: 16, minWidth: 180 }}>
                <strong>{plan.name}</strong>
                <div style={{ fontSize: 22, marginTop: 6 }}>{price(plan.amountMinor, plan.currency)}</div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>{plan.termMonths} {L(locale, '个月', 'months')}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeLesson && (
        <div style={{ marginTop: 32, borderTop: '1px solid #E8EDF5', paddingTop: 24 }}>
          <h2 style={{ fontSize: 22 }}>{L(locale, '课时', 'Lesson')} {activeLesson.index}　{activeLesson.title}</h2>
          {activeLesson.trial && (
            <p style={{ fontSize: 13, color: '#2B58C8' }}>
              {L(locale, '试看范围', 'Trial')}：{activeLesson.trial.videoCutoffSeconds ? `video ${fmtMMSS(activeLesson.trial.videoCutoffSeconds)}` : ''}
              {activeLesson.trial.textCutoffLearningPointId ? ` · text LP ${activeLesson.trial.textCutoffLearningPointId}` : ''}
            </p>
          )}
          {activeLesson.videoAssetId && (
            <video controls style={{ width: '100%', maxHeight: 460, background: '#000', borderRadius: 10, marginTop: 12 }} src={mediaUrl(activeLesson.videoAssetId)} />
          )}
          {activeLesson.textHtml && (
            <div style={{ marginTop: 16, lineHeight: 1.8 }} dangerouslySetInnerHTML={{ __html: activeLesson.textHtml }} />
          )}
          {activeLesson.learningPoints.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <h3>{L(locale, '学习点', 'Learning points')}</h3>
              <ul>{activeLesson.learningPoints.map((lp) => <li key={`${lp.source}-${lp.code}`}>{lp.code} · {lp.title}{lp.timeSeconds ? ` · ${fmtMMSS(lp.timeSeconds)}` : ''}</li>)}</ul>
            </div>
          )}
          {activeLesson.exhibits.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <h3>{L(locale, '展品', 'Exhibits')}</h3>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {activeLesson.exhibits.map((exhibit) => (
                  <figure key={exhibit.code} style={{ width: 240, margin: 0 }}>
                    {exhibit.mediaAssetId && <img src={mediaUrl(exhibit.mediaAssetId)} alt={exhibit.title} style={{ width: '100%', borderRadius: 10 }} />}
                    <figcaption style={{ fontSize: 13, marginTop: 6 }}><strong>{exhibit.title}</strong>{exhibit.description ? ` — ${exhibit.description}` : ''}</figcaption>
                  </figure>
                ))}
              </div>
            </div>
          )}
          {activeLesson.readings.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <h3>{L(locale, '推荐阅读', 'Recommended reading')}</h3>
              <ul>{activeLesson.readings.map((reading, index) => <li key={index}>{reading.title}{reading.author ? ` — ${reading.author}` : ''}</li>)}</ul>
            </div>
          )}
          {activeLesson.knowledgeTest.enabled && (
            <div style={{ marginTop: 20 }}>
              <h3>{L(locale, '知识测试', 'Knowledge test')}（{activeLesson.knowledgeTest.questions.length}）</h3>
              <ol>{activeLesson.knowledgeTest.questions.map((question) => <li key={question.code} style={{ marginBottom: 8 }}>{question.question}</li>)}</ol>
            </div>
          )}
          {activeLesson.applicationTest && (
            <div style={{ marginTop: 20 }}>
              <h3>{L(locale, '应用测试', 'Application test')}</h3>
              <p style={{ whiteSpace: 'pre-wrap' }}>{activeLesson.applicationTest.scenario}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

