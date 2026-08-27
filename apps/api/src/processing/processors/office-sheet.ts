import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { JobResult, SheetCell, SheetCellStyle, SheetData, SheetDocument } from '@docuview/shared';
import { libreOfficeConvert } from '../libreoffice.js';
import { ProcessingError, type ProcessorContext } from '../context.js';

/** Guard rails so a pathological workbook cannot exhaust the box. */
const MAX_SHEETS = 60;
const MAX_CELLS_PER_SHEET = 200_000;
const MAX_COLS = 512;
const MAX_ROWS = 20_000;

const NEEDS_CONVERSION = new Set(['xls', 'ods']);

export async function processSheet(ctx: ProcessorContext): Promise<JobResult> {
  const { request } = ctx;
  await fs.mkdir(request.assetsDir, { recursive: true });

  if (request.formatId === 'csv') return processCsv(ctx);

  ctx.progress('processing', 15);
  const warnings: string[] = [];
  let workbookPath = request.filePath;
  let workDir: string | null = null;

  if (NEEDS_CONVERSION.has(request.formatId)) {
    workDir = path.join(os.tmpdir(), `docuview-sheet-${randomUUID()}`);
    const staged = path.join(workDir, `book.${request.formatId}`);
    await fs.mkdir(workDir, { recursive: true });
    await fs.copyFile(request.filePath, staged);
    ctx.progress('processing', 30);
    workbookPath = await libreOfficeConvert({
      bin: request.options.libreOfficeBin,
      inputPath: staged,
      target: 'xlsx',
      outExtension: 'xlsx',
      outDir: path.join(workDir, 'out'),
      timeoutMs: Math.min(request.options.timeoutMs, 120_000),
    });
    warnings.push('Converted from a legacy spreadsheet format; some formatting may differ.');
  }

  try {
    ctx.progress('processing', 50);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(workbookPath);

    const sheets: SheetData[] = [];
    let sheetCount = 0;
    for (const worksheet of workbook.worksheets) {
      if (worksheet.state === 'veryHidden') continue;
      if (sheetCount >= MAX_SHEETS) {
        warnings.push(`Only the first ${MAX_SHEETS} sheets are shown.`);
        break;
      }
      sheetCount += 1;
      sheets.push(readSheet(worksheet, warnings));
    }

    if (sheets.length === 0) {
      throw new ProcessingError(
        'empty_document',
        'This workbook does not contain any visible sheets.',
        undefined,
        false,
        'no worksheets',
      );
    }

    ctx.progress('preparing-geometry', 85);
    const document: SheetDocument = { sheets, producer: 'exceljs', warnings };
    await fs.writeFile(path.join(request.assetsDir, 'sheets.json'), JSON.stringify(document));

    return {
      kind: 'office',
      viewer: 'office-sheet',
      source: `/api/v1/files/${request.fileId}/assets/sheets.json`,
      meta: {
        formatId: request.formatId,
        sheetCount: sheets.length,
        sheetNames: sheets.map((s) => s.name),
        pdfRendition: request.options.libreOfficeBin ? `/api/v1/files/${request.fileId}/rendition/pdf` : null,
        producer: 'exceljs',
      },
      warnings,
    };
  } catch (err) {
    if (err instanceof ProcessingError) throw err;
    throw new ProcessingError(
      'conversion_failed',
      "We couldn't read this spreadsheet.",
      'The file may be corrupted or password protected.',
      false,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* --------------------------------- reading -------------------------------- */

function readSheet(worksheet: ExcelJS.Worksheet, warnings: string[]): SheetData {
  const cells: SheetCell[] = [];
  let maxRow = 0;
  let maxCol = 0;
  let truncated = false;

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber > MAX_ROWS || cells.length >= MAX_CELLS_PER_SHEET) {
      truncated = true;
      return;
    }
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      if (colNumber > MAX_COLS || cells.length >= MAX_CELLS_PER_SHEET) {
        truncated = true;
        return;
      }
      const rendered = renderValue(cell);
      if (rendered.text === '' && !hasVisibleStyle(cell)) return;
      if (rowNumber > maxRow) maxRow = rowNumber;
      if (colNumber > maxCol) maxCol = colNumber;
      const style = readStyle(cell, rendered.type);
      cells.push({ r: rowNumber, c: colNumber, t: rendered.text, ty: rendered.type, ...(style ? { s: style } : {}) });
    });
  });

  if (truncated) {
    warnings.push(`Sheet "${worksheet.name}" is very large; only part of it is shown.`);
  }

  const merges: SheetData['merges'] = [];
  // exceljs exposes merges as `A1:B2` strings on the sheet model.
  const rawMerges = (worksheet.model as { merges?: string[] }).merges ?? [];
  for (const range of rawMerges) {
    const parsed = parseRange(range);
    if (parsed) merges.push(parsed);
  }

  const colWidths: number[] = [];
  for (let c = 1; c <= Math.min(maxCol, MAX_COLS); c += 1) {
    const column = worksheet.getColumn(c);
    colWidths.push(column?.width ?? 8.43);
  }
  const rowHeights: number[] = [];
  for (let r = 1; r <= Math.min(maxRow, MAX_ROWS); r += 1) {
    const row = worksheet.getRow(r);
    rowHeights.push(row?.height ?? 15);
  }

  return {
    name: worksheet.name || `Sheet ${worksheet.id}`,
    rowCount: maxRow,
    colCount: maxCol,
    colWidths,
    rowHeights,
    cells,
    merges,
  };
}

