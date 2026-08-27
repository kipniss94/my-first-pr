'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiUrl } from '@/lib/api';
import { formatCount } from '@/lib/format';
import { ErrorPanel } from '@/components/viewer/ErrorPanel';
import { ViewerAdRail } from '@/components/site/AdSlot';
import { PageLayoutToggle } from './PageLayoutToggle';

interface WordViewerProps {
  source: string;
  meta: Record<string, unknown>;
  fileId: string | null;
  onReady(): void;
}

const WIDTHS = {
  comfortable: 'max-w-[42rem]',
  wide: 'max-w-[58rem]',
  full: 'max-w-none',
} as const;

type WidthKey = keyof typeof WIDTHS;

export function WordViewer({ source, meta, fileId, onReady }: WordViewerProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [width, setWidth] = useState<WidthKey>('comfortable');
  const [fontScale, setFontScale] = useState(1);
  const [showPageLayout, setShowPageLayout] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(apiUrl(source));
        if (!response.ok) throw new Error(`http ${response.status}`);
        // Served as text/plain on purpose: the browser must never execute this
        // markup by navigating to the asset URL directly.
        const text = await response.text();
        if (cancelled) return;
        setHtml(text);
        onReady();
      } catch {
        if (!cancelled) {
          setError({
            message: "We couldn't load this document.",
            hint: 'The document may have expired. Try uploading it again.',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onReady, source]);

  const pdfRendition = typeof meta.pdfRendition === 'string' ? meta.pdfRendition : null;
  const words = typeof meta.words === 'number' ? meta.words : null;
  const images = typeof meta.images === 'number' ? meta.images : null;

  const isEmpty = useMemo(() => html !== null && html.replace(/<[^>]+>/g, '').trim().length === 0, [html]);

  if (error) return <ErrorPanel error={{ code: 'word_failed', ...error, retryable: false }} />;

  if (showPageLayout && pdfRendition && fileId) {
    return <PageLayoutToggle source={pdfRendition} label="document" onBack={() => setShowPageLayout(false)} />;
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-3 overflow-x-auto border-b border-line bg-ink-850 px-3">
          {words !== null && (
            <span className="shrink-0 whitespace-nowrap text-[12px] text-mist-400">
              {formatCount(words)} words
              {images ? ` · ${formatCount(images)} image${images === 1 ? '' : 's'}` : ''}
            </span>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <div className="flex items-center rounded-lg border border-line bg-ink-800 p-0.5">
              {(Object.keys(WIDTHS) as WidthKey[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setWidth(key)}
                  aria-pressed={width === key}
                  className={`rounded-md px-2.5 py-1 text-[12px] font-medium capitalize transition-colors ${
                    width === key ? 'bg-ink-600 text-mist-100' : 'text-mist-400 hover:text-mist-200'
                  }`}
                >
                  {key}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                className="btn-icon"
                onClick={() => setFontScale((value) => Math.max(0.8, value - 0.1))}
                aria-label="Smaller text"
              >
                <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
                  <path d="M4 8h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
              <button
                type="button"
                className="btn-icon"
                onClick={() => setFontScale((value) => Math.min(1.8, value + 0.1))}
                aria-label="Larger text"
              >
                <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
                  <path d="M8 4v8M4 8h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            {pdfRendition && (
              <button
                type="button"
                onClick={() => setShowPageLayout(true)}
                className="btn btn-ghost"
                data-testid="word-page-layout"
              >
                Page layout
              </button>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-paper-2 py-8">
          {html === null ? (
            <div className="mx-auto max-w-[42rem] space-y-3 px-6">
              {[...Array(6)].map((_, index) => (
                <div key={index} className="skeleton h-4 rounded" style={{ width: `${70 + ((index * 13) % 30)}%` }} />
              ))}
            </div>
          ) : isEmpty ? (
            <p className="mx-auto max-w-[42rem] px-6 text-center text-sm text-paper-muted">
              This document appears to be empty.
            </p>
          ) : (
            <article
              className={`doc-content mx-auto rounded-xl bg-paper px-8 py-10 shadow-[0_1px_20px_-8px_rgba(0,0,0,0.25)] sm:px-12 ${WIDTHS[width]}`}
              style={{ fontSize: `${fontScale}rem` }}
              data-testid="word-content"
              // The markup was generated by the server's converter and passed
              // through an allowlist sanitiser before it was stored.
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </div>
      </div>

      <ViewerAdRail />
    </div>
  );
}
