'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ACCEPTED_EXTENSIONS, type CapabilitiesResponse } from '@docuview/shared';
import { getCapabilities } from '@/lib/api';
import { formatBytes, formatDuration } from '@/lib/format';
import { startUpload } from '@/lib/session';

const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.join(',');
const FALLBACK_MAX_BYTES = 250 * 1024 * 1024;

function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9_]{1,12})$/.exec(name);
  return match ? match[1].toLowerCase() : '';
}

export function Dropzone({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
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
    (file: File | undefined) => {
      if (!file) return;
      setError(null);

      if (file.size === 0) {
        setError({ message: 'That file is empty.', hint: 'Pick a file that has content in it.' });
        return;
      }
      if (file.size > maxBytes) {
        setError({
          message: `That file is ${formatBytes(file.size)}, which is over the ${formatBytes(maxBytes)} limit.`,
          hint: 'Try a compressed or simplified export.',
        });
        return;
      }
      const extension = extensionOf(file.name);
      if (extension && !ACCEPTED_EXTENSIONS.includes(`.${extension}`)) {
        setError({
          message: `We don't support ".${extension}" files.`,
          hint: 'The supported formats are listed below.',
        });
        return;
      }

      const sessionId = startUpload(file);
      router.push(`/viewer?s=${sessionId}`);
    },
    [maxBytes, router],
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const items = event.dataTransfer?.files;
      if (!items || items.length === 0) return;
      if (items.length > 1) {
        setError({ message: 'One file at a time, please.', hint: 'Drop a single document to open it.' });
        return;
      }
      accept(items[0]);
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
        aria-label="Upload a document"
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
          {dragging ? 'Drop to open it' : 'Drag & drop your file here'}
        </p>
        <p className="mt-2 text-sm text-mist-400">
          or{' '}
          <span className="font-medium text-accent underline decoration-accent/40 underline-offset-4">
            browse files
          </span>{' '}
          on your device
        </p>

        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          className="sr-only"
          data-testid="file-input"
          onChange={(event) => {
            accept(event.target.files?.[0]);
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
          <p className="text-sm font-medium text-mist-100">{error.message}</p>
          {error.hint && <p className="mt-1 text-[13px] text-mist-400">{error.hint}</p>}
        </div>
      )}

      {serviceDown && (
        <div role="alert" className="mt-4 rounded-xl border border-warn/35 bg-warn/10 px-4 py-3">
          <p className="text-sm font-medium text-mist-100">The document service isn&apos;t responding.</p>
          <p className="mt-1 text-[13px] text-mist-400">
            Make sure the API is running (<code className="font-mono text-mist-300">npm run dev</code> starts both
            parts).
          </p>
        </div>
      )}

      <p className="mt-4 text-center text-xs text-mist-500">
        Up to {formatBytes(maxBytes)} per file · deleted automatically after{' '}
        {formatDuration(capabilities?.retentionSeconds ?? 3600)} · no account needed
      </p>
    </div>
  );
}