function parseRange(range: string): SheetData['merges'][number] | null {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range.toUpperCase());
  if (!match) return null;
  return {
    top: Number(match[2]),
    left: columnToNumber(match[1]),
    bottom: Number(match[4]),
    right: columnToNumber(match[3]),
  };
}

function columnToNumber(letters: string): number {
  let value = 0;
  for (const char of letters) value = value * 26 + (char.charCodeAt(0) - 64);
  return value;
}

interface Rendered {
  text: string;
  type: SheetCell['ty'];
}

function renderValue(cell: ExcelJS.Cell): Rendered {
  const value = cell.value;
  if (value === null || value === undefined) return { text: '', type: 'string' };

  if (typeof value === 'number') return { text: formatNumber(value, cell.numFmt), type: 'number' };
  if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE', type: 'bool' };
  if (typeof value === 'string') return { text: value, type: 'string' };
  if (value instanceof Date) return { text: formatDate(value, cell.numFmt), type: 'date' };

  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) {
      return { text: value.richText.map((part) => part.text).join(''), type: 'string' };
    }
    if ('formula' in value || 'sharedFormula' in value) {
      const inner = (value as { result?: unknown }).result;
      if (inner === null || inner === undefined) return { text: '', type: 'formula' };
      if (typeof inner === 'number') return { text: formatNumber(inner, cell.numFmt), type: 'number' };
      if (inner instanceof Date) return { text: formatDate(inner, cell.numFmt), type: 'date' };
      if (typeof inner === 'object' && inner !== null && 'error' in (inner as object)) {
        return { text: String((inner as { error: string }).error), type: 'error' };
      }
      return { text: String(inner), type: 'formula' };
    }
    if ('error' in value) return { text: String((value as { error: string }).error), type: 'error' };
    if ('text' in value) return { text: String((value as { text: string }).text), type: 'string' };
    if ('hyperlink' in value) return { text: String((value as { hyperlink: string }).hyperlink), type: 'string' };
  }
  return { text: String(value), type: 'string' };
}

/**
 * A deliberately small number-format interpreter: enough for the common
 * currency/percent/decimal patterns without pulling in a formatting engine.
 * Anything exotic falls back to the raw value, which is honest.
 */
function formatNumber(value: number, numFmt: string | undefined): string {
  if (!numFmt || numFmt === 'General') {
    return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)));
  }
  if (/[hmsy]/i.test(numFmt) && /(yy|mm|dd|hh|ss)/i.test(numFmt)) {
    // Excel serial date.
    return formatDate(excelSerialToDate(value), numFmt);
  }
  const isPercent = numFmt.includes('%');
  const scaled = isPercent ? value * 100 : value;
  const decimalsMatch = /\.(0+)/.exec(numFmt);
  const decimals = decimalsMatch ? decimalsMatch[1].length : Number.isInteger(scaled) ? 0 : 2;
  const grouped = numFmt.includes('#,##') || numFmt.includes('0,0');
  let text = grouped
    ? scaled.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    : scaled.toFixed(decimals);
  if (isPercent) text += '%';
  const currency = /(\$|€|£|¥|₽)/.exec(numFmt);
  if (currency) text = `${currency[1]}${text}`;
  return text;
}

function excelSerialToDate(serial: number): Date {
  // Excel's epoch is 1899-12-30 (accounting for the 1900 leap year bug).
  return new Date(Math.round((serial - 25569) * 86400 * 1000));
}

