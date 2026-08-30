'use client';

import { useEffect, useState } from 'react';
import { apiUrl } from '@/lib/api';
import { THUMBNAIL_EDGE } from '@/lib/thumbnail';
import { ViewerAdRail } from '@/components/site/AdSlot';

/** Images need no processing pipeline; they just need to be framed properly. */
export function ImageViewer({
  source,
  onReady,
  onThumbnail,
}: {
  source: string;
  onReady(): void;
  /** Receives a PNG data URL for the workspace card. */
  onThumbnail?(dataUrl: string): void;
}) {
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    onReady();
  }, [onReady]);

  // The card thumbnail is the picture itself, scaled down on a canvas so a
  // 40 MP photo does not become a 40 MP cache entry.
  useEffect(() => {
    if (!onThumbnail) return;
    let cancelled = false;
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      if (cancelled) return;
      try {
        const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext('2d');
        if (!context) return;
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        onThumbnail(canvas.toDataURL('image/png'));
      } catch {
        /* A tainted canvas or an SVG with no intrinsic size: skip the card art. */
      }
    };
    image.src = apiUrl(source);
    return () => {
      cancelled = true;
    };
  }, [onThumbnail, source]);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-ink-850 px-3">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setFit(true);
              setZoom(1);
            }}
          >
            Fit
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => { setFit(false); setZoom((z) => Math.max(0.1, z / 1.25)); }}>
            −
          </button>
          <span className="w-12 text-center font-mono text-[12px] text-mist-300">{Math.round(zoom * 100)}%</span>
          <button type="button" className="btn btn-ghost" onClick={() => { setFit(false); setZoom((z) => Math.min(8, z * 1.25)); }}>
            +
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-ink-950/60 p-6">
          {failed ? (
            <p className="text-center text-sm text-mist-400">This image could not be displayed.</p>
          ) : (
            <div className="flex min-h-full items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={apiUrl(source)}
                alt="Uploaded document"
                onError={() => setFailed(true)}
                className={fit ? 'max-h-full max-w-full object-contain' : ''}
                style={fit ? undefined : { width: `${zoom * 100}%`, maxWidth: 'none' }}
              />
            </div>
          )}
        </div>
      </div>
      <ViewerAdRail />
    </div>
  );
}
