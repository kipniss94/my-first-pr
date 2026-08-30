'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { apiUrl } from '@/lib/api';
import { formatCount } from '@/lib/format';
import { captureWhenDrawn } from '@/lib/thumbnail';
import { ErrorPanel } from '@/components/viewer/ErrorPanel';
import { ViewerAdRail } from '@/components/site/AdSlot';
import { PdfPage } from './PdfPage';
import { PdfThumbnails } from './PdfThumbnails';

interface PdfViewerProps {
  source: string;
  fileName: string;
  onProgress(percent: number): void;
  onReady(): void;
  /** Slide decks reuse this viewer with a different chrome. */
  variant?: 'document' | 'slides';
  /** Extra controls rendered into the toolbar by the slides wrapper. */
  toolbarExtras?: React.ReactNode;
  sidebar?: React.ReactNode;
  onPageChange?(page: number): void;
  /** Externally requested page, used by the slide rail. */
  gotoPage?: number | null;
  /** Receives a PNG data URL of page one, for the workspace card. */
  onThumbnail?(dataUrl: string): void;
}

export type ZoomMode = 'fit-width' | 'fit-page' | 'custom';

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export interface SearchMatch {
  page: number;
  index: number;
  snippet: string;
}

export function PdfViewer({
  source,
  fileName,
  onProgress,
  onReady,
  variant = 'document',
  toolbarExtras,
  sidebar,
  onPageChange,
  gotoPage,
  onThumbnail,
}: PdfViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [document_, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit-width');
  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [firstPageSize, setFirstPageSize] = useState<{ width: number; height: number } | null>(null);
  // Page thumbnails are open by default: they are how people navigate a
  // document they did not write.
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<SearchMatch[] | null>(null);
  const [activeMatch, setActiveMatch] = useState(0);
  const [searching, setSearching] = useState(false);

  /* -------------------------------- loading ------------------------------- */

  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;

    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        // The worker is copied into /public at build time, so it is same-origin
        // and version-locked to the library we just imported.
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

        const task = pdfjs.getDocument({
          url: apiUrl(source),
          // Streaming and range requests keep large files responsive.
          disableAutoFetch: false,
          disableStream: false,
        });
        task.onProgress = ({ loaded: got, total }: { loaded: number; total: number }) => {
          if (total > 0) onProgress(Math.min(99, Math.round((got / total) * 100)));
        };

        loaded = await task.promise;
        if (cancelled) {
          void loaded.destroy();
          return;
        }
        setDocument(loaded);
        setPageCount(loaded.numPages);

        const page = await loaded.getPage(1);
        const viewport = page.getViewport({ scale: 1 });
        if (!cancelled) setFirstPageSize({ width: viewport.width, height: viewport.height });

        onProgress(100);
        onReady();

      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        if (/password/i.test(message)) {
          setError({
            message: 'This PDF is password protected.',
            hint: 'Open it in a PDF application, remove the password, and upload it again.',
          });
        } else if (/InvalidPDF|structure/i.test(message)) {
          setError({
            message: "This PDF appears to be damaged and couldn't be opened.",
            hint: 'Try re-exporting or repairing the file.',
          });
        } else {
          setError({ message: "We couldn't open this PDF.", hint: 'The document may have expired. Try uploading it again.' });
        }
      }
    })();

    return () => {
      cancelled = true;
      void loaded?.destroy();
    };
  }, [onProgress, onReady, source]);

  /*
   * The workspace card is a copy of page one as the reader sees it. Taking it
   * from the canvas the viewer already drew — instead of asking pdf.js to
   * render the page a second time — keeps this well clear of the renderer that
   * owns that page, which is not safe to run twice at once.
   */
  useEffect(() => {
    if (!document_ || !onThumbnail) return;
    return captureWhenDrawn('[data-page="1"] canvas', onThumbnail);
  }, [document_, onThumbnail]);

  /* ------------------------------- sizing --------------------------------- */

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setContainerWidth(element.clientWidth);
      setContainerHeight(element.clientHeight);
    });
    observer.observe(element);
    setContainerWidth(element.clientWidth);
    setContainerHeight(element.clientHeight);
    return () => observer.disconnect();
  }, [document_]);

  const scale = useMemo(() => {
    if (!firstPageSize || containerWidth === 0) return zoom;
    const padding = variant === 'slides' ? 48 : 64;
    if (zoomMode === 'fit-width') return (containerWidth - padding) / firstPageSize.width;
    if (zoomMode === 'fit-page') {
      return Math.min(
        (containerWidth - padding) / firstPageSize.width,
        (containerHeight - padding) / firstPageSize.height,
      );
    }
    return zoom;
  }, [containerHeight, containerWidth, firstPageSize, variant, zoom, zoomMode]);

  /* ------------------------------ navigation ------------------------------ */

  const scrollToPage = useCallback((page: number) => {
    const container = scrollRef.current;
    const target = container?.querySelector<HTMLElement>(`[data-page="${page}"]`);
    if (!container || !target) return;
    container.scrollTo({ top: target.offsetTop - 12, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    if (gotoPage && gotoPage >= 1) scrollToPage(gotoPage);
  }, [gotoPage, scrollToPage]);

  useEffect(() => {
    onPageChange?.(currentPage);
  }, [currentPage, onPageChange]);

  // Track which page occupies the middle of the viewport.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || pageCount === 0) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const middle = container.scrollTop + container.clientHeight / 2;
        const pages = container.querySelectorAll<HTMLElement>('[data-page]');
        let best = 1;
        for (const element of pages) {
          if (element.offsetTop <= middle) best = Number(element.dataset.page);
        }
        setCurrentPage(best);
      });
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [pageCount]);

  /* -------------------------------- search -------------------------------- */

  const runSearch = useCallback(
    async (term: string) => {
      if (!document_ || term.trim().length < 2) {
        setMatches(null);
        return;
      }
      setSearching(true);
      const needle = term.trim().toLowerCase();
      const found: SearchMatch[] = [];
      try {
        for (let page = 1; page <= document_.numPages; page += 1) {
          const proxy = await document_.getPage(page);
          const content = await proxy.getTextContent();
          const text = content.items
            .map((item) => ('str' in item ? item.str : ''))
            .join(' ')
            .replace(/\s+/g, ' ');
          const haystack = text.toLowerCase();
          let from = 0;
          for (;;) {
            const at = haystack.indexOf(needle, from);
            if (at === -1) break;
            found.push({
              page,
              index: at,
              snippet: text.slice(Math.max(0, at - 40), at + needle.length + 40).trim(),
            });
            from = at + needle.length;
            if (found.length > 500) break;
          }
          if (found.length > 500) break;
        }
        setMatches(found);
        setActiveMatch(0);
        if (found.length > 0) scrollToPage(found[0].page);
      } finally {
        setSearching(false);
      }
    },
    [document_, scrollToPage],
  );

  const stepMatch = useCallback(
    (delta: number) => {
      if (!matches || matches.length === 0) return;
      const next = (activeMatch + delta + matches.length) % matches.length;
      setActiveMatch(next);
      scrollToPage(matches[next].page);
    },
    [activeMatch, matches, scrollToPage],
  );

  /* ------------------------------ fullscreen ------------------------------ */

  const rootRef = useRef<HTMLDivElement>(null);
  const toggleFullscreen = useCallback(async () => {
    const element = rootRef.current;
    if (!element) return;
    try {
      if (!window.document.fullscreenElement) {
        await element.requestFullscreen();
      } else {
        await window.document.exitFullscreen();
      }
    } catch {
      /* the browser refused; the button simply does nothing */
    }
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(window.document.fullscreenElement));
    window.document.addEventListener('fullscreenchange', onChange);
    return () => window.document.removeEventListener('fullscreenchange', onChange);
  }, []);

  /* ------------------------------- shortcuts ------------------------------ */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && /^(INPUT|TEXTAREA)$/.test(target.tagName);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (typing) {
        if (event.key === 'Escape') setSearchOpen(false);
        return;
      }
      if (event.key === 'PageDown' || event.key === 'ArrowRight') scrollToPage(Math.min(pageCount, currentPage + 1));
      if (event.key === 'PageUp' || event.key === 'ArrowLeft') scrollToPage(Math.max(1, currentPage - 1));
      if (event.key === 'Home') scrollToPage(1);
      if (event.key === 'End') scrollToPage(pageCount);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentPage, pageCount, scrollToPage]);

  if (error) return <ErrorPanel error={{ code: 'pdf_failed', ...error, retryable: false }} />;

  const highlightPages = new Map<number, string>();
  if (matches && query.trim().length >= 2) {
    for (const match of matches) highlightPages.set(match.page, query.trim());
  }

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 bg-ink-900">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Toolbar */}
        <div className="flex h-12 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line bg-ink-850 px-2">
          <button
            type="button"
            onClick={() => setSidebarOpen((open) => !open)}
            className="btn-icon"
            data-active={sidebarOpen ? 'true' : undefined}
            title={variant === 'slides' ? 'Slide list' : 'Page thumbnails'}
            aria-label={variant === 'slides' ? 'Toggle slide list' : 'Toggle page thumbnails'}
            data-testid="pdf-sidebar-toggle"
          >
            <svg viewBox="0 0 16 16" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <rect x="2.5" y="2.5" width="4" height="11" rx="1" />
              <rect x="8.5" y="2.5" width="5" height="11" rx="1" />
            </svg>
          </button>

          <div className="mx-1 h-5 w-px bg-line" />

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="btn-icon"
              onClick={() => scrollToPage(Math.max(1, currentPage - 1))}
              disabled={currentPage <= 1}
              aria-label="Previous page"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
                <path d="M10 3.5 6 8l4 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const value = Number(new FormData(event.currentTarget).get('page'));
                if (Number.isFinite(value)) scrollToPage(Math.min(pageCount, Math.max(1, value)));
              }}
              className="flex items-center gap-1"
            >
              <input
                name="page"
                key={currentPage}
                defaultValue={currentPage}
                inputMode="numeric"
                className="w-11 rounded-md border border-line bg-ink-800 px-1.5 py-1 text-center font-mono text-[12px] text-mist-100"
                aria-label="Page number"
                data-testid="pdf-page-input"
              />
              <span className="whitespace-nowrap text-[12px] text-mist-500">/ {formatCount(pageCount)}</span>
            </form>
            <button
              type="button"
              className="btn-icon"
              onClick={() => scrollToPage(Math.min(pageCount, currentPage + 1))}
              disabled={currentPage >= pageCount}
              aria-label="Next page"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
                <path d="M6 3.5 10 8l-4 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>

          <div className="mx-1 h-5 w-px bg-line" />

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="btn-icon"
              onClick={() => {
                setZoomMode('custom');
                setZoom((current) => previousStep(current * 0.999));
              }}
              aria-label="Zoom out"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
                <path d="M4 8h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
            <span className="w-11 text-center font-mono text-[12px] tabular-nums text-mist-300">
              {Math.round(scale * 100)}%
            </span>
            <button
              type="button"
              className="btn-icon"
              onClick={() => {
                setZoomMode('custom');
                setZoom((current) => nextStep(current * 1.001));
              }}
              aria-label="Zoom in"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
                <path d="M8 4v8M4 8h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <div className="flex shrink-0 items-center rounded-lg border border-line bg-ink-800 p-0.5">
            <ZoomModeButton active={zoomMode === 'fit-width'} onClick={() => setZoomMode('fit-width')}>
              Fit width
            </ZoomModeButton>
            <ZoomModeButton active={zoomMode === 'fit-page'} onClick={() => setZoomMode('fit-page')}>
              Fit page
            </ZoomModeButton>
          </div>

          {toolbarExtras}

          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="btn-icon"
              data-active={searchOpen ? 'true' : undefined}
              onClick={() => setSearchOpen((open) => !open)}
              title="Search the document (Ctrl+F)"
              aria-label="Search the document"
              data-testid="pdf-search-toggle"
            >
              <svg viewBox="0 0 16 16" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <circle cx="7" cy="7" r="4" />
                <path d="m10.2 10.2 3 3" strokeLinecap="round" />
              </svg>
            </button>
            <button
              type="button"
              className="btn-icon"
              onClick={() => window.open(apiUrl(source), '_blank', 'noopener')}
              title="Print"
              aria-label="Print"
            >
              <svg viewBox="0 0 16 16" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path d="M4.5 6V2.5h7V6M4.5 12H3.5A1 1 0 0 1 2.5 11V7.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1h-1" />
                <rect x="4.5" y="9.5" width="7" height="4" rx="0.5" />
              </svg>
            </button>
            <button
              type="button"
              className="btn-icon"
              onClick={toggleFullscreen}
              data-active={fullscreen ? 'true' : undefined}
              title="Fullscreen"
              aria-label="Toggle fullscreen"
            >
              <svg viewBox="0 0 16 16" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>

        {/* Search bar */}
        {searchOpen && (
          <div className="flex shrink-0 items-center gap-2 border-b border-line bg-ink-800 px-3 py-2">
            <form
              className="flex flex-1 items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void runSearch(query);
              }}
            >
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find in document"
                className="min-w-0 flex-1 rounded-md border border-line bg-ink-850 px-2.5 py-1.5 text-[13px] text-mist-100 placeholder:text-mist-500"
                aria-label="Find in document"
                data-testid="pdf-search-input"
              />
              <button type="submit" className="btn btn-subtle" disabled={searching}>
                {searching ? 'Searching…' : 'Find'}
              </button>
            </form>
            {matches && (
              <div className="flex shrink-0 items-center gap-1.5" data-testid="pdf-search-results">
                <span className="whitespace-nowrap font-mono text-[12px] text-mist-400">
                  {matches.length === 0 ? 'No matches' : `${activeMatch + 1} / ${matches.length}`}
                </span>
                <button type="button" className="btn-icon" onClick={() => stepMatch(-1)} disabled={matches.length === 0} aria-label="Previous match">
                  <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
                    <path d="M3.5 10 8 6l4.5 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <button type="button" className="btn-icon" onClick={() => stepMatch(1)} disabled={matches.length === 0} aria-label="Next match">
                  <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
                    <path d="M3.5 6 8 10l4.5-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            )}
            <button type="button" className="btn-icon shrink-0" onClick={() => setSearchOpen(false)} aria-label="Close search">
              <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          {sidebarOpen &&
            (sidebar ?? (
              <PdfThumbnails
                document={document_}
                pageCount={pageCount}
                currentPage={currentPage}
                onSelect={scrollToPage}
              />
            ))}

          <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-ink-950/60" data-testid="pdf-scroll">
            {document_ ? (
              <div className={`flex flex-col items-center gap-4 ${variant === 'slides' ? 'py-6' : 'py-8'}`}>
                {Array.from({ length: pageCount }, (_, index) => (
                  <PdfPage
                    key={index + 1}
                    document={document_}
                    pageNumber={index + 1}
                    scale={scale}
                    highlight={highlightPages.get(index + 1) ?? null}
                    fallbackSize={firstPageSize}
                  />
                ))}
              </div>
            ) : (
              <div className="grid h-full place-items-center text-sm text-mist-400">Loading {fileName}…</div>
            )}
          </div>
        </div>
      </div>

      <ViewerAdRail />
    </div>
  );
}

function ZoomModeButton({ active, onClick, children }: { active: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`whitespace-nowrap rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
        active ? 'bg-ink-600 text-mist-100' : 'text-mist-400 hover:text-mist-200'
      }`}
    >
      {children}
    </button>
  );
}

function nextStep(value: number): number {
  return ZOOM_STEPS.find((step) => step > value) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
}

function previousStep(value: number): number {
  return [...ZOOM_STEPS].reverse().find((step) => step < value) ?? ZOOM_STEPS[0];
}

export type { PDFDocumentProxy, PDFPageProxy };
