'use client';

import { useEffect, useState } from 'react';
import type { PptxEditable } from '@docuview/shared';
import { editedName, getEditable, saveEdited, saveToDisk } from '@/lib/edit';
import { useT } from '@/lib/prefs';
import { EditorBar } from './DocEditor';

/**
 * Editing a presentation: every slide with the text of its shapes, one field
 * per paragraph, and a delete switch per slide. Saving writes into the
 * original .pptx; layouts, pictures and animations stay as they were.
 */
export function SlidesEditor({ fileId, fileName, onClose }: { fileId: string; fileName: string; onClose(): void }) {
  const { t } = useT();
  const [model, setModel] = useState<PptxEditable | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /** "slide|shape|paragraph" → text. */
  const [texts, setTexts] = useState<Map<string, string>>(new Map());
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getEditable(fileId).then(
      (value) => {
        if (cancelled) return;
        if (value.kind === 'pptx') setModel(value);
        else setFailed(t("We couldn't read this document for editing."));
      },
      (err: Error) => !cancelled && setFailed(t(err.message)),
    );
    return () => {
      cancelled = true;
    };
  }, [fileId, t]);

  const original = (slide: number, shape: string, paragraph: number) =>
    model?.slides[slide]?.shapes.find((s) => s.id === shape)?.paragraphs[paragraph] ?? '';
  const changed = [...texts.entries()].filter(([key, text]) => {
    const [slide, shape, paragraph] = key.split('|');
    return original(Number(slide), shape, Number(paragraph)) !== text;
  });
  const dirty = changed.length > 0 || deleted.size > 0;

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const blob = await saveEdited(fileId, {
        pptx: {
          texts: changed.map(([key, text]) => {
            const [slide, shape, paragraph] = key.split('|');
            return { slide: Number(slide), shape, paragraph: Number(paragraph), text };
          }),
          deleteSlides: [...deleted],
        },
      });
      if (await saveToDisk(blob, editedName(fileName))) setNotice(t('Saved. The original on the server is unchanged.'));
    } catch (err) {
      setNotice(t(err instanceof Error ? err.message : "We couldn't save these changes into the document."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="slides-editor">
      <EditorBar
        title={t('Editing')}
        fileName={fileName}
        info={t('The text of every shape, paragraph by paragraph. A slide is deleted with its switch.')}
        changes={changed.length + deleted.size}
        saving={saving}
        saveLabel={t('Save as .pptx…')}
        notice={notice}
        onSave={() => void save()}
        onClose={() => {
          if (dirty && !window.confirm(t('Leave without saving? The changes will be lost.'))) return;
          onClose();
        }}
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-auto bg-paper-2 p-6">
        {failed && <p className="text-center text-sm text-danger">{failed}</p>}
        {!model && !failed && <p className="text-center text-sm text-paper-muted">{t('Reading the document…')}</p>}
        {model?.slides.map((slide) => {
          const gone = deleted.has(slide.index);
          return (
            <section
              key={slide.index}
              className={`mx-auto max-w-3xl rounded-xl bg-paper p-5 shadow-[0_1px_20px_-8px_rgba(0,0,0,0.25)] ${gone ? 'opacity-45' : ''}`}
              data-testid="slides-editor-slide"
            >
              <div className="mb-3 flex items-center justify-between gap-3 border-b border-paper-line pb-2">
                <span className="truncate text-[13px] font-semibold text-paper-ink">
                  {t('Slide {n}', { n: slide.index + 1 })}
                  {slide.title ? ` · ${slide.title}` : ''}
                </span>
                <button
                  type="button"
                  className={`shrink-0 rounded-md border px-2 py-0.5 text-[12px] ${gone ? 'border-paper-line text-paper-ink' : 'border-red-300 text-red-700 hover:bg-red-50'}`}
                  onClick={() =>
                    setDeleted((current) => {
                      const next = new Set(current);
                      if (next.has(slide.index)) next.delete(slide.index);
                      else if (next.size < model.slides.length - 1) next.add(slide.index);
                      return next;
                    })
                  }
                  data-testid="slides-editor-delete"
                >
                  {gone ? t('Restore the slide') : t('Delete the slide')}
                </button>
              </div>
              {slide.shapes.length === 0 && <p className="text-[12px] text-paper-muted">{t('No text on this slide.')}</p>}
              <div className="space-y-3">
                {slide.shapes.map((shape) => (
                  <div key={shape.id}>
                    <p className="mb-1 text-[11px] uppercase tracking-wider text-paper-muted">{shape.name}</p>
                    {shape.paragraphs.map((paragraph, k) => {
                      const key = `${slide.index}|${shape.id}|${k}`;
                      const value = texts.get(key) ?? paragraph;
                      return (
                        <input
                          key={key}
                          value={value}
                          disabled={gone}
                          onChange={(event) => setTexts((current) => new Map(current).set(key, event.target.value))}
                          className={`mb-1 block w-full rounded border px-2 py-1 text-[14px] text-paper-ink outline-none focus:border-accent ${
                            value !== paragraph ? 'border-amber-300 bg-amber-50' : 'border-paper-line bg-white'
                          }`}
                          data-testid="slides-editor-field"
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
