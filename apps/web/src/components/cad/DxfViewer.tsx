'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchWithProgress } from '@/lib/api';
import { formatCount, formatLength } from '@/lib/format';
import { ErrorPanel } from '@/components/viewer/ErrorPanel';
import { ViewerAdRail } from '@/components/site/AdSlot';

interface DxfViewerProps {
  source: string;
  onProgress(percent: number): void;
  onReady(): void;
}

/* ----------------------------- drawing model ------------------------------ */

interface Point {
  x: number;
  y: number;
}

type Shape =
  | { kind: 'polyline'; layer: string; points: Point[]; closed: boolean }
  | { kind: 'circle'; layer: string; center: Point; radius: number }
  | { kind: 'arc'; layer: string; center: Point; radius: number; start: number; end: number }
  | { kind: 'text'; layer: string; at: Point; text: string; height: number; rotation: number };

interface Drawing {
  shapes: Shape[];
  layers: { name: string; color: string; count: number }[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  units: string;
  skipped: Record<string, number>;
}

/** DXF $INSUNITS. Only the values a drawing is realistically saved in. */
const UNIT_NAMES: Record<number, string> = {
  0: 'units',
  1: 'in',
  2: 'ft',
  4: 'mm',
  5: 'cm',
  6: 'm',
  9: 'µm',
};

const LAYER_FALLBACK = '#93a3bb';

export function DxfViewer({ source, onProgress, onReady }: DxfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [drawing, setDrawing] = useState<Drawing | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set());
  const [panelOpen, setPanelOpen] = useState(true);
  const [measuring, setMeasuring] = useState(false);
  const [measurePoints, setMeasurePoints] = useState<Point[]>([]);
  const [cursor, setCursor] = useState<Point | null>(null);

  // View transform: drawing units → screen pixels.
  const viewRef = useRef({ scale: 1, offsetX: 0, offsetY: 0 });
  const [, forceRedraw] = useState(0);
  const redraw = useCallback(() => forceRedraw((tick) => tick + 1), []);

  /* -------------------------------- loading ------------------------------- */

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        const buffer = await fetchWithProgress(
          source,
          (loaded, total) => onProgress(Math.round((loaded / total) * 60)),
          controller.signal,
        );
        if (cancelled) return;
        onProgress(70);

        const { default: DxfParser } = await import('dxf-parser');
        const text = new TextDecoder('utf-8').decode(buffer);
        const parsed = new DxfParser().parseSync(text);
        if (cancelled) return;
        if (!parsed) throw new Error('empty parse result');

