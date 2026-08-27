'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { attachToJob, getSession, useSession } from '@/lib/session';
import { ViewerShell } from '@/components/viewer/ViewerShell';
import { Dropzone } from '@/components/upload/Dropzone';
import { Logo } from '@/components/site/SiteChrome';

export default function ViewerPage() {
  return (
    <Suspense fallback={<Booting />}>
      <ViewerRoute />
    </Suspense>
  );
}

function ViewerRoute() {
  const params = useSearchParams();
  const sessionParam = params.get('s');
  const jobParam = params.get('job');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);

  /*
   * Two ways in, in priority order:
   *  - `?s=` is an upload started in this tab, still held in memory.
   *  - `?job=` is a document the server still has, which survives a reload or a
   *    shared link.
   *
   * After a reload the `?s=` value is stale — the store was wiped — so it is
   * only honoured when a session with that id actually exists. Getting this
   * wrong leaves the page stuck on "Opening…" forever.
   */
  useEffect(() => {
    if (sessionParam && getSession(sessionParam)) {
      setSessionId(sessionParam);
      setResolved(true);
      return;
    }
    if (jobParam) {
      setSessionId(attachToJob(jobParam));
      setResolved(true);
      return;
    }
    setSessionId(null);
    setResolved(true);
  }, [jobParam, sessionParam]);

  const session = useSession(sessionId);

  // Keep a shareable, reload-safe URL and drop the stale in-memory id.
  useEffect(() => {
    if (!session?.jobId) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('job') === session.jobId && !url.searchParams.has('s')) return;
    url.searchParams.set('job', session.jobId);
    url.searchParams.delete('s');
    window.history.replaceState(null, '', url.toString());
  }, [session?.jobId]);

  if (resolved && !sessionId) return <EmptyState />;
  if (!session) return <Booting />;

  return <ViewerShell session={session} />;
}

function Booting() {
  return (
    <div className="grid h-dvh place-items-center bg-ink-900">
      <div className="flex items-center gap-3 text-sm text-mist-400">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-600 border-t-accent" />
        Opening…
      </div>
    </div>
  );
}

/**
 * Reached by opening /viewer directly, or after a document has expired. Rather
 * than bouncing the visitor to the home page, offer the upload box right here.
 */
function EmptyState() {
  return (
    <div className="flex min-h-dvh flex-col bg-ink-900">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-ink-850 px-4">
        <Logo />
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-xl">
          <h1 className="text-center text-2xl font-semibold tracking-tight text-mist-100">
            No document open
          </h1>
          <p className="mx-auto mt-2 max-w-md text-center text-sm leading-relaxed text-mist-400">
            Documents live for the length of a session. Upload a file to open the viewer.
          </p>
          <div className="mt-8">
            <Dropzone compact />
          </div>
          <p className="mt-6 text-center text-sm">
            <Link href="/" className="link-quiet underline underline-offset-4">
              Back to the home page
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
