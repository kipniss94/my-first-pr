'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ACCEPTED_EXTENSIONS, type CapabilitiesResponse } from '@docuview/shared';
import { getCapabilities } from '@/lib/api';
import { formatBytes, formatDuration } from '@/lib/format';
import { droppedFiles, FALLBACK_MAX_BYTES, openFiles } from '@/lib/open';
import { useT } from '@/lib/prefs';

const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.join(',');

export function Dropzone({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string }[] | null>(null);
  const { t, tp, tx } = useT();
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse | null>(null);
  const [serviceDown, setServiceDown] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    let cancelled = false;
    getCapabilities().then(
      (value) => {
        if (!cancelled) setCapabilities(value);
      },
      () => {
        if (!cancelled) setServiceDown(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const maxBytes = capabilities?.maxUploadBytes ?? FALLBACK_MAX_BYTES;

  const accept = useCallback(
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
      setError(outcome.refused);
    },
    [maxBytes, router],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      void droppedFiles(event.dataTransfer).then(({ files, fromFolder }) => accept(files, fromFolder));
    },
    [accept],
  );

  // Drag events fire for every child element, so depth-count instead of
  // toggling on enter/leave — otherwise the highlight flickers.
  const onDragEnter = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }, []);

  const onDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }, []);

  return (
    <div id="upload" className="scroll-mt-24">
      <div
        role="button"
        tabIndex={0}
        aria-label={t('Upload a document')}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDrop={onDrop}
        onDragOver={(event) => event.preventDefault()}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        data-dragging={dragging}
        data-testid="dropzone"
        className={`group relative flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 text-center transition-all duration-200 ${
          compact ? 'py-10' : 'py-16 sm:py-20'
        } ${
          dragging
            ? 'border-accent bg-accent/8 shadow-[0_0_0_6px_rgba(76,141,255,0.08)]'
            : 'border-line-strong bg-ink-850/70 hover:border-accent/60 hover:bg-ink-800/70'
        }`}
      >
        <div
          className={`grid h-14 w-14 place-items-center rounded-2xl border transition-transform duration-200 ${
            dragging ? 'scale-110 border-accent bg-accent/15' : 'border-line bg-ink-800 group-hover:scale-105'
          }`}
        >
          <svg viewBox="0 0 24 24" className="h-6 w-6 text-accent" fill="none" strokeWidth="1.8" stroke="currentColor" aria-hidden="true">
            <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 15v2.5A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5V15" strokeLinecap="round" />
          </svg>
        </div>

        <p className={`mt-5 font-semibold tracking-tight text-mist-100 ${compact ? 'text-lg' : 'text-xl sm:text-2xl'}`}>
          {dragging ? t('Drop to open it') : t('Drag & drop your file here')}
        </p>
        <p className="mt-2 text-sm text-mist-400">
          {tx('or {browse} on your device', {
            browse: (
              <span className="font-medium text-accent underline decoration-accent/40 underline-offset-4">
                {t('browse files')}
              </span>
            ),
          })}
        </p>

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          multiple
          className="sr-only"
          data-testid="file-input"
          onChange={(event) => {
            void accept(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
      </div>

      {error && (
        <div
          role="alert"
          data-testid="upload-error"
          className="mt-4 rounded-xl border border-danger/35 bg-danger/10 px-4 py-3"
        >
          <p className="text-sm font-medium text-mist-100">
            {error.length === 1
              ? t(error[0].message)
              : tp(
                  error.length,
                  ['The file could not be opened.', 'None of the {n} files could be opened.'],
                  ['Файл не удалось открыть.', 'Ни один из {n} файлов не удалось открыть.', 'Ни один из {n} файлов не удалось открыть.'],
                )}
          </p>
          {(error.length === 1 ? error[0].hint : error.map((r) => t(r.message)).join(' ')) && (
            <p className="mt-1 text-[13px] text-mist-400">
              {error.length === 1 ? t(error[0].hint ?? '') : error.map((r) => t(r.message)).join(' ')}
            </p>
          )}
        </div>
      )}

      {serviceDown && (
        <div role="alert" className="mt-4 rounded-xl border border-warn/35 bg-warn/10 px-4 py-3">
          <p className="text-sm font-medium text-mist-100">{t('The document service isn’t responding.')}</p>
          <p className="mt-1 text-[13px] text-mist-400">
            {tx('Start it with {command}, which runs both halves of the app.', {
              command: <code className="font-mono text-mist-300">Start-DocuView.bat</code>,
            })}
          </p>
        </div>
      )}

      <p className="mt-4 text-center text-xs text-mist-500">
        {t('Up to {size} per file · deleted automatically after {time} · no account needed', {
          size: formatBytes(maxBytes),
          time: formatDuration(capabilities?.retentionSeconds ?? 3600),
        })}
      </p>
    </div>
  );
}
