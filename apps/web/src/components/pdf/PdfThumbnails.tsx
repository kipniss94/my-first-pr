'use client';

import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

interface PdfThumbnailsProps {
  document: PDFDocumentProxy | null;
  pageCount: number;
  currentPage: number;
  onSelect(page: number): void;
  /** Pages picked for deletion; absent when the document cannot be edited. */
  selected?: Set<number>;
  /** Ctrl/⌘-click adds a page to the selection, Shift-click selects a range. */
  onSelectExtend?(page: number, mode: 'toggle' | 'range'): void;
  /** Delete this page — or the whole selection, when the page is part of it. */
  onDelete?(page: number): void;
}

const THUMBNAIL_WIDTH = 132;

/** The page rail. Thumbnails render lazily, one at a time, in page order. */
export function PdfThumbnails({
  document: pdf,
  pageCount,
  currentPage,
  onSelect,
  selected,
  onSelectExtend,
  onDelete,
}: PdfThumbnailsProps) {
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(`[data-thumb="${currentPage}"]`);
    active?.scrollIntoView({ block: 'nearest' });
  }, [currentPage]);

  return (
    <aside className="hidden w-40 shrink-0 flex-col border-r border-line bg-ink-850 sm:flex">
      <h2 className="border-b border-line px-3 py-2.5 field-label">Pages</h2>
      <ul ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-auto p-2" data-testid="pdf-thumbnails">
        {Array.from({ length: pageCount }, (_, index) => (
          <li key={index + 1} data-thumb={index + 1} className="group relative">
            <button
              type="button"
              onClick={(event) => {
                if (onSelectExtend && (event.ctrlKey || event.metaKey)) onSelectExtend(index + 1, 'toggle');
                else if (onSelectExtend && event.shiftKey) onSelectExtend(index + 1, 'range');
                else onSelect(index + 1);
              }}
              className={`block w-full rounded-md border p-1 transition-colors ${
                selected?.has(index + 1)
                  ? 'border-accent bg-accent-soft ring-2 ring-accent/60'
                  : currentPage === index + 1
                    ? 'border-accent bg-accent-soft/50'
                    : 'border-line hover:border-line-strong'
              }`}
              aria-current={currentPage === index + 1 ? 'page' : undefined}
              aria-pressed={selected ? selected.has(index + 1) : undefined}
            >
              <Thumbnail document={pdf} pageNumber={index + 1} />
              <span className="mt-1 block text-center font-mono text-[11px] text-mist-400">{index + 1}</span>
            </button>
            {onDelete && (
              <button
                type="button"
                onClick={() => onDelete(index + 1)}
                className={`absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-md border border-danger/40 bg-ink-900/90 text-danger shadow transition-opacity hover:bg-danger hover:text-white focus:opacity-100 ${
                  selected?.has(index + 1) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}
                title={selected?.has(index + 1) && selected.size > 1 ? `Delete ${selected.size} pages` : `Delete page ${index + 1}`}
                aria-label={`Delete page ${index + 1}`}
                data-testid={`delete-page-${index + 1}`}
              >
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                  <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}

function Thumbnail({ document: pdf, pageNumber }: { document: PDFDocumentProxy | null; pageNumber: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [ratio, setRatio] = useState(1.294); // A4 portrait until we know better

  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) setVisible(true);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !pdf) return;
    let cancelled = false;

    (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      setRatio(base.height / base.width);
      const viewport = page.getViewport({ scale: THUMBNAIL_WIDTH / base.width });
      const canvas = canvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) return;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
    })().catch(() => {
      /* a thumbnail that fails to draw is not worth an error */
    });

    return () => {
      cancelled = true;
    };
  }, [pdf, pageNumber, visible]);

  return (
    <div
      ref={wrapperRef}
      className="w-full overflow-hidden rounded-sm bg-white"
      style={{ aspectRatio: `1 / ${ratio}` }}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
