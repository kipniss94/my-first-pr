'use client';

import type { LiveMeasure } from '@/lib/cad/scene';
import { formatLength } from '@/lib/format';
import { useT } from '@/lib/prefs';

/**
 * The bar above the model while dimensioning: what is picked, the dimension
 * shown, and every other dimension the same pick offers — one click, Space,
 * or the wheel over the bar to switch.
 */
export function LiveMeasurePanel({
  live,
  units,
  onCycle,
  onChoose,
  onKeep,
  onClear,
}: {
  live: LiveMeasure;
  units: string;
  onCycle(step: number): void;
  onChoose(index: number): void;
  onKeep(): void;
  onClear(): void;
}) {
  const { t } = useT();
  const current = live.options[live.index];

  return (
    <div
      className="absolute left-1/2 top-3 z-10 w-[min(44rem,calc(100%-1.5rem))] -translate-x-1/2 rounded-xl border border-measure/40 bg-ink-900/92 px-3 py-2 shadow-lg backdrop-blur"
      data-testid="live-measure"
      onWheel={(event) => {
        if (live.options.length < 2) return;
        event.preventDefault();
        const delta = event.deltaY || event.deltaX;
        if (delta !== 0) onCycle(delta > 0 ? 1 : -1);
      }}
    >
      {live.selection.length === 0 ? (
        <p className="text-[12px] text-mist-200">
          <span className="font-medium text-measure">{t('Dimension')}:</span>{' '}
          {t('point at a face, edge or vertex and click it. A second one gives the distance or angle between them.')}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {live.selection.map((entity, k) => (
              <span
                key={k}
                className="inline-flex items-center gap-1 rounded-md border border-select/50 bg-select/10 px-1.5 py-0.5 text-[11px] text-mist-100"
                data-testid="live-measure-picked"
              >
                <span className="font-mono text-[10px] text-mist-500">{k + 1}</span>
                {t(entity.type)}
                {entity.size !== null && (
                  <span className="text-mist-400">
                    {entity.sizeKind === 'diameter' ? 'Ø' : ''}
                    {formatLength(entity.size, units)}
                  </span>
                )}
              </span>
            ))}
            {live.selection.length === 1 && (
              <span className="text-[11px] text-mist-500">{t('+ a second item for the distance between them')}</span>
            )}
            <span className="ml-auto flex items-center gap-1">
              {current && (
                <button type="button" className="btn btn-primary !px-2 !py-1 text-[11px]" onClick={onKeep} data-testid="live-measure-keep">
                  {t('Keep')} <span className="opacity-60">↵</span>
                </button>
              )}
              <button type="button" className="btn btn-ghost !px-2 !py-1 text-[11px]" onClick={onClear} data-testid="live-measure-clear">
                {t('Clear')} <span className="opacity-60">Esc</span>
              </button>
            </span>
          </div>

          {current ? (
            <div className="mt-1.5 flex items-center gap-2">
              {live.options.length > 1 && (
                <button type="button" className="btn-icon !p-1" onClick={() => onCycle(-1)} aria-label={t('Previous variant')}>
                  <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
                    <path d="M7.5 2.5 4 6l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}
              <p className="min-w-0 flex-1 truncate text-[13px]" data-testid="live-measure-current">
                <span className="text-mist-300">{t(current.label)}:</span>{' '}
                <span className="font-mono font-semibold tabular-nums text-measure">{current.text}</span>
              </p>
              {live.options.length > 1 && (
                <>
                  <span className="font-mono text-[11px] text-mist-500">
                    {live.index + 1}/{live.options.length}
                  </span>
                  <button type="button" className="btn-icon !p-1" onClick={() => onCycle(1)} aria-label={t('Next variant')}>
                    <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
                      <path d="M4.5 2.5 8 6 4.5 9.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </>
              )}
            </div>
          ) : (
            live.selection.length === 2 && <p className="mt-1.5 text-[12px] text-mist-400">{t('Nothing to dimension between these two.')}</p>
          )}

          {live.options.length > 1 && (
            <div className="mt-1.5 flex flex-wrap gap-1" data-testid="live-measure-options">
              {live.options.map((option, k) => (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => onChoose(k)}
                  aria-pressed={k === live.index}
                  className={`rounded-md border px-1.5 py-0.5 text-[11px] transition-colors ${
                    k === live.index
                      ? 'border-measure/60 bg-measure/15 text-mist-100'
                      : 'border-line bg-ink-800/80 text-mist-400 hover:text-mist-100'
                  }`}
                >
                  {t(option.label)} <span className="font-mono text-mist-500">{option.text}</span>
                </button>
              ))}
            </div>
          )}
          {live.options.length > 1 && (
            <p className="mt-1 text-[10px] text-mist-500">
              {t('Space or the wheel over the dimension: next variant · Shift+Space: back · Shift+wheel works anywhere over the model')}
            </p>
          )}
        </>
      )}
    </div>
  );
}