        const built = buildDrawing(parsed as unknown as RawDxf);
        if (built.shapes.length === 0) {
          setError({
            message: 'This drawing opened but contains nothing we can draw.',
            hint: 'It may only contain 3D solids, proxy objects or externally referenced drawings.',
          });
          return;
        }
        setDrawing(built);
        onProgress(100);
        onReady();
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setError({
          message: "We couldn't read this DXF drawing.",
          hint:
            err instanceof Error && /Unexpected|unsupported/i.test(err.message)
              ? 'The file may use a DXF variant we cannot parse. Saving it as ASCII DXF R2000 or later usually works.'
              : 'The file may be corrupted or use a binary DXF variant.',
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [onProgress, onReady, source]);

  /* ------------------------------ view control ---------------------------- */

  const fit = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !drawing) return;
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    const { minX, minY, maxX, maxY } = drawing.bounds;
    const spanX = Math.max(maxX - minX, 1e-6);
    const spanY = Math.max(maxY - minY, 1e-6);
    const scale = Math.min(width / spanX, height / spanY) * 0.88;
    viewRef.current = {
      scale,
      offsetX: width / 2 - ((minX + maxX) / 2) * scale,
      offsetY: height / 2 + ((minY + maxY) / 2) * scale,
    };
    redraw();
  }, [drawing, redraw]);

  useEffect(() => {
    if (drawing) fit();
  }, [drawing, fit]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => redraw());
    observer.observe(container);
    return () => observer.disconnect();
  }, [redraw]);

  /* -------------------------------- painting ------------------------------ */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !drawing) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
    }

    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#0e131b';
    context.fillRect(0, 0, width, height);

    const { scale, offsetX, offsetY } = viewRef.current;
    // DXF Y grows upwards, canvas Y grows downwards.
    const toScreen = (point: Point): Point => ({ x: point.x * scale + offsetX, y: -point.y * scale + offsetY });

    const colorFor = (layer: string) => drawing.layers.find((entry) => entry.name === layer)?.color ?? LAYER_FALLBACK;
    context.lineWidth = 1;
    context.lineJoin = 'round';
    context.lineCap = 'round';

    for (const shape of drawing.shapes) {
      if (hiddenLayers.has(shape.layer)) continue;
      context.strokeStyle = colorFor(shape.layer);

      switch (shape.kind) {
        case 'polyline': {
          if (shape.points.length < 2) break;
          context.beginPath();
          const start = toScreen(shape.points[0]);
          context.moveTo(start.x, start.y);
          for (let i = 1; i < shape.points.length; i += 1) {
            const point = toScreen(shape.points[i]);
            context.lineTo(point.x, point.y);
          }
          if (shape.closed) context.closePath();
          context.stroke();
          break;
        }
        case 'circle': {
          const centre = toScreen(shape.center);
          context.beginPath();
          context.arc(centre.x, centre.y, Math.abs(shape.radius * scale), 0, Math.PI * 2);
          context.stroke();
          break;
        }
        case 'arc': {
          const centre = toScreen(shape.center);
          context.beginPath();
          // Mirroring Y also mirrors the sweep direction.
          context.arc(centre.x, centre.y, Math.abs(shape.radius * scale), -shape.start, -shape.end, true);
          context.stroke();
          break;
        }
        case 'text': {
          const at = toScreen(shape.at);
          const size = Math.abs(shape.height * scale);
          if (size < 4 || size > 400) break;
          context.save();
          context.translate(at.x, at.y);
          context.rotate(-shape.rotation);
          context.fillStyle = colorFor(shape.layer);
          context.font = `${size}px ui-sans-serif, system-ui, sans-serif`;
          context.textBaseline = 'alphabetic';
          context.fillText(shape.text, 0, 0);
          context.restore();
          break;
        }
      }
    }

    // Measurement overlay.
    if (measurePoints.length > 0) {
      context.strokeStyle = '#f5a524';
      context.fillStyle = '#f5a524';
      const points = cursor && measurePoints.length === 1 ? [...measurePoints, cursor] : measurePoints;
      const screen = points.map(toScreen);
      context.beginPath();
      context.moveTo(screen[0].x, screen[0].y);
      for (let i = 1; i < screen.length; i += 1) context.lineTo(screen[i].x, screen[i].y);
      context.stroke();
      for (const point of screen) {
        context.beginPath();
        context.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
        context.fill();
      }
      if (points.length === 2) {
        const distance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
        const mid = { x: (screen[0].x + screen[1].x) / 2, y: (screen[0].y + screen[1].y) / 2 };
        const label = formatLength(distance, drawing.units);
        context.font = '12px ui-monospace, monospace';
        const metrics = context.measureText(label);
        context.fillStyle = 'rgba(11,14,20,0.9)';
        context.fillRect(mid.x - metrics.width / 2 - 6, mid.y - 20, metrics.width + 12, 18);
        context.fillStyle = '#f5a524';
        context.textAlign = 'center';
        context.fillText(label, mid.x, mid.y - 7);
        context.textAlign = 'left';
      }
    }
  });

  /* ------------------------------- interaction ---------------------------- */

  const toDrawing = useCallback((event: { clientX: number; clientY: number }): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const { scale, offsetX, offsetY } = viewRef.current;
    return {
      x: (event.clientX - rect.left - offsetX) / scale,
      y: -(event.clientY - rect.top - offsetY) / scale,
    };
  }, []);

  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    (event.target as HTMLCanvasElement).setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, moved: false };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (measuring && measurePoints.length === 1) {
      setCursor(toDrawing(event));
      redraw();
    }
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) > 3) drag.moved = true;
    viewRef.current.offsetX += dx;
    viewRef.current.offsetY += dy;
    dragRef.current = { x: event.clientX, y: event.clientY, moved: drag.moved };
    redraw();
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.moved) return;
    if (!measuring) return;

    const point = toDrawing(event);
    setMeasurePoints((current) => {
      if (current.length >= 2) return [point];
      return [...current, point];
    });
    redraw();
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const factor = Math.exp(-event.deltaY * 0.0015);
    const view = viewRef.current;
    // Keep the point under the cursor fixed while zooming.
    view.offsetX = pointerX - (pointerX - view.offsetX) * factor;
    view.offsetY = pointerY - (pointerY - view.offsetY) * factor;
    view.scale *= factor;
    redraw();
  };

  const measurement = useMemo(() => {
    if (measurePoints.length < 2) return null;
    const [a, b] = measurePoints;
    return {
      distance: Math.hypot(b.x - a.x, b.y - a.y),
      dx: Math.abs(b.x - a.x),
      dy: Math.abs(b.y - a.y),
    };
  }, [measurePoints]);

  if (error) return <ErrorPanel error={{ code: 'dxf_failed', ...error, retryable: false }} />;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={containerRef} className="relative min-h-0 flex-1">
          <canvas
            ref={canvasRef}
            className="absolute inset-0 h-full w-full touch-none"
            style={{ cursor: measuring ? 'crosshair' : 'grab' }}
            data-testid="dxf-canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onWheel={onWheel}
          />
          {!drawing && (
            <div className="absolute inset-0 grid place-items-center text-sm text-mist-400">Loading drawing…</div>
          )}
        </div>

        <div className="flex h-13 shrink-0 items-center gap-2 overflow-x-auto border-t border-line bg-ink-850 px-3 py-2">
          <button
            type="button"
            onClick={() => {
              setMeasuring((on) => !on);
              setMeasurePoints([]);
            }}
            aria-pressed={measuring}
            className={`btn ${measuring ? 'btn-primary' : 'btn-ghost'}`}
            data-testid="dxf-measure"
          >
            Measure
          </button>
          {measurement && drawing && (
            <span className="whitespace-nowrap font-mono text-[12px] text-measure">
              {formatLength(measurement.distance, drawing.units)}
              <span className="ml-2 text-mist-500">
                ΔX {measurement.dx.toFixed(2)} · ΔY {measurement.dy.toFixed(2)}
              </span>
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {drawing && (
              <span className="hidden font-mono text-[11px] text-mist-500 sm:inline">
                {formatCount(drawing.shapes.length)} entities · {drawing.units}
              </span>
            )}
            <button type="button" onClick={fit} className="btn btn-subtle" data-testid="dxf-fit">
              Fit
            </button>
            <button type="button" onClick={() => setPanelOpen((open) => !open)} className="btn btn-ghost">
              Layers
            </button>
          </div>
        </div>
      </div>

      {panelOpen && drawing && (
        <aside className="flex w-60 shrink-0 flex-col border-l border-line bg-ink-850">
          <h2 className="border-b border-line px-3 py-2.5 field-label">Layers</h2>
          <ul className="min-h-0 flex-1 overflow-auto py-1">
            {drawing.layers.map((layer) => {
              const hidden = hiddenLayers.has(layer.name);
              return (
                <li key={layer.name}>
                  <button
                    type="button"
                    onClick={() => {
                      setHiddenLayers((current) => {
                        const next = new Set(current);
                        if (next.has(layer.name)) next.delete(layer.name);
                        else next.add(layer.name);
                        return next;
                      });
                      redraw();
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-ink-800"
                  >
                    <span
                      className="h-3 w-3 shrink-0 rounded-sm border border-line-strong"
                      style={{ backgroundColor: layer.color, opacity: hidden ? 0.25 : 1 }}
                      aria-hidden="true"
                    />
                    <span className={`min-w-0 flex-1 truncate ${hidden ? 'text-mist-500 line-through' : 'text-mist-200'}`}>
                      {layer.name}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-mist-500">{layer.count}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {Object.keys(drawing.skipped).length > 0 && (
            <div className="border-t border-line px-3 py-2.5">
              <p className="field-label">Not drawn</p>
              <ul className="mt-1.5 space-y-0.5">
                {Object.entries(drawing.skipped).map(([type, count]) => (
                  <li key={type} className="flex justify-between font-mono text-[11px] text-mist-500">
                    <span>{type}</span>
                    <span>{count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      )}

      <ViewerAdRail />
    </div>
  );
}

/* --------------------------------- parsing -------------------------------- */

interface RawEntity {
  type: string;
  layer?: string;
  vertices?: { x: number; y: number; bulge?: number }[];
  center?: { x: number; y: number };
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  position?: { x: number; y: number };
  startPoint?: { x: number; y: number };
  text?: string;
  textHeight?: number;
  height?: number;
  rotation?: number;
  shape?: boolean;
  closed?: boolean;
  controlPoints?: { x: number; y: number }[];
  fitPoints?: { x: number; y: number }[];
  majorAxisEndPoint?: { x: number; y: number };
  axisRatio?: number;
  name?: string;
  xScale?: number;
  yScale?: number;
}

interface RawDxf {
  header?: Record<string, unknown>;
  entities?: RawEntity[];
  blocks?: Record<string, { entities?: RawEntity[] }>;
  tables?: { layer?: { layers?: Record<string, { color?: number; visible?: boolean }> } };
}

/**
 * Flatten a parsed DXF into simple polylines, circles, arcs and text.
 *
 * Curves are sampled here rather than at paint time so panning and zooming stay
 * cheap, and every entity type we cannot draw is counted so the UI can say what
 * was left out instead of quietly dropping it.
 */
function buildDrawing(parsed: RawDxf): Drawing {
  const shapes: Shape[] = [];
  const skipped: Record<string, number> = {};
  const layerCounts = new Map<string, number>();

  const note = (type: string) => {
    skipped[type] = (skipped[type] ?? 0) + 1;
  };

  const push = (shape: Shape) => {
    shapes.push(shape);
    layerCounts.set(shape.layer, (layerCounts.get(shape.layer) ?? 0) + 1);
  };

  const emit = (entity: RawEntity, transform: (point: Point) => Point, depth: number): void => {
    const layer = entity.layer || '0';
    switch (entity.type) {
      case 'LINE':
      case 'LWPOLYLINE':
      case 'POLYLINE': {
        const points = (entity.vertices ?? []).map((vertex) => transform({ x: vertex.x, y: vertex.y }));
        if (points.length >= 2) push({ kind: 'polyline', layer, points, closed: Boolean(entity.shape ?? entity.closed) });
        break;
      }
      case 'CIRCLE': {
        if (!entity.center || entity.radius === undefined) break;
        const centre = transform({ x: entity.center.x, y: entity.center.y });
        push({ kind: 'circle', layer, center: centre, radius: entity.radius * scaleOf(transform) });
        break;
      }
      case 'ARC': {
        if (!entity.center || entity.radius === undefined) break;
        const centre = transform({ x: entity.center.x, y: entity.center.y });
        push({
          kind: 'arc',
          layer,
          center: centre,
          radius: entity.radius * scaleOf(transform),
          start: entity.startAngle ?? 0,
          end: entity.endAngle ?? Math.PI * 2,
        });
        break;
      }
      case 'ELLIPSE': {
        if (!entity.center || !entity.majorAxisEndPoint) break;
        const points = sampleEllipse(entity).map(transform);
        if (points.length >= 2) push({ kind: 'polyline', layer, points, closed: false });
        break;
      }
      case 'SPLINE': {
        // Fit points describe the curve directly; control points only approximate
        // it, which is honest enough for a viewer and never wrong by much.
        const source = entity.fitPoints?.length ? entity.fitPoints : entity.controlPoints;
        const points = (source ?? []).map((point) => transform({ x: point.x, y: point.y }));
        if (points.length >= 2) push({ kind: 'polyline', layer, points, closed: false });
        break;
      }
      case 'POINT': {
        const position = entity.position ?? entity.startPoint;
        if (!position) break;
        const at = transform({ x: position.x, y: position.y });
        const tick = 0.5;
        push({ kind: 'polyline', layer, points: [{ x: at.x - tick, y: at.y }, { x: at.x + tick, y: at.y }], closed: false });
        break;
      }
      case 'TEXT':
      case 'MTEXT': {
        const position = entity.startPoint ?? entity.position;
        if (!position || !entity.text) break;
        push({
          kind: 'text',
          layer,
          at: transform({ x: position.x, y: position.y }),
          text: String(entity.text).replace(/\\[A-Za-z][^;]*;/g, '').slice(0, 200),
          height: (entity.textHeight ?? entity.height ?? 2.5) * scaleOf(transform),
          rotation: ((entity.rotation ?? 0) * Math.PI) / 180,
        });
        break;
      }
      case 'INSERT': {
        if (depth > 8) {
          note('INSERT (too deeply nested)');
          break;
        }
        const block = entity.name ? parsed.blocks?.[entity.name] : undefined;
        if (!block?.entities) {
          note('INSERT (block not found)');
          break;
        }
        const origin = entity.position ?? { x: 0, y: 0 };
        const scaleX = entity.xScale ?? 1;
        const scaleY = entity.yScale ?? 1;
        const angle = ((entity.rotation ?? 0) * Math.PI) / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const nested = (point: Point): Point =>
          transform({
            x: origin.x + (point.x * scaleX * cos - point.y * scaleY * sin),
            y: origin.y + (point.x * scaleX * sin + point.y * scaleY * cos),
          });
        for (const child of block.entities) emit(child, nested, depth + 1);
        break;
      }
      default:
        note(entity.type);
    }
  };

  const identity = (point: Point) => point;
  for (const entity of parsed.entities ?? []) emit(entity, identity, 0);

  /* --------------------------------- layers ------------------------------- */
  const layerTable = parsed.tables?.layer?.layers ?? {};
  const layers = [...layerCounts.entries()]
    .map(([name, count]) => ({
      name,
      count,
      color: aciToHex(layerTable[name]?.color),
    }))
    .sort((a, b) => b.count - a.count);

  /* --------------------------------- bounds ------------------------------- */
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const shape of shapes) {
    if (shape.kind === 'polyline') for (const point of shape.points) grow(point.x, point.y);
    else if (shape.kind === 'circle' || shape.kind === 'arc') {
      grow(shape.center.x - shape.radius, shape.center.y - shape.radius);
      grow(shape.center.x + shape.radius, shape.center.y + shape.radius);
    } else grow(shape.at.x, shape.at.y);
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 1;
    maxY = 1;
  }

  const insUnits = Number((parsed.header as Record<string, number> | undefined)?.$INSUNITS ?? 0);

  return { shapes, layers, bounds: { minX, minY, maxX, maxY }, units: UNIT_NAMES[insUnits] ?? 'units', skipped };
}

/** Uniform scale factor implied by a transform, used for radii and text. */
function scaleOf(transform: (point: Point) => Point): number {
  const origin = transform({ x: 0, y: 0 });
  const unit = transform({ x: 1, y: 0 });
  return Math.hypot(unit.x - origin.x, unit.y - origin.y) || 1;
}

function sampleEllipse(entity: RawEntity): Point[] {
  const centre = entity.center as Point;
  const major = entity.majorAxisEndPoint as Point;
  const ratio = entity.axisRatio ?? 1;
  const majorLength = Math.hypot(major.x, major.y);
  const rotation = Math.atan2(major.y, major.x);
  const start = entity.startAngle ?? 0;
  const end = entity.endAngle ?? Math.PI * 2;
  const sweep = end > start ? end - start : end - start + Math.PI * 2;

  const steps = 64;
  const points: Point[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const angle = start + (sweep * i) / steps;
    const x = majorLength * Math.cos(angle);
    const y = majorLength * ratio * Math.sin(angle);
    points.push({
      x: centre.x + x * Math.cos(rotation) - y * Math.sin(rotation),
      y: centre.y + x * Math.sin(rotation) + y * Math.cos(rotation),
    });
  }
  return points;
}

/** dxf-parser hands back a 24-bit colour; 0 and 7 mean "by block / default". */
function aciToHex(color: number | undefined): string {
  if (color === undefined || color === null || color === 0) return LAYER_FALLBACK;
  const hex = `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
  // Pure black is invisible on a dark canvas; treat it as the default ink.
  return hex === '#000000' ? LAYER_FALLBACK : hex;
}
