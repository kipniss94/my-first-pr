'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DocxBlock, DocxEditable, EditableParagraph } from '@docuview/shared';
import { editedName, getEditable, saveEdited, saveToDisk } from '@/lib/edit';
import { useT } from '@/lib/prefs';

/**
 * Editing a Word document: its paragraphs and tables as text fields, page
 * by page. Typing changes the text; a block or a whole page can be deleted.
 * Saving writes the changes into the original .docx, so everything else in it
 * — styles, pictures, numbering — comes back untouched.
 */
export function DocEditor({ fileId, fileName, onClose }: { fileId: string; fileName: string; onClose(): void }) {
  const { t, tp } = useT();
  const [model, setModel] = useState<DocxEditable | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [texts, setTexts] = useState<Map<number, string>>(new Map());
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getEditable(fileId).then(
      (value) => {
        if (cancelled) return;
        if (value.kind === 'docx') setModel(value);
        else setFailed(t("We couldn't read this document for editing."));
      },
      (err: Error) => !cancelled && setFailed(t(err.message)),
    );
    return () => {
      cancelled = true;
    };
  }, [fileId, t]);

  const pages = useMemo(() => {
    const byPage = new Map<number, DocxBlock[]>();
    for (const block of model?.blocks ?? []) byPage.set(block.page, [...(byPage.get(block.page) ?? []), block]);
    return [...byPage.entries()].sort((a, b) => a[0] - b[0]);
  }, [model]);

  const originals = useMemo(() => {
    const map = new Map<number, string>();
    const add = (paragraph: EditableParagraph) => map.set(paragraph.id, paragraph.text);
    for (const block of model?.blocks ?? []) {
      if (block.type === 'paragraph') add(block.paragraph);
      else if (block.type === 'group') block.paragraphs.forEach(add);
      else block.rows.forEach((row) => row.forEach((cell) => cell.forEach(add)));
    }
    return map;
  }, [model]);

  const changed = [...texts.entries()].filter(([id, text]) => originals.get(id) !== text);
  const dirty = changed.length > 0 || deleted.size > 0;

  const close = () => {
    if (dirty && !window.confirm(t('Leave without saving? The changes will be lost.'))) return;
    onClose();
  };

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const blob = await saveEdited(fileId, {
        docx: { paragraphs: changed.map(([id, text]) => ({ id, text })), deleteBlocks: [...deleted] },
      });
      const done = await saveToDisk(blob, editedName(fileName));
      if (done) setNotice(t('Saved. The original on the server is unchanged.'));
    } catch (err) {
      setNotice(t(err instanceof Error ? err.message : "We couldn't save these changes into the document."));
    } finally {
      setSaving(false);
    }
  };

  const toggleBlocks = (blocks: number[], remove: boolean) =>
    setDeleted((current) => {
      const next = new Set(current);
      for (const block of blocks) {
        if (remove) next.add(block);
        else next.delete(block);
      }
      return next;
    });

  const paragraphField = (paragraph: EditableParagraph, struck: boolean) => (
    <AutoText
      key={paragraph.id}
      value={texts.get(paragraph.id) ?? paragraph.text}
      onChange={(value) => setTexts((current) => new Map(current).set(paragraph.id, value))}
      disabled={struck}
      className={`${STYLE_CLASS[paragraph.style]} ${originals.get(paragraph.id) !== (texts.get(paragraph.id) ?? paragraph.text) ? 'bg-amber-50' : ''}`}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="doc-editor">
      <EditorBar
        title={t('Editing')}
        fileName={fileName}
        info={
          model
            ? model.pagesFrom === 'none'
              ? t('No page breaks in this document: delete paragraphs one by one.')
              : `${tp(model.pages, ['{n} page', '{n} pages'], ['{n} страница', '{n} страницы', '{n} страниц'])} · ${t(
                  model.pagesFrom === 'layout' ? 'as Word last laid them out' : 'by the page breaks in the file',
                )}`
            : ''
        }
        changes={changed.length + deleted.size}
        saving={saving}
        saveLabel={t('Save as .docx…')}
        onSave={() => void save()}
        onClose={close}
        notice={notice}
      />
      <div className="min-h-0 flex-1 overflow-auto bg-paper-2 py-6">
        {failed && <p className="mx-auto max-w-3xl px-6 text-center text-sm text-danger">{failed}</p>}
        {!model && !failed && <p className="mx-auto max-w-3xl px-6 text-center text-sm text-paper-muted">{t('Reading the document…')}</p>}
        {pages.map(([page, blocks]) => {
          const removable = blocks.filter((block) => !(block.type === 'paragraph' && block.locked)).map((block) => block.block);
          const pageGone = removable.length > 0 && removable.every((block) => deleted.has(block));
          return (
            <section key={page} className="mx-auto mb-6 max-w-[52rem] rounded-xl bg-paper px-8 py-6 shadow-[0_1px_20px_-8px_rgba(0,0,0,0.25)]" data-testid="doc-editor-page">
              {model && model.pagesFrom !== 'none' && (
                <div className="mb-3 flex items-center justify-between border-b border-paper-line pb-2">
                  <span className="text-[12px] font-medium uppercase tracking-wider text-paper-muted">{t('Page {n}', { n: page })}</span>
                  {removable.length > 0 && (
                    <button
                      type="button"
                      onClick={() => toggleBlocks(removable, !pageGone)}
                      className={`rounded-md border px-2 py-0.5 text-[12px] ${pageGone ? 'border-paper-line text-paper-ink' : 'border-red-300 text-red-700 hover:bg-red-50'}`}
                      data-testid="doc-editor-delete-page"
                    >
                      {pageGone ? t('Restore the page') : t('Delete the page')}
                    </button>
                  )}
                </div>
              )}
              <div className="space-y-1">
                {blocks.map((block) => {
                  const struck = deleted.has(block.block);
                  const lockedBlock = block.type === 'paragraph' && block.locked;
                  return (
                    <div key={block.block} className={`group relative rounded ${struck ? 'opacity-40 [&_textarea]:line-through' : ''}`}>
                      {block.type === 'paragraph' && paragraphField(block.paragraph, struck)}
                      {block.type === 'group' && block.paragraphs.map((paragraph) => paragraphField(paragraph, struck))}
                      {block.type === 'table' && (
                        <table className="w-full border-collapse text-[13px]">
                          <tbody>
                            {block.rows.map((row, r) => (
                              <tr key={r}>
                                {row.map((cell, c) => (
                                  <td key={c} className="border border-paper-line p-1 align-top">
                                    {cell.map((paragraph) => paragraphField(paragraph, struck))}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      {!lockedBlock && (
                        <button
                          type="button"
                          onClick={() => toggleBlocks([block.block], !struck)}
                          title={struck ? t('Restore') : block.type === 'table' ? t('Delete the table') : t('Delete the paragraph')}
                          aria-label={struck ? t('Restore') : block.type === 'table' ? t('Delete the table') : t('Delete the paragraph')}
                          className="absolute -right-7 top-1 hidden h-5 w-5 place-items-center rounded text-paper-muted hover:bg-red-50 hover:text-red-700 group-hover:grid"
                        >
                          {struck ? '↺' : '×'}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

const STYLE_CLASS: Record<EditableParagraph['style'], string> = {
  title: 'text-[22px] font-semibold',
  heading1: 'text-[19px] font-semibold',
  heading2: 'text-[16px] font-semibold',
  heading3: 'text-[15px] font-semibold',
  list: 'pl-5 text-[14px]',
  body: 'text-[14px]',
};

/** A text field that grows with its text, so a paragraph reads as a paragraph. */
function AutoText({
  value,
  onChange,
  disabled,
  className = '',
}: {
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const area = ref.current;
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      rows={1}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className={`block w-full resize-none overflow-hidden rounded border border-transparent bg-transparent px-1 py-0.5 leading-relaxed text-paper-ink outline-none hover:border-paper-line focus:border-accent focus:bg-white ${className}`}
      data-testid="doc-editor-field"
    />
  );
}

/** The bar above every editor: what is edited, how many changes, save and leave. */
export function EditorBar({
  title,
  fileName,
  info,
  changes,
  saving,
  saveLabel,
  onSave,
  onClose,
  notice,
}: {
  title: string;
  fileName: string;
  info: string;
  changes: number;
  saving: boolean;
  saveLabel: string;
  onSave(): void;
  onClose(): void;
  notice: string | null;
}) {
  const { t, tp } = useT();
  return (
    <div className="shrink-0 border-b border-line bg-ink-850 px-3 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded-md border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent-bright">{title}</span>
        <span className="min-w-0 truncate text-[13px] text-mist-200" title={fileName}>
          {fileName}
        </span>
        <span className="hidden text-[12px] text-mist-500 md:inline">{info}</span>
        <span className="ml-auto text-[12px] text-mist-400" data-testid="editor-changes">
          {changes === 0
            ? t('No changes yet')
            : tp(changes, ['{n} change', '{n} changes'], ['{n} изменение', '{n} изменения', '{n} изменений'])}
        </span>
        <button type="button" className="btn btn-ghost" onClick={onClose} data-testid="editor-close">
          {t('Close the editor')}
        </button>
        <button type="button" className="btn btn-primary" onClick={onSave} disabled={saving || changes === 0} data-testid="editor-save">
          {saving ? t('Saving…') : saveLabel}
        </button>
      </div>
      {notice && (
        <p role="status" className="mt-1.5 text-[12px] text-mist-300" data-testid="editor-notice">
          {notice}
        </p>
      )}
    </div>
  );
}