function formatDate(date: Date, numFmt: string | undefined): string {
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const datePart = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const hasTime = numFmt ? /h/i.test(numFmt) : false;
  if (!hasTime) return datePart;
  return `${datePart} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function hasVisibleStyle(cell: ExcelJS.Cell): boolean {
  const fill = cell.fill as ExcelJS.FillPattern | undefined;
  return Boolean(fill && fill.type === 'pattern' && fill.pattern !== 'none' && fill.fgColor);
}

function readStyle(cell: ExcelJS.Cell, type: SheetCell['ty']): SheetCellStyle | undefined {
  const style: SheetCellStyle = {};
  const font = cell.font;
  if (font?.bold) style.b = true;
  if (font?.italic) style.i = true;
  if (font?.underline) style.u = true;
  if (font?.size && font.size !== 11) style.fs = font.size;
  const fg = argbToHex(font?.color?.argb);
  if (fg && fg !== '#000000') style.fg = fg;

  const fill = cell.fill as ExcelJS.FillPattern | undefined;
  if (fill?.type === 'pattern' && fill.pattern !== 'none') {
    const bg = argbToHex(fill.fgColor?.argb);
    if (bg && bg !== '#FFFFFF') style.bg = bg;
  }

  const horizontal = cell.alignment?.horizontal;
  if (horizontal === 'left' || horizontal === 'center' || horizontal === 'right') style.ha = horizontal;
  else if (type === 'number' || type === 'date') style.ha = 'right';

  return Object.keys(style).length > 0 ? style : undefined;
}

function argbToHex(argb: string | undefined): string | undefined {
  if (!argb || argb.length < 6) return undefined;
  const rgb = argb.length === 8 ? argb.slice(2) : argb;
  return `#${rgb.toUpperCase()}`;
}

/* ----------------------------------- CSV ---------------------------------- */

async function processCsv(ctx: ProcessorContext): Promise<JobResult> {
  const { request } = ctx;
  const warnings: string[] = [];
  const MAX_BYTES = 20 * 1024 * 1024;

  const handle = await fs.open(request.filePath, 'r');
  let text: string;
  try {
    const length = Math.min(request.size, MAX_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    text = buffer.toString('utf8');
    if (request.size > MAX_BYTES) warnings.push('Only the first 20 MB of this file are shown.');
  } finally {
    await handle.close();
  }

  const delimiter = detectDelimiter(text);
  const rows = parseDelimited(text, delimiter);
  if (rows.length > MAX_ROWS) {
    rows.length = MAX_ROWS;
    warnings.push(`Only the first ${MAX_ROWS} rows are shown.`);
  }

  const cells: SheetCell[] = [];
  let maxCol = 0;
  rows.forEach((row, rowIndex) => {
    row.forEach((value, colIndex) => {
      if (colIndex >= MAX_COLS) return;
      if (value === '') return;
      const numeric = Number(value);
      const isNumber = value.trim() !== '' && Number.isFinite(numeric);
      cells.push({
        r: rowIndex + 1,
        c: colIndex + 1,
        t: value,
        ty: isNumber ? 'number' : 'string',
        ...(isNumber ? { s: { ha: 'right' as const } } : {}),
      });
      if (colIndex + 1 > maxCol) maxCol = colIndex + 1;
    });
  });

  const sheet: SheetData = {
    name: request.displayName.replace(/\.[^.]+$/, '') || 'Data',
    rowCount: rows.length,
    colCount: maxCol,
    colWidths: new Array(maxCol).fill(14),
    rowHeights: new Array(rows.length).fill(15),
    cells,
    merges: [],
  };

  const document: SheetDocument = { sheets: [sheet], producer: 'csv-parser', warnings };
  await fs.writeFile(path.join(request.assetsDir, 'sheets.json'), JSON.stringify(document));

  return {
    kind: 'office',
    viewer: 'office-sheet',
    source: `/api/v1/files/${request.fileId}/assets/sheets.json`,
    meta: { formatId: 'csv', sheetCount: 1, sheetNames: [sheet.name], pdfRendition: null, producer: 'csv-parser' },
    warnings,
  };
}

function detectDelimiter(text: string): string {
  const sample = text.slice(0, 8192);
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = sample.split(candidate).length;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** RFC 4180 style parser: quoted fields, doubled quotes, CRLF or LF. */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
