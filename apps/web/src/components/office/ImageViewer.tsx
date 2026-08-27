'use client';

import { useEffect, useState } from 'react';
import { apiUrl } from '@/lib/api';
import { ViewerAdRail } from '@/components/site/AdSlot';

/** Images need no processing pipeline; they just need to be framed properly. */
export function ImageViewer({ source, onReady }: { source: string; onReady(): void }) {
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    onReady();
  }, [onReady]);

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
