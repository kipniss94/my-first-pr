'use client';

import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useT } from '@/lib/prefs';

interface PdfThumbnailsProps {
  document: PDFDocumentProxy | null;
  pageCount: number;
  currentPage: number;
  onSelect(page: number): void;
  /** While editing: pages to delete, and the switch for each. */
  deletedPages?: Set<number> | null;
  onToggleDelete?(page: number): void;
}

const THUMBNAIL_WIDTH = 132;

/** The page rail. Thumbnails render lazily, one at a time, in page order. */
export function PdfThumbnails({ document: pdf, pageCount, currentPage, onSelect, deletedPages, onToggleDelete }: PdfThumbnailsProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const { t } = useT();

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(`[data-thumb="${currentPage}"]`);
    active?.scrollIntoView({ block: 'nearest' });
  }, [currentPage]);

  return (
    <aside className="hidden w-40 shrink-0 flex-col border-r border-line bg-ink-850 sm:flex">
      <h2 className="border-b border-line px-3 py-2.5 field-label">{t('Pages')}</h2>
      <ul ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-auto p-2" data-testid="pdf-thumbnails">
        {Array.from({ length: pageCount }, (_, index) => (
          <li key={index + 1} data-thumb={index + 1} className={`relative ${deletedPages?.has(index + 1) ? 'opacity-40' : ''}`}>
            <button
              type="button"
              onClick={() => onSelect(index + 1)}
              className={`block w-full rounded-md border p-1 transition-colors ${
                currentPage === index + 1 ? 'border-accent bg-accent-soft/50' : 'border-line hover:border-line-strong'
              }`}
              aria-current={currentPage === index + 1 ? 'page' : undefined}
            >
              <Thumbnail document={pdf} pageNumber={index + 1} />
              <span className="mt-1 block text-center font-mono text-[11px] text-mist-400">{index + 1}</span>
            </button>
            {deletedPages && onToggleDelete && (
              <button
                type="button"
                onClick={() => onToggleDelete(index + 1)}
                title={deletedPages.has(index + 1) ? t('Keep this page') : t('Delete this page')}
                aria-label={deletedPages.has(index + 1) ? t('Keep this page') : t('Delete this page')}
                className={`absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-md text-[13px] font-semibold shadow ${
                  deletedPages.has(index + 1) ? 'bg-ink-700 text-mist-100' : 'bg-red-600 text-white hover:bg-red-700'
                }`}
                data-testid="pdf-delete-page"
              >
                {deletedPages.has(index + 1) ? '↺' : '×'}
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
