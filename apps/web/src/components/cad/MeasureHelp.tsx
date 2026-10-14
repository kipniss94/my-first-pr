'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '@/lib/prefs';

/**
 * How the dimension tool works, in a few lines an engineer reads at a glance.
 * A "?" beside the tool; the card opens above it and closes on any click
 * elsewhere or Esc.
 */
export function MeasureHelp({ openAtStart = false }: { openAtStart?: boolean }) {
  const { t } = useT();
  const [open, setOpen] = useState(openAtStart);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ bottom: number; left: number } | null>(null);

  // The toolbar scrolls sideways and would clip an absolutely placed card,
  // so the card is placed against the window instead.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPlace({
        bottom: Math.round(window.innerHeight - rect.top + 8),
        left: Math.max(8, Math.min(Math.round(rect.left - 12), window.innerWidth - 392)),
      });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!cardRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const rows: [string, string][] = [
    [t('Point'), t('Hover: the face, edge or vertex under the cursor lights up. Click to pick it; click again to drop it.')],
    [t('One item'), t('Cylinder or hole — Ø, R and length; circle or arc — Ø, R, arc; edge — length; face — area.')],
    [
      t('Two items'),
      t(
        'Distance or angle between them. Two holes or shafts: centre to centre, near sides, far sides, side to centre. A curved surface and a plane: the touching (tangent) point.',
      ),
    ],
    [t('Switch'), t('Space or the mouse wheel over the dimension — the next variant; Shift+Space back. Shift+wheel works anywhere over the model.')],
    [t('Keep'), t('Enter, or click the next item: the dimension stays and goes to the list. Esc clears; a click on empty space keeps and starts again.')],
  ];

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="btn-icon"
        data-active={open ? 'true' : undefined}
        aria-expanded={open}
        title={t('How to measure')}
        aria-label={t('How to measure')}
        onClick={() => setOpen((value) => !value)}
        data-testid="measure-help"
      >
        <svg viewBox="0 0 16 16" className="h-[16px] w-[16px]" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <circle cx="8" cy="8" r="6.2" />
          <path d="M6.3 6.3a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.9.7-.9 1.3v.3" strokeLinecap="round" />
          <circle cx="8" cy="11.6" r="0.4" fill="currentColor" />
        </svg>
      </button>
      {open && place && (
        <div
          ref={cardRef}
          role="dialog"
          aria-label={t('How to measure')}
          style={{ bottom: place.bottom, left: place.left }}
          className="fixed z-50 w-[380px] rounded-xl border border-line bg-ink-800 p-3 shadow-2xl"
          data-testid="measure-help-card"
        >
          <p className="text-[13px] font-semibold text-mist-100">{t('Dimensions: how it works')}</p>
          <dl className="mt-2 space-y-1.5">
            {rows.map(([term, text]) => (
              <div key={term} className="grid grid-cols-[5.5rem_1fr] gap-2 text-[12px] leading-snug">
                <dt className="font-medium text-measure">{term}</dt>
                <dd className="text-mist-300">{text}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 border-t border-line pt-2 text-[11px] text-mist-500">
            {t('Free points instead of faces: the two-point and three-point tools beside it.')}
          </p>
        </div>
      )}
    </>
  );
}
