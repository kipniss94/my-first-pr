'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { dismissOpenReport, droppedFiles, openFiles, useOpenReport } from '@/lib/open';
import { cancelSession, forgetSession, useSessions, type Session } from '@/lib/session';

/**
 * Everything open in this browser tab, one tab each, so moving between the
 * models dropped in is one click. Hidden while there is only the one.
 */
export function ViewerTabs({ currentId }: { currentId: string }) {
  const router = useRouter();
  const sessions = useSessions();

  const close = useCallback(
    (session: Session) => {
      if (session.id === currentId) {
        const index = sessions.findIndex((s) => s.id === session.id);
        const next = sessions[index + 1] ?? sessions[index - 1];
        if (next) router.replace(`/viewer?s=${next.id}`);
        else router.push('/');
      }
      if (session.phase === 'uploading' || session.phase === 'processing') cancelSession(session.id);
      forgetSession(session.id);
    },
    [currentId, router, sessions],
  );

  if (sessions.length < 2) return null;

  return (
    <nav
      aria-label="Open documents"
      data-testid="viewer-tabs"
      className="flex h-9 shrink-0 items-stretch gap-px overflow-x-auto border-b border-line bg-ink-900"
    >
      {sessions.map((session) => {
        const active = session.id === currentId;
        return (
          <div
            key={session.id}
            className={`group flex max-w-[16rem] shrink-0 items-center border-r border-line ${
              active ? 'bg-ink-850 text-mist-100' : 'text-mist-400 hover:bg-ink-850/60 hover:text-mist-200'
            }`}
          >
            <button
              type="button"
              onClick={() => !active && router.push(`/viewer?s=${session.id}`)}
              aria-current={active ? 'page' : undefined}
              title={session.fileName}
              data-testid="viewer-tab"
              className="flex min-w-0 items-center gap-2 py-1 pl-3 pr-1 text-[12px]"
            >
              <PhaseDot phase={session.phase} />
              <span className="truncate">{session.fileName}</span>
            </button>
            <button
              type="button"
              onClick={() => close(session)}
              aria-label={`Close ${session.fileName}`}
              title="Close"
              className="mr-1.5 grid h-5 w-5 shrink-0 place-items-center rounded text-mist-500 opacity-60 hover:bg-ink-700 hover:text-mist-100 group-hover:opacity-100"
            >
              <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="m3 3 6 6M9 3 3 9" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        );
      })}
    </nav>
  );
}

function PhaseDot({ phase }: { phase: Session['phase'] }) {
  const className =
    phase === 'ready'
      ? 'bg-ok'
      : phase === 'error'
        ? 'bg-danger'
        : phase === 'cancelled'
          ? 'bg-ink-600'
          : 'bg-accent animate-pulse';
  return <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${className}`} />;
}

/**
 * Files dropped anywhere on the viewer open too — beside what is open, not
 * instead of it, whether that opened or failed. A drop a panel already took
 * (the assembly's component box) is left to it.
 */
export function useViewerDrop(): boolean {
  const router = useRouter();
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    const hasFiles = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes('Files'));
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const onDragLeave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      depth.current = 0;
      setDragging(false);
      if (event.defaultPrevented || !hasFiles(event)) return;
      event.preventDefault();
      void droppedFiles(event.dataTransfer).then(({ files, fromFolder }) =>
        openFiles(files, {
          fromFolder,
          navigate: (sessionId, replace) =>
            replace ? router.replace(`/viewer?s=${sessionId}`) : router.push(`/viewer?s=${sessionId}`),
        }),
      );
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [router]);

  return dragging;
}

/** A hint while files are dragged over the viewer. It never takes the drop. */
export function ViewerDropHint() {
  return (
    <div
      aria-hidden="true"
      data-testid="viewer-drop-hint"
      className="pointer-events-none fixed inset-0 z-50 border-2 border-dashed border-accent/70 bg-accent/5"
    >
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-xl border border-accent/50 bg-ink-900/95 px-5 py-3 text-center shadow-lg">
        <p className="text-[14px] font-medium text-mist-100">Drop to open in new tabs</p>
        <p className="mt-0.5 text-[12px] text-mist-400">
          Parts an open assembly is missing go into it; the rest open beside it.
        </p>
      </div>
    </div>
  );
}

/** What the last drop put together, and what is still missing. */
export function OpenReportBanner() {
  const report = useOpenReport();
  const [copied, setCopied] = useState<string | null>(null);
  if (!report) return null;

  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  return (
    <div role="status" data-testid="open-report" className="shrink-0 border-b border-line bg-ink-850 px-4 py-2.5">
      <div className="flex items-start gap-3">
        <ul className="min-w-0 flex-1 space-y-1.5 text-[12px] leading-relaxed">
          {report.assemblies.map((assembly) => (
            <li key={assembly.sessionId}>
              <span className="font-medium text-mist-100">{assembly.name}</span>
              {assembly.total === 0 ? (
                <span className="text-mist-400"> — every part is saved inside the assembly.</span>
              ) : assembly.missing.length === 0 ? (
                <span className="text-ok"> — all {assembly.total} part files are here.</span>
              ) : (
                <>
                  <span className="text-warn">
                    {' '}
                    — {assembly.total - assembly.missing.length} of {assembly.total} part files are here; missing{' '}
                    {assembly.missing.length}:
                  </span>{' '}
                  <span className="break-words text-mist-300" data-testid="open-report-missing">
                    {assembly.missing.join(', ')}
                  </span>{' '}
                  <button
                    type="button"
                    onClick={() => copy(assembly.sessionId, assembly.missing.join('\n'))}
                    className="text-accent underline underline-offset-2"
                  >
                    {copied === assembly.sessionId ? 'Copied' : 'Copy the list'}
                  </button>
                </>
              )}
            </li>
          ))}
          {report.folded.map((entry) => (
            <li key={entry.name} className="text-mist-400">
              <span className="text-mist-200">{entry.name}</span> is a sub-assembly of{' '}
              <span className="text-mist-200">{entry.into}</span>; its parts are shown there, in place.
            </li>
          ))}
          {report.refused.length > 0 && <li className="text-mist-400">Not opened: {report.refused.join(' ')}</li>}
        </ul>
        <button
          type="button"
          onClick={dismissOpenReport}
          aria-label="Dismiss"
          className="grid h-6 w-6 shrink-0 place-items-center rounded text-mist-500 hover:bg-ink-700 hover:text-mist-100"
        >
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="m3 3 6 6M9 3 3 9" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
