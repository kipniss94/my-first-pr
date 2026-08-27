'use client';

import { useEffect, useState } from 'react';

export type AdPlacement = 'top' | 'sidebar' | 'in-content' | 'footer';

interface AdSlotProps {
  placement: AdPlacement;
  className?: string;
}

/**
 * Reserved advertising space.
 *
 * Stage 1 renders a labelled placeholder and nothing else — no network calls,
 * no third-party script. The point is to fix the *layout* now so that turning
 * ads on later cannot shift content or overlap a viewer: every placement has a
 * declared size that the page reserves from the first paint.
 *
 * To go live, replace the placeholder body with the network's ad tag and keep
 * the wrapper (and its dimensions) exactly as they are.
 */
const SIZES: Record<AdPlacement, { width: number; height: number; label: string }> = {
  top: { width: 970, height: 90, label: 'Leaderboard' },
  sidebar: { width: 300, height: 600, label: 'Half page' },
  'in-content': { width: 336, height: 280, label: 'Large rectangle' },
  footer: { width: 728, height: 90, label: 'Banner' },
};

export function AdSlot({ placement, className = '' }: AdSlotProps) {
  const size = SIZES[placement];
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    // A single switch decides whether any placement renders. Ads are off by
    // default so the MVP ships without them.
    setEnabled(process.env.NEXT_PUBLIC_ADS_ENABLED === 'true');
  }, []);

  if (!enabled) return null;

  return (
    <aside
      className={`flex items-center justify-center rounded-lg border border-dashed border-line bg-ink-850/60 ${className}`}
      style={{ width: '100%', maxWidth: size.width, height: size.height, minHeight: size.height }}
      aria-label="Advertisement"
      data-ad-placement={placement}
    >
      <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-mist-500">
        Ad · {size.label} {size.width}×{size.height}
      </span>
    </aside>
  );
}

/**
 * Wrapper for the viewer's right rail. Ads never sit on top of the 3D canvas or
 * the document page — only beside them, and only when the viewport is wide
 * enough that nothing has to shrink.
 */
export function ViewerAdRail() {
  return (
    <div className="hidden 2xl:flex 2xl:w-[316px] 2xl:shrink-0 2xl:flex-col 2xl:items-center 2xl:gap-4 2xl:border-l 2xl:border-line 2xl:bg-ink-900 2xl:p-2">
      <AdSlot placement="sidebar" />
    </div>
  );
}
