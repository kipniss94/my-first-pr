'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ACCEPTED_EXTENSIONS, type CapabilitiesResponse } from '@docuview/shared';
import { getCapabilities } from '@/lib/api';
import { clearDocuments, removeDocument, useCachedDocuments, type CachedDocument } from '@/lib/cache';
import { formatBytes, formatDuration } from '@/lib/format';
import { droppedFiles, FALLBACK_MAX_BYTES, openFiles } from '@/lib/open';
import { useT } from '@/lib/prefs';
import { openCachedDocument } from '@/lib/session';
import { AdSlot } from '@/components/site/AdSlot';
import { HeaderControls } from '@/components/site/HeaderControls';
import { Logo } from '@/components/site/SiteChrome';
import { DocumentCard } from './DocumentCard';

/**
 * The workspace.
 *
 * This is the whole product on one screen: drop a file anywhere and it opens;
 * everything already opened sits here as a tile and reopens on a click. There
 * is deliberately nothing else — no tabs to choose a viewer from, no format
 * picker, no explanatory copy. The file decides which viewer runs, and the
 * documents themselves are the interface.
 */

const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.join(',');

export function Workspace() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const { documents, loading } = useCachedDocuments();
  const { t, tp, tx } = useT();

  const [capabilities, setCapabilities] = useState<CapabilitiesResponse | null>(null);
  const [serviceDown, setServiceDown] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const dragDepth = useRef(0);

  useEffect(() => {
    let cancelled = false;
    getCapabilities().then(
      (value) => !cancelled && setCapabilities(value),
      () => !cancelled && setServiceDown(true),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const maxBytes = capabilities?.maxUploadBytes ?? FALLBACK_MAX_BYTES;

  /* ------------------------------ opening -------------------------------- */

  // Any number of files, a folder too: each opens in its own tab, and an
  // assembly takes the parts it is made of instead (see lib/open).
  const openMany = useCallback(
    async (files: File[], fromFolder = false) => {
      if (files.length === 0) return;
      setError(null);
      const outcome = await openFiles(files, {
        maxBytes,
        fromFolder,
        navigate: (sessionId, replace) =>
          replace ? router.replace(`/viewer?s=${sessionId}`) : router.push(`/viewer?s=${sessionId}`),
      });
      if (outcome.opened.length > 0 || outcome.refused.length === 0) return;
      setError(
        outcome.refused.length === 1
          ? { message: t(outcome.refused[0].message), hint: outcome.refused[0].hint && t(outcome.refused[0].hint) }
          : {
              message: tp(
                outcome.refused.length,
                ['The file could not be opened.', 'None of the {n} files could be opened.'],
                ['Файл не удалось открыть.', 'Ни один из {n} файлов не удалось открыть.', 'Ни один из {n} файлов не удалось открыть.'],
              ),
              hint: outcome.refused.map((r) => t(r.message)).join(' '),
            },
      );
    },
    [maxBytes, router, t, tp],
  );

  const openCached = useCallback(
    async (document: CachedDocument) => {
      setError(null);
      setOpening(document.id);
      try {
        const sessionId = await openCachedDocument(document);
        if (sessionId) {
          router.push(`/viewer?s=${sessionId}`);
          return;
        }
        setError({
          message: t('“{name}” is no longer in this browser’s cache.', { name: document.name }),
          hint: t('Drop the file again to reopen it.'),
        });
      } finally {
        setOpening(null);
      }
    },
    [router, t],
  );

  /* --------------------------- drop anywhere ------------------------------ */

  useEffect(() => {
    const onDragEnter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    const onDragLeave = (event: DragEvent) => {
      event.preventDefault();
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      void droppedFiles(event.dataTransfer).then(({ files, fromFolder }) => openMany(files, fromFolder));
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
  }, [openMany]);

  /* -------------------------------- view ---------------------------------- */

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return documents;
    return documents.filter((document) => document.name.toLowerCase().includes(needle));
  }, [documents, query]);

  const cachedBytes = useMemo(
    () => documents.reduce((total, document) => total + (document.hasBlob ? document.size : 0), 0),
    [documents],
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-ink-900">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-ink-850 px-4">
        <Logo />
        <div className="mx-1 hidden h-5 w-px bg-line sm:block" />
        <p className="hidden text-[13px] text-mist-400 sm:block">{t('Workspace')}</p>

        <div className="ml-auto flex items-center gap-2">
          {documents.length > 0 && (
            <label className="relative hidden sm:block">
              <span className="sr-only">{t('Filter documents')}</span>
              <svg
                viewBox="0 0 16 16"
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-mist-500"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
              >
                <circle cx="7" cy="7" r="4.2" />
                <path d="m10.2 10.2 3 3" strokeLinecap="round" />
              </svg>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('Filter')}
                data-testid="workspace-filter"
                className="h-8 w-40 rounded-lg border border-line bg-ink-900 pl-8 pr-2.5 text-[13px] text-mist-100 placeholder:text-mist-500 focus:border-accent/60 focus:outline-none"
              />
            </label>
          )}
          <button type="button" onClick={() => inputRef.current?.click()} className="btn btn-primary">
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
              <path d="M8 3.5v9M3.5 8h9" strokeLinecap="round" />
            </svg>
            {t('Open a file')}
          </button>
          <HeaderControls />
        </div>
      </header>

      <main className="relative min-h-0 flex-1 overflow-y-auto">
        {error && (
          <div role="alert" className="mx-auto mt-4 w-full max-w-3xl px-4">
            <div className="rounded-xl border border-danger/35 bg-danger/10 px-4 py-3" data-testid="workspace-error">
              <p className="text-sm font-medium text-mist-100">{error.message}</p>
              {error.hint && <p className="mt-1 text-[13px] text-mist-400">{error.hint}</p>}
            </div>
          </div>
        )}

        {serviceDown && (
          <div role="alert" className="mx-auto mt-4 w-full max-w-3xl px-4">
            <div className="rounded-xl border border-warn/35 bg-warn/10 px-4 py-3">
              <p className="text-sm font-medium text-mist-100">{t('The document service isn’t responding.')}</p>
              <p className="mt-1 text-[13px] text-mist-400">
                {tx('Start it with {command}, which runs both halves of the app.', {
                  command: <code className="font-mono text-mist-300">Start-DocuView.bat</code>,
                })}
              </p>
            </div>
          </div>
        )}

        {loading ? null : documents.length === 0 ? (
          <EmptyDesktop onBrowse={() => inputRef.current?.click()} />
        ) : (
          <section className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6">
            <ul
              className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7"
              data-testid="document-grid"
            >
              {visible.map((document) => (
                <DocumentCard
                  key={document.id}
                  document={document}
                  onOpen={openCached}
                  onRemove={(target) => void removeDocument(target.id)}
                  busy={opening === document.id}
                />
              ))}
              <li>
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  data-testid="add-tile"
                  className="flex w-full flex-col gap-2.5 rounded-xl p-2 text-left"
                >
                  <span className="flex aspect-4/3 items-center justify-center rounded-lg border-2 border-dashed border-line-strong text-mist-500 transition-colors hover:border-accent/60 hover:text-accent">
                    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                      <path d="M12 6v12M6 12h12" strokeLinecap="round" />
                    </svg>
                  </span>
                  <span className="block truncate text-[13px] font-medium text-mist-400">{t('Open a file')}</span>
                </button>
              </li>
            </ul>

            {visible.length === 0 && (
              <p className="mt-8 text-center text-sm text-mist-500">{t('Nothing here matches “{query}”.', { query })}</p>
            )}
          </section>
        )}

        {dragging && <DropOverlay />}
      </main>

      <footer className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-ink-850 px-4 py-2.5 text-[11px] text-mist-500">
        <span>{t('Up to {size} per file', { size: formatBytes(maxBytes) })}</span>
        <span aria-hidden="true">·</span>
        <span>
          {t('Deleted from the server after {time}', { time: formatDuration(capabilities?.retentionSeconds ?? 3600) })}
        </span>
        {documents.length > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span>
              {tp(
                documents.length,
                ['{n} here, {size} kept in this browser', '{n} here, {size} kept in this browser'],
                [
                  '{n} документ, {size} хранится в этом браузере',
                  '{n} документа, {size} хранится в этом браузере',
                  '{n} документов, {size} хранится в этом браузере',
                ],
                { size: formatBytes(cachedBytes) },
              )}
            </span>
            <button
              type="button"
              onClick={() => void clearDocuments()}
              data-testid="clear-workspace"
              className="link-quiet underline underline-offset-2"
            >
              {t('Clear')}
            </button>
          </>
        )}
        <nav aria-label={t('Site')} className="ml-auto flex items-center gap-3">
          <Link href="/about" className="link-quiet">
            {t('About')}
          </Link>
          <Link href="/privacy" className="link-quiet">
            {t('Privacy')}
          </Link>
          <Link href="/terms" className="link-quiet">
            {t('Terms')}
          </Link>
        </nav>
      </footer>

      <div className="flex justify-center empty:hidden">
        <AdSlot placement="footer" className="mb-3" />
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        multiple
        className="sr-only"
        data-testid="file-input"
        onChange={(event) => {
          void openMany(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
    </div>
  );
}

/* ------------------------------- empty state ------------------------------- */

function EmptyDesktop({ onBrowse }: { onBrowse(): void }) {
  const { t } = useT();
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-6 py-16 text-center">
      <button
        type="button"
        onClick={onBrowse}
        data-testid="dropzone"
        className="group flex w-full max-w-xl flex-col items-center rounded-2xl border-2 border-dashed border-line-strong bg-ink-850/50 px-8 py-16 transition-colors hover:border-accent/60 hover:bg-ink-800/50"
      >
        <span className="grid h-14 w-14 place-items-center rounded-2xl border border-line bg-ink-800 transition-transform group-hover:scale-105">
          <svg viewBox="0 0 24 24" className="h-6 w-6 text-accent" fill="none" strokeWidth="1.8" stroke="currentColor" aria-hidden="true">
            <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 15v2.5A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V15" strokeLinecap="round" />
          </svg>
        </span>
        <span className="mt-6 text-xl font-semibold tracking-tight text-mist-100 sm:text-2xl">
          {t('Drop a document anywhere')}
        </span>
        <span className="mt-2 max-w-md text-sm leading-relaxed text-mist-400">
          {t(
            'CAD, 3D, PDF, Word, Excel, PowerPoint and images. The format is read from the file itself — you never pick a viewer.',
          )}
        </span>
      </button>
    </div>
  );
}

function DropOverlay() {
  const { t } = useT();
  return (
    <div
      aria-hidden="true"
      data-testid="drop-overlay"
      className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-ink-950/70 backdrop-blur-sm"
    >
      <div className="rounded-2xl border-2 border-dashed border-accent bg-ink-900/90 px-12 py-10 text-center">
        <p className="text-lg font-semibold text-mist-100">{t('Drop to open')}</p>
        <p className="mt-1 text-sm text-mist-400">{t('One file or many. An assembly takes its parts along.')}</p>
      </div>
    </div>
  );
}
