'use client';

import { useCallback } from 'react';
import { PdfViewer } from '@/components/pdf/PdfViewer';

/**
 * The "exact page layout" view.
 *
 * Word and Excel open through the fast structural readers; this renders the
 * printed layout instead, produced on demand by the server so the common path
 * never waits for a full conversion. If the rendition cannot be built, the PDF
 * viewer shows its own error and this bar still offers the way back.
 */
export function PageLayoutToggle({
  source,
  label,
  onBack,
}: {
  source: string;
  label: string;
  onBack(): void;
}) {
  const noop = useCallback(() => undefined, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-ink-850 px-3">
        <button type="button" onClick={onBack} className="btn btn-ghost" data-testid="page-layout-back">
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="M9.5 3.5 5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back to the {label}
        </button>
        <span className="hidden text-[12px] text-mist-500 sm:inline">
          Exact page layout, rendered by LibreOffice
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
        <PdfViewer source={source} fileName="Page layout" onProgress={noop} onReady={noop} />
      </div>
    </div>
  );
}
