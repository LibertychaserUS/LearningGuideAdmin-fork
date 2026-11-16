import { useState } from 'react';

import type { Lesson } from '../../contracts/course';
import { boRequest } from '../../lib/api';
import { Field, Modal } from './shared';
import { L, buttonStyle, card, inputStyle, languageLabel, primaryBtn } from './shared-utils';
import type { Locale } from '../../lib/i18n/config';
import { serverText } from '../../lib/i18n/serverText';

type Question = { code: string; question: string; referenceAnswer: string };
type ImportErrors = Array<{ row: number; message: string }>;
type ImportPreview = {
  rowsRead: number;
  added: number;
  byLesson: Record<string, number>;
  errors: ImportErrors;
};

export function UnderstandingPanel({
  locale,
  courseId,
  lesson,
  language,
  busy,
  setBusy,
  onSaved,
  onNotice,
}: {
  locale: string;
  courseId: string;
  lesson: Lesson;
  language: string;
  busy: boolean;
  setBusy: (value: boolean) => void;
  onSaved: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [knowledgeEnabled, setKnowledgeEnabled] = useState(true);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [applicationEnabled, setApplicationEnabled] = useState(Boolean(lesson.applicationTest));
  const [applicationScenario, setApplicationScenario] = useState(lesson.applicationTest?.scenario ?? '');
  const [applicationAnswer, setApplicationAnswer] = useState(lesson.applicationTest?.referenceAnswer ?? '');
  const [singleImportOpen, setSingleImportOpen] = useState(false);
  const [singleFile, setSingleFile] = useState<File | null>(null);
  const [singlePreview, setSinglePreview] = useState<ImportPreview | null>(null);
  const [singleResult, setSingleResult] = useState<{ added: number; errors: ImportErrors } | null>(null);
  const [singleBusy, setSingleBusy] = useState(false);

  const [source, setSource] = useState<{ lesson: Lesson; language: string } | null>(null);
  if (source?.lesson !== lesson || source?.language !== language) {
    setSource({ lesson, language });
    setKnowledgeEnabled(true);
    setQuestions(
      lesson.questions.map((question, index) => ({
        code: question.code ?? `K-${String(index + 1).padStart(4, '0')}`,
        question: question.question,
        referenceAnswer: question.referenceAnswer ?? '',
      })),
    );
    setApplicationEnabled(Boolean(lesson.applicationTest));
    setApplicationScenario(lesson.applicationTest?.scenario ?? '');
    setApplicationAnswer(lesson.applicationTest?.referenceAnswer ?? '');
  }

  async function saveKnowledge() {
    setBusy(true);
    const result = await boRequest(`/api/backoffice/courses/${courseId}/lessons/${lesson.id}/knowledge-test`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: knowledgeEnabled,
        questions: knowledgeEnabled
          ? questions.map((question, index) => ({
              code: question.code || `K-${String(index + 1).padStart(4, '0')}`,
              question: question.question,
              referenceAnswer: question.referenceAnswer,
            }))
          : [],
      }),
    });
    setBusy(false);
    if (result.success) {
      onNotice(L(locale, '知识测试已保存。', 'Knowledge Test saved.'));
      await onSaved();
    } else {
      onNotice(`${L(locale, '保存失败', 'Save failed')}: ${result.message ?? result.error}`);
    }
  }

  async function saveApplication() {
    setBusy(true);
    const result = await boRequest(`/api/backoffice/courses/${courseId}/lessons/${lesson.id}/application-test`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: applicationEnabled,
        scenario: applicationScenario,
        referenceAnswer: applicationAnswer,
      }),
    });
    setBusy(false);
    if (result.success) {
      onNotice(L(locale, '应用测试已保存。', 'Application Test saved.'));
      await onSaved();
    } else {
      onNotice(`${L(locale, '保存失败', 'Save failed')}: ${result.message ?? result.error}`);
    }
  }

  function addQuestion() {
    setQuestions((current) => [
      ...current,
      {
        code: `K-${String(current.length + 1).padStart(4, '0')}`,
        question: '',
        referenceAnswer: '',
      },
    ]);
    setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>('input[data-new-question="true"]');
      input?.focus();
    }, 0);
  }

  async function runSinglePreview(target: File | null = singleFile) {
    if (!target) return;
    setSingleBusy(true);
    const form = new FormData();
    form.append('file', target);
    const result = await boRequest<ImportPreview>(
      `/api/backoffice/courses/${courseId}/understanding/import/preview?language=${encodeURIComponent(language)}&lessonId=${encodeURIComponent(lesson.id)}`,
      { method: 'POST', body: form },
    );
    setSingleBusy(false);
    if (result.success) {
      setSinglePreview({
        rowsRead: result.data.rowsRead ?? 0,
        added: result.data.added ?? 0,
        byLesson: result.data.byLesson ?? {},
        errors: result.data.errors ?? [],
      });
      setSingleResult(null);
    } else {
      setSinglePreview({
        rowsRead: 0,
        added: 0,
        byLesson: {},
        errors: [{ row: 0, message: result.message ?? result.error }],
      });
    }
  }

  async function runSingleImport() {
    if (!singleFile || !singlePreview) return;
    setSingleBusy(true);
    const form = new FormData();
    form.append('file', singleFile);
    form.append('confirm', 'true');
    const result = await boRequest<{ added: number; errors: ImportErrors }>(
      `/api/backoffice/courses/${courseId}/understanding/import?language=${encodeURIComponent(language)}&lessonId=${encodeURIComponent(lesson.id)}`,
      { method: 'POST', body: form },
    );
    setSingleBusy(false);
    if (result.success) {
      setSingleResult({ added: result.data.added, errors: result.data.errors ?? [] });
      setSinglePreview(null);
      if (result.data.added > 0) await onSaved();
    } else {
      setSingleResult({ added: 0, errors: [{ row: 0, message: result.message ?? result.error }] });
    }
  }

  function downloadTemplate() {
    window.open(`/api/backoffice/courses/${courseId}/understanding/template`, '_blank');
  }

  return (
    <div>
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, '知识测试', 'Knowledge Test')}</h2>
            <p style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.65 }}>{L(locale, '按添加顺序排列；新题加在末尾；不支持调整顺序。', 'Questions stay in add order; new questions go to the end; order cannot be changed.')}</p>
          </div>
          <label style={{ fontSize: 14 }}>
            <input type="checkbox" checked={knowledgeEnabled} onChange={(event) => setKnowledgeEnabled(event.target.checked)} /> {L(locale, '启用', 'Enabled')}
          </label>
        </div>

        {knowledgeEnabled && (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
              <button type="button" style={primaryBtn} onClick={addQuestion}>+ {L(locale, '添加题目', 'Add question')}</button>
              <button type="button" style={buttonStyle} onClick={() => setSingleImportOpen(true)}>{L(locale, '从表格导入', 'Import from sheet')}</button>
              <button type="button" style={buttonStyle} onClick={downloadTemplate}>{L(locale, '下载模板', 'Download template')}</button>
            </div>

            <div style={{ marginTop: 12 }}>
              {questions.map((question, index) => (
                <div key={`${question.code}-${index}`} style={{ border: '1px solid #E8EDF5', borderRadius: 10, padding: 12, marginTop: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 12, color: '#5A6577', fontWeight: 600 }}>Q{index + 1} · {question.code}</span>
                    <button type="button" style={{ ...buttonStyle, padding: '4px 8px', color: '#b42318' }} onClick={() => setQuestions((current) => current.filter((_, i) => i !== index))}>
                      {L(locale, '删除', 'Delete question')}
                    </button>
                  </div>
                  <Field label={L(locale, '题目 *', 'Question *')} hint={`${question.question.length} / 200`}>
                    <input data-new-question={index === questions.length - 1 ? 'true' : 'false'} value={question.question} onChange={(event) => setQuestions((current) => current.map((item, i) => i === index ? { ...item, question: event.target.value } : item))} style={inputStyle} />
                  </Field>
                  <Field label={L(locale, '参考答案 *', 'Reference answer *')} hint={`${question.referenceAnswer.length} / 600`}>
                    <textarea rows={4} value={question.referenceAnswer} onChange={(event) => setQuestions((current) => current.map((item, i) => i === index ? { ...item, referenceAnswer: event.target.value } : item))} style={inputStyle} />
                  </Field>
                </div>
              ))}
              {questions.length === 0 && <p style={{ opacity: 0.7, marginTop: 10 }}>{L(locale, '暂无题目。', 'No questions yet.')}</p>}
            </div>
            <button type="button" style={{ ...primaryBtn, marginTop: 12 }} disabled={busy} onClick={() => void saveKnowledge()}>{L(locale, '保存知识测试', 'Save Knowledge Test')}</button>
          </>
        )}
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{L(locale, '应用测试', 'Application Test')}</h2>
          <label style={{ fontSize: 14 }}>
            <input type="checkbox" checked={applicationEnabled} onChange={(event) => setApplicationEnabled(event.target.checked)} /> {L(locale, '启用', 'Enabled')}
          </label>
        </div>
        {applicationEnabled && (
          <>
            <Field label={L(locale, '题目 *', 'Question *')}>
              <textarea rows={7} value={applicationScenario} onChange={(event) => setApplicationScenario(event.target.value)} style={inputStyle} />
            </Field>
            <Field label={L(locale, '参考答案 *', 'Reference answer *')} hint={L(locale, '学员提交且 AI 评估完成后展示给学员。', 'Shown to learners after AI review.')}>
              <textarea rows={7} value={applicationAnswer} onChange={(event) => setApplicationAnswer(event.target.value)} style={inputStyle} />
            </Field>
            <button type="button" style={{ ...primaryBtn, marginTop: 12 }} disabled={busy} onClick={() => void saveApplication()}>{L(locale, '保存应用测试', 'Save Application Test')}</button>
          </>
        )}
      </div>

      {singleImportOpen && (
        <Modal title={L(locale, '导入题目', 'Import questions')} onClose={() => { setSingleImportOpen(false); setSingleFile(null); setSinglePreview(null); setSingleResult(null); }}>
          <p style={{ fontSize: 13, color: '#5A6577' }}>{L(locale, '课时', 'Lesson')} {lesson.sortOrder} · {lesson.localizations[0]?.title ?? lesson.code} · {languageLabel(locale, language)}</p>
          <Field label={L(locale, '上传 .xlsx 或 .csv', 'Upload .xlsx or .csv')}>
            <input type="file" accept=".xlsx,.csv" onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              setSingleFile(file);
              setSinglePreview(null);
              setSingleResult(null);
              if (file) void runSinglePreview(file);
            }} />
          </Field>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" style={primaryBtn} disabled={!singlePreview || singlePreview.added === 0 || singleBusy} onClick={() => void runSingleImport()}>
              {singleBusy
                ? L(locale, '处理中…', 'Working…')
                : L(locale, `导入 ${singlePreview?.added ?? 0} 题`, `Import ${singlePreview?.added ?? 0} questions`)}
            </button>
            <button type="button" style={buttonStyle} onClick={() => window.open(`/api/backoffice/courses/${courseId}/understanding/template`, '_blank')}>{L(locale, '下载模板', 'Download template')}</button>
          </div>
          {singlePreview && (
            <div style={{ marginTop: 12, fontSize: 13 }}>
              <p style={{ fontWeight: 600 }}>{L(locale, `读取 ${singlePreview.rowsRead} 行，将新增 ${singlePreview.added} 题`, `Read ${singlePreview.rowsRead} rows, ${singlePreview.added} questions will be added`)}</p>
              {Object.entries(singlePreview.byLesson).map(([lessonCode, count]) => (
                <p key={lessonCode}>{lessonCode} · +{count}</p>
              ))}
              {singlePreview.errors.map((error, index) => (
                <p key={index} style={{ color: '#b42318' }}>{error.row ? `${L(locale, '第', 'Row')} ${error.row} · ` : ''}{serverText(error.message, locale as Locale)}</p>
              ))}
            </div>
          )}
          {singleResult && (
            <div style={{ marginTop: 12, fontSize: 13 }}>
              <p style={{ fontWeight: 600 }}>{L(locale, '已导入', 'Imported')} {singleResult.added} {L(locale, '题', 'questions')}</p>
              {singleResult.errors.map((error, index) => (
                <p key={index} style={{ color: '#b42318' }}>{error.row ? `${L(locale, '第', 'Row')} ${error.row} · ` : ''}{serverText(error.message, locale as Locale)}</p>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
