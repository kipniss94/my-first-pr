'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SlideDocument } from '@docuview/shared';
import { fetchApi } from '@/lib/api';
import { ErrorPanel } from '@/components/viewer/ErrorPanel';
import { PdfViewer } from '@/components/pdf/PdfViewer';
import { ViewerAdRail } from '@/components/site/AdSlot';
import { NativeSlides } from './NativeSlides';
import { PptxSlides } from './PptxSlides';
import { SlidesEditor } from './SlidesEditor';
import { useT } from '@/lib/prefs';

interface SlidesViewerProps {
  source: string;
  meta: Record<string, unknown>;
  fileId: string | null;
  fileName: string;
  onProgress(percent: number): void;
  onReady(): void;
}

interface OutlineEntry {
  index: number;
  title: string | null;
  notes: string | null;
}

/**
 * Presentations take one of two routes.
 *
 * With LibreOffice available the deck is rendered to PDF, which keeps the
 * layout the author designed; the outline and speaker notes are still read from
 * the OOXML so the side rail stays useful. Without LibreOffice a built-in
 * the browser draws the deck from the original file with pptx-preview —
 * masters, layouts, shapes, pictures, tables and charts. Should that fail, the
 * server's simplified reading of the slides (slides.json) is shown instead.
 */
export function SlidesViewer({ source, meta, fileId, fileName, onProgress, onReady }: SlidesViewerProps) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const formatId = typeof meta.formatId === 'string' ? meta.formatId : '';
  const editable = Boolean(fileId) && formatId === 'pptx';
  const mode = meta.mode === 'native' ? 'native' : 'rendered';
  const outline = Array.isArray(meta.outline) ? (meta.outline as OutlineEntry[]) : [];

  const [currentPage, setCurrentPage] = useState(1);
  const [gotoPage, setGotoPage] = useState<number | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [document, setDocument] = useState<SlideDocument | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [richFailed, setRichFailed] = useState(false);
  const onRichError = useCallback(() => setRichFailed(true), []);
  // Every PowerPoint Open XML deck (formatId pptx covers shows and templates).
  const rich = mode === 'native' && Boolean(fileId) && formatId === 'pptx' && !richFailed;

  useEffect(() => {
    if (mode !== 'native' || rich) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetchApi(source);
        if (!response.ok) throw new Error(`http ${response.status}`);
        const parsed = (await response.json()) as SlideDocument;
        if (cancelled) return;
        setDocument(parsed);
        onReady();
      } catch {
        if (!cancelled) {
          setError({
            message: "We couldn't load this presentation.",
            hint: 'The document may have expired. Try uploading it again.',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, onReady, rich, source]);

  const onPageChange = useCallback((page: number) => setCurrentPage(page), []);

  const notes = outline.find((entry) => entry.index === currentPage)?.notes ?? null;

  if (error) return <ErrorPanel error={{ code: 'slides_failed', ...error, retryable: false }} />;
  if (editing && fileId) return <SlidesEditor fileId={fileId} fileName={fileName} onClose={() => setEditing(false)} />;

  const rail = (
    <SlideRail
      outline={outline}
      slideCount={typeof meta.slideCount === 'number' ? meta.slideCount : outline.length}
      currentPage={currentPage}
      onEdit={fileId ? () => setEditing(true) : null}
      editable={editable}
      onSelect={(page) => {
        setGotoPage(page);
        setCurrentPage(page);
        // Reset so selecting the same slide twice still scrolls to it.
        window.setTimeout(() => setGotoPage(null), 60);
      }}
    />
  );

  if (rich && fileId) {
    return (
      <div className="flex min-h-0 flex-1">
        <PptxSlides
          fileId={fileId}
          outline={outline}
          onEdit={() => setEditing(true)}
          editable={editable}
          onReady={onReady}
          onError={onRichError}
        />
        <ViewerAdRail />
      </div>
    );
  }

  if (mode === 'native') {
    if (!document) {
      return <div className="grid min-h-0 flex-1 place-items-center text-sm text-mist-400">{t('Loading slides…')}</div>;
    }
    return (
      <div className="flex min-h-0 flex-1">
        {rail}
        <NativeSlides
          document={document}
          currentSlide={currentPage}
          onSlideChange={setCurrentPage}
          notesOpen={notesOpen}
          onNotesToggle={() => setNotesOpen((open) => !open)}
        />
        <ViewerAdRail />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PdfViewer
        source={source}
        fileName="Presentation"
        variant="slides"
        onProgress={onProgress}
        onReady={onReady}
        onPageChange={onPageChange}
        gotoPage={gotoPage}
        sidebar={rail}
        toolbarExtras={
          notes !== null ? (
            <button
              type="button"
              onClick={() => setNotesOpen((open) => !open)}
              data-active={notesOpen ? 'true' : undefined}
              className="btn btn-ghost shrink-0"
              data-testid="slides-notes-toggle"
            >
              {t('Notes')}
            </button>
          ) : null
        }
      />
      {notesOpen && (
        <div className="max-h-40 shrink-0 overflow-auto border-t border-line bg-ink-850 px-4 py-3">
          <h2 className="field-label">{t('Speaker notes · slide {n}', { n: currentPage })}</h2>
          <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-mist-300">
            {notes ?? t('No notes on this slide.')}
          </p>
        </div>
      )}
    </div>
  );
}

function SlideRail({
  outline,
  slideCount,
  currentPage,
  onSelect,
  onEdit,
  editable,
}: {
  outline: OutlineEntry[];
  slideCount: number;
  currentPage: number;
  onSelect(page: number): void;
  onEdit: (() => void) | null;
  editable: boolean;
}) {
  const { t } = useT();
  const count = Math.max(slideCount, outline.length, 1);
  return (
    <aside className="hidden w-52 shrink-0 flex-col border-r border-line bg-ink-850 md:flex">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <h2 className="field-label">{t('Slides')}</h2>
        {onEdit && (
          <button
            type="button"
            className="btn btn-primary !px-2 !py-1 text-[12px]"
            onClick={onEdit}
            disabled={!editable}
            title={editable ? t('Edit the text and delete slides, then save to your computer') : t('Editing works on .docx, .xlsx and .pptx; save older formats in those first.')}
            data-testid="edit-document"
          >
            {t('Edit')}
          </button>
        )}
      </div>
      <ol className="min-h-0 flex-1 overflow-auto py-1" data-testid="slide-rail">
        {Array.from({ length: count }, (_, index) => {
          const number = index + 1;
          const entry = outline.find((item) => item.index === number);
          const active = number === currentPage;
          return (
            <li key={number}>
              <button
                type="button"
                onClick={() => onSelect(number)}
                aria-current={active ? 'true' : undefined}
                className={`flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors ${
                  active ? 'bg-accent-soft/60' : 'hover:bg-ink-800'
                }`}
              >
                <span
                  className={`mt-0.5 w-5 shrink-0 text-right font-mono text-[11px] ${
                    active ? 'text-accent-bright' : 'text-mist-500'
                  }`}
                >
                  {number}
                </span>
                <span className={`min-w-0 flex-1 text-[13px] leading-snug ${active ? 'text-mist-100' : 'text-mist-300'}`}>
                  {entry?.title ? (
                    <span className="line-clamp-2">{entry.title}</span>
                  ) : (
                    <span className="text-mist-500">{t('Slide {n}', { n: number })}</span>
                  )}
                  {entry?.notes && (
                    <span className="mt-0.5 block text-[10px] uppercase tracking-wider text-mist-500">{t('notes')}</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
