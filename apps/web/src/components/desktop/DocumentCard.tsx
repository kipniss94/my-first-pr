'use client';

import { useEffect, useState } from 'react';
import type { CachedDocument } from '@/lib/cache';
import { formatBytes } from '@/lib/format';

/**
 * One document on the desktop.
 *
 * The tile is the document: a real thumbnail whenever the viewer that opened it
 * could produce one, and a typed tile — never a fake screenshot — when it could
 * not. The name is below the tile, not on top of it, so long part numbers stay
 * readable at any size.
 */

interface DocumentCardProps {
  document: CachedDocument;
  onOpen(document: CachedDocument): void;
  onRemove(document: CachedDocument): void;
  busy?: boolean;
}

/** Accent per family, so a wall of cards is scannable at a glance. */
const FAMILY_TINT: Record<string, string> = {
  cad: 'from-[#1d3a6b] to-[#0f1d33]',
  pdf: 'from-[#5a1f2a] to-[#2a1018]',
  office: 'from-[#12402f] to-[#0b2119]',
  image: 'from-[#3d2a5c] to-[#1c1430]',
  unknown: 'from-ink-700 to-ink-850',
};

export function DocumentCard({ document, onOpen, onRemove, busy = false }: DocumentCardProps) {
  const thumbnail = useObjectUrl(document.thumbnail);
  const label = document.formatLabel ?? document.extension.toUpperCase() ?? 'FILE';

  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => onOpen(document)}
        disabled={busy}
        data-testid="document-card"
        data-name={document.name}
        title={document.name}
        className="flex w-full flex-col gap-2.5 rounded-xl p-2 text-left transition-colors hover:bg-ink-800/70 focus-visible:bg-ink-800/70 disabled:cursor-wait"
      >
        <span
          className={`relative flex aspect-4/3 items-center justify-center overflow-hidden rounded-lg border border-line bg-linear-to-br ${
            FAMILY_TINT[document.kind] ?? FAMILY_TINT.unknown
          } transition-colors group-hover:border-line-strong`}
        >
          {thumbnail ? (
            // A cached bitmap from the browser's own storage: `next/image` has
            // nothing to optimise here and would only add a proxy hop.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumbnail} alt="" className="h-full w-full object-contain" />
          ) : (
            <span className="font-mono text-[15px] font-semibold tracking-wide text-mist-200/85">{label}</span>
          )}

          {busy && (
            <span className="absolute inset-0 grid place-items-center bg-ink-950/60">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-ink-600 border-t-accent" />
            </span>
          )}
        </span>

        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium text-mist-100">{document.name}</span>
          <span className="mt-0.5 block truncate text-[11px] text-mist-500">
            {label} · {formatBytes(document.size)}
            {!document.hasBlob && ' · not cached'}
          </span>
        </span>
      </button>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onRemove(document);
        }}
        aria-label={`Remove ${document.name} from the workspace`}
        className="absolute right-3 top-3 grid h-6 w-6 place-items-center rounded-md border border-line bg-ink-900/85 text-mist-400 opacity-0 backdrop-blur transition hover:border-danger/50 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
        </svg>
      </button>
    </li>
  );
}

/** Blob URLs have to be revoked, or a long session leaks every thumbnail. */
function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const created = URL.createObjectURL(blob);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [blob]);

  return url;
}
