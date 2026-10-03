'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DrawingDocument } from '@docuview/shared';
import { apiUrl, fetchApi } from '@/lib/api';
import { ErrorPanel } from '@/components/viewer/ErrorPanel';
import { ViewerAdRail } from '@/components/site/AdSlot';
import { unitLabel } from '@/lib/format';
import { useT } from '@/lib/prefs';

interface DrawingViewerProps {
  /** URL of the `drawing.json` the processor wrote. */
  source: string;
  fileName: string;
  onProgress(percent: number): void;
  onReady(): void;
  /** Receives the picture of the active sheet, for the workspace card. */
  onThumbnail?(source: string): void;
}

type Box = { x: number; y: number; w: number; h: number };

/**
 * A CAD drawing, sheet by sheet.
 *
 * Each sheet is an SVG in millimetres, placed in the page as markup rather
 * than as a picture so it stays sharp at any zoom: panning and zooming move
 * its viewBox. The picture SolidWorks saved of the sheet is one click away,
 * for checking the drawing against what SolidWorks showed.
 */
export function DrawingViewer({ source, fileName, onProgress, onReady, onThumbnail }: DrawingViewerProps) {
  const [drawing, setDrawing] = useState<DrawingDocument | null>(null);
  const [failed, setFailed] = useState(false);
  const [sheetIndex, setSheetIndex] = useState(0);
  const { t } = useT();
  const [markup, setMarkup] = useState<Record<number, string>>({});
  const [showPicture, setShowPicture] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [infoOpen, setInfoOpen] = useState(true);
  const hostRef = useRef<HTMLDivElement>(null);
  /** The pane itself: always mounted, whichever of the sheet and the picture is in it. */
  const paneRef = useRef<HTMLDivElement>(null);
  const box = useRef<Box | null>(null);
  const drag = useRef<{ x: number; y: number; box: Box } | null>(null);

  useEffect(() => {
    let cancelled = false;
    onProgress(30);
    fetchApi(source)
      .then((response) => {
        if (!response.ok) throw new Error('drawing unavailable');
        return response.json() as Promise<DrawingDocument>;
      })
      .then((value) => {
        if (cancelled) return;
        setDrawing(value);
        const active = Math.max(0, value.sheets.findIndex((sheet) => sheet.active));
        setSheetIndex(active);
        const picture = value.sheets[active]?.picture;
        if (picture) onThumbnail?.(apiUrl(picture));
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [onProgress, onThumbnail, source]);

  const sheet = drawing?.sheets[sheetIndex] ?? null;

  // Each sheet's SVG, fetched once when first shown.
  useEffect(() => {
    if (!sheet || markup[sheetIndex] !== undefined) return;
    let cancelled = false;
    onProgress(60);
    fetchApi(sheet.svg)
      .then((response) => {
        if (!response.ok) throw new Error('sheet unavailable');
        return response.text();
      })
      .then((text) => {
        if (cancelled) return;
        setMarkup((current) => ({ ...current, [sheetIndex]: text }));
        onProgress(100);
        onReady();
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [markup, onProgress, onReady, sheet, sheetIndex]);

  const svgElement = useCallback(() => hostRef.current?.querySelector('svg') ?? null, []);

  const apply = useCallback(() => {
    const svg = svgElement();
    const host = hostRef.current;
    if (!svg || !host || !box.current || !sheet) return;
    const { x, y, w, h } = box.current;
    svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
    // Zoom as the share of the sheet on screen, 100% = whole sheet fitted.
    setZoom(Math.round((Math.max(sheet.widthMm / w, sheet.heightMm / h) || 1) * 100) / 100);
  }, [sheet, svgElement]);

  const fit = useCallback(() => {
    const host = paneRef.current;
    // A pane not laid out yet (hidden, or still sizing) has nothing to fit to.
    if (!host || !sheet || host.clientWidth === 0 || host.clientHeight === 0) return;
    const margin = Math.max(sheet.widthMm, sheet.heightMm) * 0.03;
    const w = sheet.widthMm + margin * 2;
    const h = sheet.heightMm + margin * 2;
    // Keep the host's aspect so the viewBox and the screen agree.
    const aspect = host.clientWidth / Math.max(1, host.clientHeight);
    const fitW = Math.max(w, h * aspect);
    const fitH = fitW / aspect;
    box.current = { x: (sheet.widthMm - fitW) / 2, y: (sheet.heightMm - fitH) / 2, w: fitW, h: fitH };
    apply();
  }, [apply, sheet]);

  // A new sheet on screen: fit it.
  useEffect(() => {
    if (svgElement()) fit();
  }, [fit, markup, sheetIndex, showPicture, svgElement]);

  useEffect(() => {
    const host = paneRef.current;
    if (!host) return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(host);
    return () => observer.disconnect();
  }, [fit]);

  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const host = paneRef.current;
      if (!host || !box.current) return;
      const rect = host.getBoundingClientRect();
      const b = box.current;
      const fx = clientX === undefined ? 0.5 : (clientX - rect.left) / rect.width;
      const fy = clientY === undefined ? 0.5 : (clientY - rect.top) / rect.height;
      const px = b.x + fx * b.w;
      const py = b.y + fy * b.h;
      const w = Math.min(Math.max(b.w / factor, 1), 20_000);
      const h = (w / b.w) * b.h;
      box.current = { x: px - fx * w, y: py - fy * h, w, h };
      apply();
    },
    [apply],
  );

  useEffect(() => {
    const host = paneRef.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'f' || event.key === 'F' || event.key === '0') fit();
      else if (event.key === '+' || event.key === '=') zoomAt(1.25);
      else if (event.key === '-') zoomAt(0.8);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fit, zoomAt]);

  const raw = markup[sheetIndex];
  // One object per sheet, kept across renders: React writes the markup again
  // whenever this prop is a new object, which would undo every pan and zoom.
  const current = useMemo(
    () =>
      raw === undefined
        ? undefined
        : {
            __html: raw.replace(
              /<svg([^>]*?) width="[^"]*" height="[^"]*"/,
              '<svg$1 preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block"',
            ),
          },
    [raw],
  );

  if (failed) {
    return (
      <ErrorPanel
        error={{
          code: 'drawing_unavailable',
          message: "We couldn't show this drawing.",
          hint: 'The prepared sheets may have expired. Upload the file again.',
          retryable: true,
        }}
      />
    );
  }

  // The sheet fills the pane from the first paint: its own size comes off and
  // the viewBox (moved by pan and zoom) decides what is shown.

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-ink-850 px-3">
          {drawing && drawing.sheets.length > 1 && (
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto" role="tablist" aria-label={t('Sheets')}>
              {drawing.sheets.map((s, k) => (
                <button
                  key={`${s.name}-${k}`}
                  type="button"
                  role="tab"
                  aria-selected={k === sheetIndex}
                  onClick={() => setSheetIndex(k)}
                  data-testid="drawing-sheet-tab"
                  className={`shrink-0 rounded-md px-2.5 py-1 text-[12px] ${
                    k === sheetIndex ? 'bg-ink-700 text-mist-100' : 'text-mist-400 hover:bg-ink-800 hover:text-mist-200'
                  }`}
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <span className="hidden font-mono text-[11px] text-mist-500 sm:inline">
              {sheet ? `${sheet.widthMm}×${sheet.heightMm} ${unitLabel('mm')} · ${Math.round(zoom * 100)}%` : ''}
            </span>
            {sheet?.picture && (
              <button
                type="button"
                onClick={() => setShowPicture((on) => !on)}
                aria-pressed={showPicture}
                className={`btn ${showPicture ? 'btn-primary' : 'btn-ghost'}`}
                title={t('Compare with the picture SolidWorks saved of this sheet')}
                data-testid="drawing-picture"
              >
                {t('SolidWorks picture')}
              </button>
            )}
            <button type="button" onClick={fit} className="btn btn-subtle" data-testid="drawing-fit">
              {t('Fit')}
            </button>
            {sheet && (
              <a
                href={apiUrl(sheet.svg)}
                download={`${fileName.replace(/\.[^.]+$/, '')} - ${sheet.name}.svg`}
                className="btn btn-ghost"
                title={t('Download this sheet as SVG')}
              >
                SVG
              </a>
            )}
            <button type="button" onClick={() => setInfoOpen((open) => !open)} className="btn btn-ghost">
              {t('Info')}
            </button>
          </div>
        </div>

        <div
          ref={paneRef}
          className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden bg-[var(--sheet-surround)] active:cursor-grabbing"
          onPointerDown={(event) => {
            if (!box.current) return;
            (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
            drag.current = { x: event.clientX, y: event.clientY, box: { ...box.current } };
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            const host = paneRef.current;
            if (!start || !host) return;
            const scale = start.box.w / host.clientWidth;
            box.current = { ...start.box, x: start.box.x - (event.clientX - start.x) * scale, y: start.box.y - (event.clientY - start.y) * scale };
            apply();
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onDoubleClick={fit}
          data-testid="drawing-canvas"
        >
          {showPicture && sheet?.picture ? (
            // The picture is a bitmap SolidWorks rendered: shown as it is, for comparison.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={apiUrl(sheet.picture)}
              alt={t('{name} as SolidWorks saved it', { name: sheet.name })}
              className="absolute inset-0 h-full w-full object-contain"
              draggable={false}
            />
          ) : (
            <div
              ref={hostRef}
              className="absolute inset-0"
              // Markup generated by our own processor, with every text escaped.
              dangerouslySetInnerHTML={current}
            />
          )}
          {!current && !showPicture && (
            <div className="absolute inset-0 grid place-items-center text-sm text-mist-400">{t('Drawing the sheet…')}</div>
          )}
        </div>
      </div>

      {infoOpen && drawing && sheet && (
        <aside className="hidden w-72 shrink-0 flex-col overflow-y-auto border-l border-line bg-ink-850 lg:flex">
          <section className="border-b border-line p-4">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded-md border border-ok/40 bg-ok/10 px-2 py-0.5 text-[11px] font-medium text-ok">
                {t('Drawing')}
              </span>
              <span className="text-[13px] font-medium text-mist-200">
                {drawing.application}
                {drawing.version && drawing.version !== drawing.application ? ` · ${drawing.version}` : ''}
              </span>
            </div>
            <p className="mt-3 text-[12px] leading-relaxed text-mist-400">{t(drawing.note)}</p>
            <dl className="mt-3 grid grid-cols-[1fr_auto] gap-y-1 text-[12px]" data-testid="drawing-stats">
              <dt className="text-mist-500">{t('Sheet')}</dt>
              <dd className="text-right text-mist-200">
                {sheet.name} · {sheet.widthMm}×{sheet.heightMm} {unitLabel('mm')}
              </dd>
              <dt className="text-mist-500">{t('Views drawn')}</dt>
              <dd className="text-right text-mist-200">
                {t('{index} of {count}', { index: sheet.viewsDrawn, count: sheet.views })}
              </dd>
              {sheet.viewsFromPicture > 0 && (
                <>
                  <dt className="text-mist-500">{t('From the picture')}</dt>
                  <dd className="text-right text-warn">{sheet.viewsFromPicture}</dd>
                </>
              )}
            </dl>
            <p className="mt-3 text-[11px] leading-relaxed text-mist-500">
              {t('Wheel to zoom, drag to move, F or double-click to fit.')}
            </p>
          </section>
          {drawing.properties.length > 0 && (
            <section className="p-4">
              <h2 className="field-label">{t('Document properties')}</h2>
              <dl className="mt-3 space-y-2">
                {drawing.properties.map((property) => (
                  <div key={property.name} className="grid grid-cols-[7.5rem_1fr] gap-2">
                    <dt className="truncate text-[12px] text-mist-500" title={property.name}>
                      {t(property.name)}
                    </dt>
                    <dd className="break-words text-[12px] text-mist-200">{property.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </aside>
      )}

      <ViewerAdRail />
    </div>
  );
}
