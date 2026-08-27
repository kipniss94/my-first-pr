'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SlideDocument } from '@docuview/shared';
import { apiUrl } from '@/lib/api';
import { ErrorPanel } from '@/components/viewer/ErrorPanel';
import { PdfViewer } from '@/components/pdf/PdfViewer';
import { ViewerAdRail } from '@/components/site/AdSlot';
import { NativeSlides } from './NativeSlides';

interface SlidesViewerProps {
  source: string;
  meta: Record<string, unknown>;
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
 * renderer draws the slides from the file itself — less faithful, and labelled
 * as such.
 */
export function SlidesViewer({ source, meta, onProgress, onReady }: SlidesViewerProps) {
  const mode = meta.mode === 'native' ? 'native' : 'rendered';
  const outline = Array.isArray(meta.outline) ? (meta.outline as OutlineEntry[]) : [];

  const [currentPage, setCurrentPage] = useState(1);
  const [gotoPage, setGotoPage] = useState<number | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [document, setDocument] = useState<SlideDocument | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);

  useEffect(() => {
    if (mode !== 'native') return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(apiUrl(source));
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
  }, [mode, onReady, source]);

  const onPageChange = useCallback((page: number) => setCurrentPage(page), []);

  const notes = outline.find((entry) => entry.index === currentPage)?.notes ?? null;

  if (error) return <ErrorPanel error={{ code: 'slides_failed', ...error, retryable: false }} />;

  const rail = (
    <SlideRail
      outline={outline}
      slideCount={typeof meta.slideCount === 'number' ? meta.slideCount : outline.length}
      currentPage={currentPage}
      onSelect={(page) => {
        setGotoPage(page);
        setCurrentPage(page);
        // Reset so selecting the same slide twice still scrolls to it.
        window.setTimeout(() => setGotoPage(null), 60);
      }}
    />
  );

  if (mode === 'native') {
    if (!document) {
      return <div className="grid min-h-0 flex-1 place-items-center text-sm text-mist-400">Loading slides…</div>;
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
              Notes
            </button>
          ) : null
        }
      />
      {notesOpen && (
        <div className="max-h-40 shrink-0 overflow-auto border-t border-line bg-ink-850 px-4 py-3">
          <h2 className="field-label">Speaker notes · slide {currentPage}</h2>
          <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-mist-300">
            {notes ?? 'No notes on this slide.'}
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
}: {
  outline: OutlineEntry[];
  slideCount: number;
  currentPage: number;
  onSelect(page: number): void;
}) {
  const count = Math.max(slideCount, outline.length, 1);
  return (
    <aside className="hidden w-52 shrink-0 flex-col border-r border-line bg-ink-850 md:flex">
      <h2 className="border-b border-line px-3 py-2.5 field-label">Slides</h2>
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
                    <span className="text-mist-500">Slide {number}</span>
                  )}
                  {entry?.notes && (
                    <span className="mt-0.5 block text-[10px] uppercase tracking-wider text-mist-500">notes</span>
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
