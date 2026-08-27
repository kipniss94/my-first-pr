'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import type { JobState } from '@docuview/shared';
import { apiUrl, deleteFile } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { cancelSession, forgetSession, markViewerStage, type Session } from '@/lib/session';
import { Logo } from '@/components/site/SiteChrome';
import { ErrorPanel, WarningList } from './ErrorPanel';
import { StageRail } from './StageRail';

/**
 * Viewers are loaded on demand. three.js and PDF.js together are several
 * megabytes; a visitor who only opens a spreadsheet must never download them.
 */
const loading = () => <ViewerSkeleton />;

const CadViewer = dynamic(() => import('@/components/cad/CadViewer').then((m) => m.CadViewer), { ssr: false, loading });
const DxfViewer = dynamic(() => import('@/components/cad/DxfViewer').then((m) => m.DxfViewer), { ssr: false, loading });
const PdfViewer = dynamic(() => import('@/components/pdf/PdfViewer').then((m) => m.PdfViewer), { ssr: false, loading });
const WordViewer = dynamic(() => import('@/components/office/WordViewer').then((m) => m.WordViewer), { ssr: false, loading });
const SheetViewer = dynamic(() => import('@/components/office/SheetViewer').then((m) => m.SheetViewer), { ssr: false, loading });
const SlidesViewer = dynamic(() => import('@/components/office/SlidesViewer').then((m) => m.SlidesViewer), { ssr: false, loading });
const ImageViewer = dynamic(() => import('@/components/office/ImageViewer').then((m) => m.ImageViewer), { ssr: false, loading });

function ViewerSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <div className="flex items-center gap-3 text-sm text-mist-400">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-600 border-t-accent" />
        Loading viewer…
      </div>
    </div>
  );
}

export function ViewerShell({ session }: { session: Session }) {
  const router = useRouter();
  const [dismissedWarnings, setDismissedWarnings] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const job = session.job;
  const result = job?.result ?? null;

  const onCancel = useCallback(() => {
    cancelSession(session.id);
    router.push('/#upload');
  }, [router, session.id]);

  const onDelete = useCallback(async () => {
    if (!session.fileId) return;
    setDeleting(true);
    try {
      await deleteFile(session.fileId);
    } catch {
      /* the sweeper will remove it regardless */
    }
    forgetSession(session.id);
    router.push('/#upload');
  }, [router, session.fileId, session.id]);

  const onViewerReady = useCallback(() => markViewerStage(session.id, 'ready', 100), [session.id]);
  const onViewerLoading = useCallback(
    (percent: number) => markViewerStage(session.id, 'loading-viewer', percent),
    [session.id],
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-ink-900">
      <ViewerHeader
        session={session}
        job={job}
        onDelete={onDelete}
        deleting={deleting}
      />

      {result && !dismissedWarnings && (
        <WarningList warnings={result.warnings} onDismiss={() => setDismissedWarnings(true)} />
      )}

      {session.phase === 'error' && session.error && (
        <ErrorPanel error={session.error} fileName={session.fileName} onRetry={() => router.push('/#upload')} />
      )}

      {session.phase === 'cancelled' && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
          <p className="text-[15px] text-mist-300">This document was cancelled.</p>
          <Link href="/#upload" className="btn btn-primary">
            Upload another file
          </Link>
        </div>
      )}

      {(session.phase === 'uploading' || session.phase === 'processing') && (
        <StageRail session={session} onCancel={onCancel} />
      )}

      {session.phase === 'ready' && result && (
        <div className="flex min-h-0 flex-1">
          {result.viewer === 'cad-nmg' && (
            <CadViewer
              source={result.source}
              meta={result.meta}
              mode="nmg"
              fileName={session.fileName}
              onProgress={onViewerLoading}
              onReady={onViewerReady}
            />
          )}
          {result.viewer === 'cad-mesh' && (
            <CadViewer
              source={result.source}
              meta={result.meta}
              mode="mesh"
              fileName={session.fileName}
              onProgress={onViewerLoading}
              onReady={onViewerReady}
            />
          )}
          {result.viewer === 'cad-dxf' && (
            <DxfViewer source={result.source} onProgress={onViewerLoading} onReady={onViewerReady} />
          )}
          {result.viewer === 'pdf' && (
            <PdfViewer source={result.source} fileName={session.fileName} onProgress={onViewerLoading} onReady={onViewerReady} />
          )}
          {result.viewer === 'office-word' && (
            <WordViewer source={result.source} meta={result.meta} fileId={session.fileId} onReady={onViewerReady} />
          )}
          {result.viewer === 'office-sheet' && (
            <SheetViewer source={result.source} meta={result.meta} fileId={session.fileId} onReady={onViewerReady} />
          )}
          {result.viewer === 'office-slides' && (
            <SlidesViewer source={result.source} meta={result.meta} onProgress={onViewerLoading} onReady={onViewerReady} />
          )}
          {result.viewer === 'image' && <ImageViewer source={result.source} onReady={onViewerReady} />}
          {result.viewer === 'none' && (
            <ErrorPanel
              error={{
                code: 'no_viewer',
                message: "We recognised this file but don't have a viewer for it yet.",
                retryable: false,
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ViewerHeader({
  session,
  job,
  onDelete,
  deleting,
}: {
  session: Session;
  job: JobState | null;
  onDelete: () => void;
  deleting: boolean;
}) {
  const format = job?.format;
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-ink-850 px-3 sm:px-4">
      <Logo compact />
      <div className="mx-1 h-5 w-px shrink-0 bg-line" />

      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <h1 className="truncate text-sm font-medium text-mist-100" title={session.fileName} data-testid="file-name">
          {session.fileName}
        </h1>
        {format && (
          <span className="hidden shrink-0 items-center gap-1.5 rounded-md border border-line bg-ink-800 px-2 py-0.5 text-[11px] text-mist-400 sm:inline-flex">
            <span className="font-medium text-mist-200">{format.label}</span>
            {format.version && <span className="text-mist-500">{format.version}</span>}
          </span>
        )}
        {session.fileSize > 0 && (
          <span className="hidden shrink-0 text-[11px] text-mist-500 md:inline">{formatBytes(session.fileSize)}</span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {session.fileId && (
          <a
            href={apiUrl(`/api/v1/files/${session.fileId}/raw?download=1`)}
            download={session.fileName}
            className="btn-icon"
            title="Download the original file"
            aria-label="Download the original file"
          >
            <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="M10 3v9m0 0 3.5-3.5M10 12 6.5 8.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M3.5 13v2A1.5 1.5 0 0 0 5 16.5h10a1.5 1.5 0 0 0 1.5-1.5v-2" strokeLinecap="round" />
            </svg>
          </a>
        )}
        {session.fileId && (
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            className="btn-icon"
            title="Delete this document from the server now"
            aria-label="Delete this document from the server now"
          >
            <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="M4 6h12M8.5 6V4.5h3V6M6 6l.7 9.1a1.5 1.5 0 0 0 1.5 1.4h3.6a1.5 1.5 0 0 0 1.5-1.4L15 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <Link href="/#upload" className="btn btn-subtle ml-1">
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M8 3.5v9M3.5 8h9" strokeLinecap="round" />
          </svg>
          <span className="hidden sm:inline">New file</span>
        </Link>
      </div>
    </header>
  );
}
