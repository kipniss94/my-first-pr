'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SheetCell, SheetData, SheetDocument } from '@docuview/shared';
import { fetchApi } from '@/lib/api';
import { editedName, originalBytes, saveEdited, saveToDisk } from '@/lib/edit';
import { useT } from '@/lib/prefs';
import { EditorBar } from './DocEditor';
import { ErrorPanel } from '@/components/viewer/ErrorPanel';
import { ViewerAdRail } from '@/components/site/AdSlot';
import { PageLayoutToggle } from './PageLayoutToggle';

interface SheetViewerProps {
  source: string;
  meta: Record<string, unknown>;
  fileId: string | null;
  fileName: string;
  onReady(): void;
}

const ROW_HEADER_WIDTH = 52;
const HEADER_HEIGHT = 26;
const DEFAULT_ROW_HEIGHT = 22;
/** Excel column widths are in character units; this is the usual conversion. */
const CHAR_TO_PX = 7;
const OVERSCAN = 6;

export function SheetViewer({ source, meta, fileId, fileName, onReady }: SheetViewerProps) {
  const { t, tp } = useT();
  const [editing, setEditing] = useState(false);
  /** Typed-in values by sheet, then by "row,column". */
  const [changes, setChanges] = useState<Map<string, Map<string, string>>>(new Map());
  const [deletedSheets, setDeletedSheets] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [document, setDocument] = useState<SheetDocument | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [selected, setSelected] = useState<{ r: number; c: number } | null>(null);
  const [showPageLayout, setShowPageLayout] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetchApi(source);
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
    return <div className="grid min-h-0 flex-1 place-items-center text-sm text-mist-400">{t('Loading workbook…')}</div>;
  }

  if (showPageLayout && pdfRendition && fileId) {
    return (
      <PageLayoutToggle
        source={pdfRendition}
        label={t('workbook')}
        onBack={() => setShowPageLayout(false)}
      />
    );
  }

  const sheet = document.sheets[activeSheet] ?? document.sheets[0];
  const formatId = typeof meta.formatId === 'string' ? meta.formatId : '';
  const editable = Boolean(fileId) && (formatId === 'xlsx' || formatId === 'csv');
  const changeCount = [...changes.values()].reduce((sum, cells) => sum + cells.size, 0) + deletedSheets.size;

  const setCell = (r: number, c: number, value: string) => {
    const original = sheet.cells.find((cell) => cell.r === r && cell.c === c)?.t ?? '';
    setChanges((current) => {
      const next = new Map(current);
      const cells = new Map(next.get(sheet.name) ?? []);
      if (value === original) cells.delete(`${r},${c}`);
      else cells.set(`${r},${c}`, value);
      next.set(sheet.name, cells);
      return next;
    });
  };

  const save = async () => {
    if (!fileId) return;
    setSaving(true);
    setNotice(null);
    try {
      let blob: Blob;
      if (formatId === 'csv') {
        blob = await rebuildCsv(fileId, document.sheets[0], changes.get(document.sheets[0].name) ?? new Map());
      } else {
        const cells = [...changes.entries()].flatMap(([name, values]) =>
          [...values.entries()].map(([key, value]) => {
            const [r, c] = key.split(',').map(Number);
            return { sheet: name, ref: `${columnLabel(c)}${r}`, value };
          }),
        );
        blob = await saveEdited(fileId, { xlsx: { cells, deleteSheets: [...deletedSheets] } });
      }
      if (await saveToDisk(blob, editedName(fileName))) setNotice(t('Saved. The original on the server is unchanged.'));
    } catch (err) {
      setNotice(t(err instanceof Error ? err.message : "We couldn't save these changes into the document."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-paper-2">
      {editing && (
        <EditorBar
          title={t('Editing')}
          fileName={fileName}
          info={t('Double-click a cell or start typing; Enter keeps the value. A sheet is deleted with × on its tab.')}
          changes={changeCount}
          saving={saving}
          saveLabel={formatId === 'csv' ? t('Save…') : t('Save as .xlsx…')}
          notice={notice}
          onSave={() => void save()}
          onClose={() => {
            if (changeCount > 0 && !window.confirm(t('Leave without saving? The changes will be lost.'))) return;
            setEditing(false);
            setChanges(new Map());
            setDeletedSheets(new Set());
            setNotice(null);
          }}
        />
      )}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-ink-850 px-3">
        <span className="truncate text-[13px] text-mist-300">
          {tp(document.sheets.length, ['{n} sheet', '{n} sheets'], ['{n} лист', '{n} листа', '{n} листов'])}
        </span>
        {selected && (
          <span className="font-mono text-[12px] text-mist-400">
            {columnLabel(selected.c)}
            {selected.r}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {fileId && !editing && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!editable}
              onClick={() => setEditing(true)}
              title={
                editable
                  ? t('Edit cells and delete sheets, then save to your computer')
                  : t('Editing works on .docx, .xlsx and .pptx; save older formats in those first.')
              }
              data-testid="edit-document"
            >
              {t('Edit')}
            </button>
          )}
          {pdfRendition && !editing && (
            <button type="button" onClick={() => setShowPageLayout(true)} className="btn btn-ghost">
              {t('Page layout')}
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <Grid
          key={sheet.name}
          sheet={sheet}
          selected={selected}
          onSelect={setSelected}
          overrides={changes.get(sheet.name) ?? null}
          onEdit={editing && !deletedSheets.has(sheet.name) ? setCell : null}
        />
      </div>

      {document.sheets.length > 1 && (
        <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-t border-paper-line bg-paper-3 px-2">
          {document.sheets.map((entry, index) => (
            <span key={entry.name} className="flex shrink-0 items-center">
              <button
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
                } ${deletedSheets.has(entry.name) ? 'line-through opacity-50' : ''}`}
              >
                {entry.name}
              </button>
              {editing && formatId === 'xlsx' && (
                <button
                  type="button"
                  className="ml-0.5 rounded px-1 text-[12px] text-paper-muted hover:bg-red-50 hover:text-red-700"
                  title={deletedSheets.has(entry.name) ? t('Restore the sheet') : t('Delete the sheet')}
                  aria-label={deletedSheets.has(entry.name) ? t('Restore the sheet') : t('Delete the sheet')}
                  data-testid="sheet-delete"
                  onClick={() =>
                    setDeletedSheets((current) => {
                      const next = new Set(current);
                      if (next.has(entry.name)) next.delete(entry.name);
                      else if (next.size < document.sheets.length - 1) next.add(entry.name);
                      return next;
                    })
                  }
                >
                  {deletedSheets.has(entry.name) ? '↺' : '×'}
                </button>
              )}
            </span>
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
  overrides,
  onEdit,
}: {
  sheet: SheetData;
  selected: { r: number; c: number } | null;
  onSelect(cell: { r: number; c: number }): void;
  /** Values typed in while editing, by "row,column". */
  overrides: Map<string, string> | null;
  /** Set while editing: a cell's new value. */
  onEdit: ((r: number, c: number, value: string) => void) | null;
}) {
  const [typing, setTyping] = useState<{ r: number; c: number; value: string } | null>(null);
  const startTyping = (r: number, c: number, initial?: string) => {
    if (!onEdit) return;
    const current = overrides?.get(`${r},${c}`) ?? sheet.cells.find((cell) => cell.r === r && cell.c === c)?.t ?? '';
    setTyping({ r, c, value: initial ?? current });
  };
  const finishTyping = (move: 'down' | 'right' | null) => {
    if (!typing || !onEdit) return;
    onEdit(typing.r, typing.c, typing.value);
    const next = move === 'down' ? { r: typing.r + 1, c: typing.c } : move === 'right' ? { r: typing.r, c: typing.c + 1 } : null;
    setTyping(null);
    if (next) onSelect(next);
  };
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
      const override = overrides?.get(key);
      const shown = override ?? cell?.t ?? '';

      cells.push(
        <div
          key={key}
          role="gridcell"
          onClick={() => onSelect({ r: r + 1, c: c + 1 })}
          onDoubleClick={() => startTyping(r + 1, c + 1)}
          className={`absolute flex items-center overflow-hidden border-b border-r border-paper-line px-1.5 text-[13px] ${
            isSelected ? 'outline outline-2 -outline-offset-2 outline-accent' : ''
          }`}
          style={{
            left: columnOffsets[c],
            top: rowOffsets[r],
            width,
            height,
            justifyContent: alignment(cell),
            backgroundColor: override !== undefined ? '#fff6d6' : (cell?.s?.bg ?? '#ffffff'),
            color: cell?.s?.fg ?? '#0f1620',
            fontWeight: cell?.s?.b ? 600 : 400,
            fontStyle: cell?.s?.i ? 'italic' : undefined,
            textDecoration: cell?.s?.u ? 'underline' : undefined,
            fontSize: cell?.s?.fs ? `${Math.min(20, cell.s.fs)}px` : undefined,
            fontVariantNumeric: cell?.ty === 'number' ? 'tabular-nums' : undefined,
          }}
          title={shown}
        >
          <span className="truncate">{shown}</span>
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
        tabIndex={0}
        onKeyDown={(event) => {
          if (typing || !selected) return;
          if (event.key === 'Enter' || event.key === 'F2') {
            event.preventDefault();
            startTyping(selected.r, selected.c);
          } else if (event.key === 'Delete' && onEdit) {
            onEdit(selected.r, selected.c, '');
          } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && onEdit) {
            event.preventDefault();
            startTyping(selected.r, selected.c, event.key);
          } else if (event.key.startsWith('Arrow')) {
            event.preventDefault();
            const dr = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
            const dc = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
            onSelect({ r: Math.max(1, selected.r + dr), c: Math.max(1, selected.c + dc) });
          }
        }}
        aria-rowcount={rowCount}
        aria-colcount={columnCount}
        data-testid="sheet-grid"
      >
        <div className="relative" style={{ width: totalWidth, height: totalHeight }}>
          {cells}
          {typing && (
            <input
              autoFocus
              value={typing.value}
              onChange={(event) => setTyping({ ...typing, value: event.target.value })}
              onBlur={() => finishTyping(null)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  finishTyping('down');
                } else if (event.key === 'Tab') {
                  event.preventDefault();
                  finishTyping('right');
                } else if (event.key === 'Escape') {
                  setTyping(null);
                }
              }}
              className="absolute z-10 border-2 border-accent bg-white px-1 text-[13px] text-[#0f1620] outline-none"
              style={{
                left: columnOffsets[Math.min(columnCount, typing.c - 1)] ?? 0,
                top: rowOffsets[Math.min(rowCount, typing.r - 1)] ?? 0,
                width: Math.max(80, (columnOffsets[typing.c] ?? 0) - (columnOffsets[typing.c - 1] ?? 0)),
                height: Math.max(22, (rowOffsets[typing.r] ?? 0) - (rowOffsets[typing.r - 1] ?? 0)),
              }}
              data-testid="sheet-cell-input"
            />
          )}
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

/** A CSV again, with the typed-in values, in the file's own delimiter. */
async function rebuildCsv(fileId: string, sheet: SheetData, changes: Map<string, string>): Promise<Blob> {
  const text = new TextDecoder('utf-8').decode(await originalBytes(fileId));
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const counts: [string, number][] = [';', ',', '\t'].map((d) => [d, firstLine.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  const delimiter = counts[0][1] > 0 ? counts[0][0] : ',';
  const values = new Map(sheet.cells.map((cell) => [`${cell.r},${cell.c}`, cell.t]));
  for (const [key, value] of changes) values.set(key, value);
  let rows = sheet.rowCount;
  let cols = sheet.colCount;
  for (const key of changes.keys()) {
    const [r, c] = key.split(',').map(Number);
    rows = Math.max(rows, r);
    cols = Math.max(cols, c);
  }
  const quote = (value: string) =>
    /["\r\n]/.test(value) || value.includes(delimiter) ? `"${value.replace(/"/g, '""')}"` : value;
  const lines: string[] = [];
  for (let r = 1; r <= rows; r += 1) {
    const line: string[] = [];
    for (let c = 1; c <= cols; c += 1) line.push(quote(values.get(`${r},${c}`) ?? ''));
    lines.push(line.join(delimiter));
  }
  // A byte-order mark tells Excel the file is UTF-8.
  return new Blob(['\uFEFF' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
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
