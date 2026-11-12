import { useEffect, useRef, useState } from 'react';

import type { Exhibit } from '../../contracts/course';
import { Modal } from './shared';
import { L, buttonStyle, exhibitTypeLabel, inputStyle } from './shared-utils';
import { pickLocalized } from '../../lib/i18n/localized';

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

export function TextEditor({
  locale,
  value,
  onChange,
  exhibits,
  language,
  onImportDocx,
  onNotice,
}: {
  locale: string;
  value: string;
  onChange: (html: string) => void;
  exhibits: Exhibit[];
  language: string;
  onImportDocx: (file: File) => Promise<string | null>;
  onNotice: (message: string) => void;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const rangeRef = useRef<Range | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [busyDocx, setBusyDocx] = useState(false);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.innerHTML !== value) editor.innerHTML = value;
  }, [value, language]);

  function command(name: string, argument?: string) {
    editorRef.current?.focus();
    document.execCommand(name, false, argument);
    onChange(editorRef.current?.innerHTML ?? '');
  }

  function rememberSelection() {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) rangeRef.current = selection.getRangeAt(0).cloneRange();
  }

  function insertExhibit(exhibit: Exhibit) {
    const title = pickLocalized(exhibit.localized, 'title', language, exhibit.code);
    const description = pickLocalized(exhibit.localized, 'description', language, '');
    const html = `<figure data-exhibit-code="${escapeHtml(exhibit.code)}" data-exhibit-id="${exhibit.id}" class="course-exhibit-card" contenteditable="false" style="border:1px solid #E8EDF5;border-radius:10px;padding:12px;margin:14px 0;display:flex;gap:12px;align-items:center;background:#F9FBFE"><div style="flex:1"><strong>${escapeHtml(title)}</strong><div style="font-size:12px;color:#5A6577;margin-top:4px">${escapeHtml(exhibit.type)} · ${escapeHtml(exhibit.code)}</div><div style="font-size:13px;margin-top:6px">${escapeHtml(description)}</div></div><span style="font-size:12px;color:#2B58C8">${escapeHtml(L(locale, '展品', 'Exhibit'))}</span></figure><p><br/></p>`;
    setPickerOpen(false);
    setTimeout(() => {
      editorRef.current?.focus();
      const selection = window.getSelection();
      if (selection && rangeRef.current) {
        selection.removeAllRanges();
        selection.addRange(rangeRef.current);
      }
      document.execCommand('insertHTML', false, html);
      onChange(editorRef.current?.innerHTML ?? '');
    }, 0);
  }

  async function importDocx(file: File) {
    setBusyDocx(true);
    const html = await onImportDocx(file);
    setBusyDocx(false);
    if (html !== null) {
      editorRef.current!.innerHTML = html;
      onChange(html);
      onNotice(L(locale, 'Word 文档已载入编辑器。', 'Word document loaded into the editor.'));
    }
  }

  const filtered = exhibits.filter((exhibit) => {
    const title = pickLocalized(exhibit.localized, 'title', language, exhibit.code);
    return title.toLowerCase().includes(search.toLowerCase());
  });

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: 8, border: '1px solid #E8EDF5', borderBottom: 0, borderRadius: '10px 10px 0 0', background: '#FAFBFD' }}>
        <button type="button" style={{ ...buttonStyle, padding: '5px 9px', fontWeight: 700 }} onClick={() => command('formatBlock', 'h1')}>H1</button>
        <button type="button" style={{ ...buttonStyle, padding: '5px 9px' }} onClick={() => command('formatBlock', 'h2')}>H2</button>
        <button type="button" style={{ ...buttonStyle, padding: '5px 9px' }} onClick={() => command('formatBlock', 'h3')}>H3</button>
        <button type="button" style={{ ...buttonStyle, padding: '5px 9px', fontWeight: 700 }} onClick={() => command('bold')}>B</button>
        <button type="button" style={{ ...buttonStyle, padding: '5px 9px', fontStyle: 'italic' }} onClick={() => command('italic')}>I</button>
        <button type="button" style={{ ...buttonStyle, padding: '5px 9px' }} onClick={() => command('insertUnorderedList')}>• List</button>
        <button type="button" style={{ ...buttonStyle, padding: '5px 9px' }} onClick={() => command('insertOrderedList')}>1. List</button>
        <button type="button" style={{ ...buttonStyle, padding: '5px 9px', color: '#2B58C8' }} onClick={() => { rememberSelection(); setPickerOpen(true); }}>+ {L(locale, '插入展品', 'Insert exhibit')}</button>
        <label style={{ ...buttonStyle, padding: '5px 9px', marginLeft: 'auto', cursor: busyDocx ? 'not-allowed' : 'pointer' }}>
          {busyDocx ? L(locale, '导入中…', 'Importing…') : L(locale, '导入 .docx', 'Import .docx')}
          <input type="file" accept=".docx" disabled={busyDocx} style={{ display: 'none' }} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importDocx(file); event.currentTarget.value = ''; }} />
        </label>
      </div>
      {!value && (
        <div style={{ border: '1px solid #E8EDF5', borderBottom: 0, padding: '8px 12px', fontSize: 12, color: '#5A6577', background: '#fff' }}>
          {L(locale, '从 Google Docs 整篇粘贴，或点击导入 .docx。每个学习点标题请使用一级标题。', 'Paste a lesson from Google Docs, or Import .docx. Use “Heading 1” for each learning point.')}
        </div>
      )}
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onInput={(event) => onChange(event.currentTarget.innerHTML)}
        onBlur={() => onChange(editorRef.current?.innerHTML ?? '')}
        onKeyUp={rememberSelection}
        onMouseUp={rememberSelection}
        style={{ minHeight: 280, border: '1px solid #E8EDF5', borderRadius: '0 0 10px 10px', padding: 16, background: '#fff', fontSize: 14, lineHeight: 1.55, outline: 'none' }}
      />

      {pickerOpen && (
        <Modal title={L(locale, '插入展品', 'Insert exhibit')} onClose={() => setPickerOpen(false)}>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={L(locale, '搜索本课时的展品', "Search this lesson's exhibits")} style={inputStyle} />
          <div style={{ marginTop: 10, maxHeight: 360, overflow: 'auto' }}>
            {filtered.map((exhibit) => {
              const title = pickLocalized(exhibit.localized, 'title', language, exhibit.code);
              return (
                <button key={exhibit.id} type="button" onClick={() => insertExhibit(exhibit)} style={{ display: 'flex', justifyContent: 'space-between', width: '100%', padding: 10, border: '1px solid #E8EDF5', borderRadius: 8, background: '#fff', marginBottom: 8, cursor: 'pointer', textAlign: 'left' }}>
                  <span>{title}<div style={{ fontSize: 11, color: '#5A6577' }}>{exhibit.code}</div></span>
                  <span style={{ fontSize: 12, color: '#5A6577' }}>{exhibitTypeLabel(locale, exhibit.type)}</span>
                </button>
              );
            })}
            {filtered.length === 0 && <p style={{ opacity: 0.65 }}>{L(locale, '没有匹配的展品。', 'No matching exhibits.')}</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}
