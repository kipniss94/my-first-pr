'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SheetCell, SheetData, SheetDocument } from '@docuview/shared';
import { apiUrl } from '@/lib/api';
import { formatCount } from '@/lib/format';
import { ErrorPanel } from '@/components/viewer/ErrorPanel';
import { ViewerAdRail } from '@/components/site/AdSlot';
import { PageLayoutToggle } from './PageLayoutToggle';

interface SheetViewerProps {
  source: string;
  meta: Record<string, unknown>;
  fileId: string | null;
  onReady(): void;
}

const ROW_HEADER_WIDTH = 52;
const HEADER_HEIGHT = 26;
const DEFAULT_ROW_HEIGHT = 22;
/** Excel column widths are in character units; this is the usual conversion. */
const CHAR_TO_PX = 7;
const OVERSCAN = 6;

export function SheetViewer({ source, meta, fileId, onReady }: SheetViewerProps) {
  const [document, setDocument] = useState<SheetDocument | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null);
  const [showPageLayout, setShowPageLayout] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(apiUrl(source));
        if (!response.ok) throw new Error(`http ${response.status}`);
        const parsed = (await response.json()) as SheetDocument;
        if (cancelled) return;
        setDocument(parsed);
        onReady();
      } catch {
        if (!cancelled) {
          setError({
            message: "We couldn't load this spreadsheet.",
            hint: 'The document may have expired. Try uploading it again.',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onReady, source]);

  const pdfRendition = typeof meta.pdfRendition === 'string' ? meta.pdfRendition : null;

  if (error) return <ErrorPanel error={{ code: 'sheet_failed', ...error, retryable: false }} />;
  if (!document) {
    return <div className="grid min-h-0 flex-1 place-items-center text-sm text-mist-400">Loading workbook…</div>;
  }

  if (showPageLayout && pdfRendition && fileId) {
    return (
      <PageLayoutToggle
        source={pdfRendition}
        label="workbook"
        onBack={() => setShowPageLayout(false)}
      />
    );
  }

  const sheet = document.sheets[activeSheet] ?? document.sheets[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-paper-2">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-ink-850 px-3">
        <span className="truncate text-[13px] text-mist-300">
          {formatCount(document.sheets.length)} sheet{document.sheets.length === 1 ? '' : 's'}
        </span>
        {selected && (
          <span className="font-mono text-[12px] text-mist-400">
            {columnLabel(selected.c)}
            {selected.r}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {pdfRendition && (
            <button type="button" onClick={() => setShowPageLayout(true)} className="btn btn-ghost">
              Page layout
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <Grid key={sheet.name} sheet={sheet} selected={selected} onSelect={setSelected} />
      </div>

      {document.sheets.length > 1 && (
        <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-t border-paper-line bg-paper-3 px-2">
          {document.sheets.map((entry, index) => (
            <button
              key={entry.name}
              type="button"
              onClick={() => {
                setActiveSheet(index);
                setSelected(null);
              }}
              aria-pressed={index === activeSheet}
              data-testid={`sheet-tab-${index}`}
              className={`shrink-0 rounded-t-md border-b-2 px-3 py-1.5 text-[13px] font-medium transition-colors ${
                index === activeSheet
                  ? 'border-accent bg-paper text-paper-ink'
                  : 'border-transparent text-paper-muted hover:bg-paper/60'
              }`}
            >
              {entry.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A windowed grid.
 *
 * Only the cells inside the viewport exist in the DOM, so a 200 000-cell sheet
 * scrolls as smoothly as a 20-cell one.
 */
function Grid({
  sheet,
  selected,
  onSelect,
}: {
  sheet: SheetData;
  selected: { r: number; c: number } | null;
  onSelect(cell: { r: number; c: number }): void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [size, setSize] = useState({ width: 0, height: 0 });

  const columnCount = Math.max(sheet.colCount, 1);
  const rowCount = Math.max(sheet.rowCount, 1);

  /* Prefix sums make "which row is at pixel Y" a binary search. */
  const columnOffsets = useMemo(() => {
    const offsets = new Float64Array(columnCount + 1);
    for (let c = 0; c < columnCount; c += 1) {
      const width = sheet.colWidths[c] ?? 8.43;
      offsets[c + 1] = offsets[c] + Math.max(24, Math.round(width * CHAR_TO_PX + 8));
    }
    return offsets;
  }, [columnCount, sheet.colWidths]);

  const rowOffsets = useMemo(() => {
    const offsets = new Float64Array(rowCount + 1);
    for (let r = 0; r < rowCount; r += 1) {
      const height = sheet.rowHeights[r];
      offsets[r + 1] = offsets[r] + Math.max(18, Math.round((height ?? DEFAULT_ROW_HEIGHT) * 1.33));
    }
    return offsets;
  }, [rowCount, sheet.rowHeights]);

  const cellIndex = useMemo(() => {
    const map = new Map<string, SheetCell>();
    for (const cell of sheet.cells) map.set(`${cell.r},${cell.c}`, cell);
    return map;
  }, [sheet.cells]);

  const mergeIndex = useMemo(() => {
    const anchors = new Map<string, { rows: number; cols: number }>();
    const covered = new Set<string>();
    for (const merge of sheet.merges) {
      anchors.set(`${merge.top},${merge.left}`, {
        rows: merge.bottom - merge.top + 1,
        cols: merge.right - merge.left + 1,
      });
      for (let r = merge.top; r <= merge.bottom; r += 1) {
        for (let c = merge.left; c <= merge.right; c += 1) {
          if (r !== merge.top || c !== merge.left) covered.add(`${r},${c}`);
        }
      }
    }
    return { anchors, covered };
  }, [sheet.merges]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    setSize({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    setScroll({ top: element.scrollTop, left: element.scrollLeft });
  }, []);

  const totalWidth = columnOffsets[columnCount];
  const totalHeight = rowOffsets[rowCount];

  const firstRow = Math.max(0, search(rowOffsets, scroll.top) - OVERSCAN);
  const lastRow = Math.min(rowCount - 1, search(rowOffsets, scroll.top + size.height) + OVERSCAN);
  const firstCol = Math.max(0, search(columnOffsets, scroll.left) - OVERSCAN);
  const lastCol = Math.min(columnCount - 1, search(columnOffsets, scroll.left + size.width) + OVERSCAN);

  const cells: React.ReactNode[] = [];
  for (let r = firstRow; r <= lastRow; r += 1) {
    for (let c = firstCol; c <= lastCol; c += 1) {
      const key = `${r + 1},${c + 1}`;
      if (mergeIndex.covered.has(key)) continue;
      const cell = cellIndex.get(key);
      const merge = mergeIndex.anchors.get(key);
      const width = merge
        ? columnOffsets[Math.min(columnCount, c + merge.cols)] - columnOffsets[c]
        : columnOffsets[c + 1] - columnOffsets[c];
      const height = merge
        ? rowOffsets[Math.min(rowCount, r + merge.rows)] - rowOffsets[r]
        : rowOffsets[r + 1] - rowOffsets[r];
      const isSelected = selected?.r === r + 1 && selected?.c === c + 1;

      cells.push(
        <div
          key={key}
          role="gridcell"
          onClick={() => onSelect({ r: r + 1, c: c + 1 })}
          className={`absolute flex items-center overflow-hidden border-b border-r border-paper-line px-1.5 text-[13px] ${
            isSelected ? 'outline outline-2 -outline-offset-2 outline-accent' : ''
          }`}
          style={{
            left: columnOffsets[c],
            top: rowOffsets[r],
            width,
            height,
            justifyContent: alignment(cell),
            backgroundColor: cell?.s?.bg ?? '#ffffff',
            color: cell?.s?.fg ?? '#0f1620',
            fontWeight: cell?.s?.b ? 600 : 400,
            fontStyle: cell?.s?.i ? 'italic' : undefined,
            textDecoration: cell?.s?.u ? 'underline' : undefined,
            fontSize: cell?.s?.fs ? `${Math.min(20, cell.s.fs)}px` : undefined,
            fontVariantNumeric: cell?.ty === 'number' ? 'tabular-nums' : undefined,
          }}
          title={cell?.t}
        >
          <span className="truncate">{cell?.t ?? ''}</span>
        </div>,
      );
    }
  }

  const columnHeaders: React.ReactNode[] = [];
  for (let c = firstCol; c <= lastCol; c += 1) {
    columnHeaders.push(
      <div
        key={c}
        className="absolute flex items-center justify-center border-b border-r border-paper-line bg-paper-3 text-[11px] font-medium text-paper-muted"
        style={{ left: columnOffsets[c], top: 0, width: columnOffsets[c + 1] - columnOffsets[c], height: HEADER_HEIGHT }}
      >
        {columnLabel(c + 1)}
      </div>,
    );
  }

  const rowHeaders: React.ReactNode[] = [];
  for (let r = firstRow; r <= lastRow; r += 1) {
    rowHeaders.push(
      <div
        key={r}
        className="absolute flex items-center justify-center border-b border-r border-paper-line bg-paper-3 text-[11px] font-medium text-paper-muted"
        style={{ left: 0, top: rowOffsets[r], width: ROW_HEADER_WIDTH, height: rowOffsets[r + 1] - rowOffsets[r] }}
      >
        {r + 1}
      </div>,
    );
  }

  return (
    <div className="relative h-full overflow-hidden bg-paper">
      {/* Corner */}
      <div
        className="absolute left-0 top-0 z-30 border-b border-r border-paper-line bg-paper-3"
        style={{ width: ROW_HEADER_WIDTH, height: HEADER_HEIGHT }}
      />
      {/* Column headers */}
      <div
        className="absolute top-0 z-20 overflow-hidden"
        style={{ left: ROW_HEADER_WIDTH, right: 0, height: HEADER_HEIGHT }}
      >
        <div className="relative h-full" style={{ transform: `translateX(${-scroll.left}px)`, width: totalWidth }}>
          {columnHeaders}
        </div>
      </div>
      {/* Row headers */}
      <div
        className="absolute left-0 z-20 overflow-hidden"
        style={{ top: HEADER_HEIGHT, bottom: 0, width: ROW_HEADER_WIDTH }}
      >
        <div className="relative w-full" style={{ transform: `translateY(${-scroll.top}px)`, height: totalHeight }}>
          {rowHeaders}
        </div>
      </div>
      {/* Cells */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="absolute overflow-auto"
        style={{ left: ROW_HEADER_WIDTH, top: HEADER_HEIGHT, right: 0, bottom: 0 }}
        role="grid"
        aria-rowcount={rowCount}
        aria-colcount={columnCount}
        data-testid="sheet-grid"
      >
        <div className="relative" style={{ width: totalWidth, height: totalHeight }}>
          {cells}
        </div>
      </div>
    </div>
  );
}

function alignment(cell: SheetCell | undefined): 'flex-start' | 'center' | 'flex-end' {
  if (!cell) return 'flex-start';
  if (cell.s?.ha === 'center') return 'center';
  if (cell.s?.ha === 'right') return 'flex-end';
  if (cell.ty === 'number' || cell.ty === 'date') return 'flex-end';
  return 'flex-start';
}

/** Index of the last offset that is <= value. */
function search(offsets: Float64Array, value: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid] <= value) low = mid;
    else high = mid - 1;
  }
  return low;
}

function columnLabel(index: number): string {
  let label = '';
  let value = index;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label || 'A';
}
