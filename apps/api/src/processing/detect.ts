import fs from 'node:fs/promises';
import AdmZip from 'adm-zip';
import { FORMATS, formatByExtension, type FormatDescriptor } from '@docuview/shared';

export interface DetectionResult {
  format: FormatDescriptor | null;
  /** Human readable version/flavour, e.g. `AP214`, `AutoCAD 2018 (AC1032)`. */
  version: string | null;
  /** The extension pointed somewhere else than the content did. */
  extensionMismatch: boolean;
  /** Free-form notes for the log (never shown to the user). */
  detail: string;
}

const HEAD_BYTES = 8192;

function ascii(buf: Buffer, start: number, length: number): string {
  return buf.subarray(start, start + length).toString('latin1');
}

function startsWith(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === b);
}

/* --------------------------- version extraction --------------------------- */

const DWG_VERSIONS: Record<string, string> = {
  AC1006: 'AutoCAD R10',
  AC1009: 'AutoCAD R11/R12',
  AC1012: 'AutoCAD R13',
  AC1014: 'AutoCAD R14',
  AC1015: 'AutoCAD 2000-2002',
  AC1018: 'AutoCAD 2004-2006',
  AC1021: 'AutoCAD 2007-2009',
  AC1024: 'AutoCAD 2010-2012',
  AC1027: 'AutoCAD 2013-2017',
  AC1032: 'AutoCAD 2018+',
  AC1500: 'AutoCAD 2025+',
};

function stepVersion(text: string): string | null {
  const schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i.exec(text);
  if (!schema) return null;
  const raw = schema[1].toUpperCase();
  if (raw.includes('AP242') || raw.includes('MANAGED_MODEL_BASED')) return 'AP242';
  if (raw.includes('AUTOMOTIVE_DESIGN')) return 'AP214';
  if (raw.includes('CONFIG_CONTROL_DESIGN')) return 'AP203';
  if (raw.includes('AP203')) return 'AP203';
  if (raw.includes('IFC')) return raw.split('_')[0];
  return raw.split('{')[0].slice(0, 40);
}

function dxfVersion(text: string): string | null {
  const match = /\$ACADVER\s*[\r\n]+\s*1\s*[\r\n]+\s*(AC\d{4})/i.exec(text);
  if (!match) return null;
  const code = match[1].toUpperCase();
  return DWG_VERSIONS[code] ? `${DWG_VERSIONS[code]} (${code})` : code;
}

/* ------------------------------- containers ------------------------------- */

interface ZipProbe {
  formatId: string | null;
  detail: string;
}

/** Peek inside a ZIP container to tell OOXML / ODF / 3MF apart. */
function probeZip(filePath: string): ZipProbe {
  try {
    const zip = new AdmZip(filePath);
    const names = zip.getEntries().map((e) => e.entryName);
    const has = (needle: string) => names.some((n) => n.toLowerCase() === needle);
    const hasPrefix = (prefix: string) => names.some((n) => n.toLowerCase().startsWith(prefix));

    if (hasPrefix('3d/') && names.some((n) => n.toLowerCase().endsWith('.model'))) {
      return { formatId: '3mf', detail: 'zip:3mf' };
    }
    if (has('word/document.xml') || hasPrefix('word/')) return { formatId: 'docx', detail: 'zip:ooxml-word' };
    if (has('xl/workbook.xml') || hasPrefix('xl/')) return { formatId: 'xlsx', detail: 'zip:ooxml-excel' };
    if (hasPrefix('ppt/')) return { formatId: 'pptx', detail: 'zip:ooxml-ppt' };

    const mimetype = zip.getEntry('mimetype');
    if (mimetype) {
      const mime = mimetype.getData().toString('utf8').trim();
      if (mime.includes('opendocument.text')) return { formatId: 'odt', detail: 'zip:odf-text' };
      if (mime.includes('opendocument.spreadsheet')) return { formatId: 'ods', detail: 'zip:odf-sheet' };
      if (mime.includes('opendocument.presentation')) return { formatId: 'odp', detail: 'zip:odf-slides' };
    }
    if (names.some((n) => n.toLowerCase().endsWith('.gltf'))) return { formatId: 'gltf', detail: 'zip:gltf' };
    return { formatId: null, detail: `zip:unknown(${names.slice(0, 3).join(',')})` };
  } catch (err) {
    return { formatId: null, detail: `zip:unreadable(${(err as Error).message})` };
  }
}

/** Legacy OLE compound files: Word/Excel/PowerPoint before 2007. */
function probeOle(head: Buffer, tail: Buffer): ZipProbe {
  // Stream names inside a CFB are stored UTF-16LE; strip the zero bytes and
  // look for the well known root stream names.
  const text = Buffer.concat([head, tail]).toString('latin1').replace(/\u0000/g, '');
  if (text.includes('WordDocument')) return { formatId: 'doc', detail: 'ole:word' };
  if (text.includes('Workbook') || text.includes('Book')) return { formatId: 'xls', detail: 'ole:excel' };
  if (text.includes('PowerPoint Document')) return { formatId: 'ppt', detail: 'ole:ppt' };
  return { formatId: null, detail: 'ole:unknown' };
}

/** Binary STL has a 80 byte header followed by a uint32 triangle count. */
function looksLikeBinaryStl(head: Buffer, size: number): boolean {
  if (head.length < 84 || size < 84) return false;
  const count = head.readUInt32LE(80);
  return 84 + count * 50 === size;
}

function looksLikeObj(text: string): boolean {
  const lines = text.split(/\r?\n/, 200);
  let verts = 0;
  let faces = 0;
  for (const line of lines) {
    if (/^v\s+-?\d/.test(line)) verts += 1;
    else if (/^f\s+\S+/.test(line)) faces += 1;
  }
  return verts > 2 || (verts > 0 && faces > 0);
}

function looksLikeDxf(text: string): boolean {
  return /^\s*0\s*[\r\n]+SECTION/.test(text) || /\bHEADER\b[\s\S]{0,4000}\$ACADVER/.test(text);
}

function looksLikeCsv(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, 10);
  if (lines.length < 2) return false;
  const counts = lines.map((l) => (l.match(/[,;\t]/g) ?? []).length);
  return counts[0] > 0 && counts.every((c) => c === counts[0]);
}

/* --------------------------------- main ---------------------------------- */

/**
 * Identify a file by its content, then reconcile with the extension.
 *
 * The extension is only used as a tie-breaker for ambiguous text formats — a
 * renamed executable can never be promoted into a "supported" format.
 */
export async function detectFormat(
  filePath: string,
  originalExtension: string,
  size: number,
): Promise<DetectionResult> {
  const handle = await fs.open(filePath, 'r');
  let head: Buffer;
  let tail: Buffer;
  try {
    head = Buffer.alloc(Math.min(HEAD_BYTES, size));
    await handle.read(head, 0, head.length, 0);
    const tailLength = Math.min(2048, size);
    tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, Math.max(0, size - tailLength));
  } finally {
    await handle.close();
  }

  const byExt = formatByExtension(originalExtension);
  const headText = head.toString('utf8');
  const headAscii = ascii(head, 0, Math.min(head.length, 4096));

  const decide = (formatId: string | null, version: string | null, detail: string): DetectionResult => {
    const format = formatId ? FORMATS.find((f) => f.id === formatId) ?? null : null;
    return {
      format,
      version,
      extensionMismatch: Boolean(format && byExt && byExt.id !== format.id),
      detail,
    };
  };

  /* --- unambiguous binary signatures ------------------------------------ */
  if (headAscii.startsWith('%PDF-')) {
    const version = /^%PDF-(\d\.\d)/.exec(headAscii)?.[1];
    return decide('pdf', version ? `PDF ${version}` : null, 'magic:pdf');
  }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) {
    const probe = probeZip(filePath);
    if (probe.formatId) return decide(probe.formatId, null, probe.detail);
    return decide(null, null, probe.detail);
  }
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    const probe = probeOle(head, tail);
    if (probe.formatId) return decide(probe.formatId, 'Office 97-2003', probe.detail);
    return decide(null, 'Office 97-2003', probe.detail);
  }
  if (headAscii.startsWith('glTF')) {
    const version = head.length >= 24 ? head.readUInt32LE(4) : 0;
    return decide('gltf', `glTF ${version || 2} (binary)`, 'magic:glb');
  }
  if (headAscii.startsWith('Kaydara FBX Binary')) {
    const raw = head.length >= 27 ? head.readUInt32LE(23) : 0;
    const version = raw > 1000 ? `FBX ${(raw / 1000).toFixed(1)}` : null;
    return decide('fbx', version, 'magic:fbx-binary');
  }
  if (headAscii.includes('FBXHeaderExtension')) {
    return decide('fbx', 'FBX ASCII', 'magic:fbx-ascii');
  }
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47])) return decide('image', 'PNG', 'magic:png');
  if (startsWith(head, [0xff, 0xd8, 0xff])) return decide('image', 'JPEG', 'magic:jpeg');
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) return decide('image', 'GIF', 'magic:gif');
  if (startsWith(head, [0x42, 0x4d]) && originalExtension === 'bmp') return decide('image', 'BMP', 'magic:bmp');
  if (headAscii.startsWith('RIFF') && ascii(head, 8, 4) === 'WEBP') return decide('image', 'WebP', 'magic:webp');
  if (headAscii.startsWith('{\\rtf')) return decide('rtf', null, 'magic:rtf');

  const dwgTag = ascii(head, 0, 6);
  if (/^AC1[0-9A-F]{3}$/i.test(dwgTag) || dwgTag === 'AC1500') {
    const label = DWG_VERSIONS[dwgTag.toUpperCase()];
    return decide('dwg', label ? `${label} (${dwgTag})` : dwgTag, 'magic:dwg');
  }
  if (headAscii.startsWith('AutoCAD Binary DXF')) {
    return decide('dxf', 'Binary DXF', 'magic:dxf-binary');
  }
  if (looksLikeBinaryStl(head, size)) {
    return decide('stl', 'Binary STL', 'magic:stl-binary');
  }
  if (/^ply\r?\n/.test(headText)) return decide('ply', null, 'magic:ply');

  /* --- text based formats ----------------------------------------------- */
  const trimmed = headText.replace(/^﻿/, '').trimStart();

  if (/^ISO-10303-21/i.test(trimmed)) {
    const isIfc = /FILE_SCHEMA\s*\(\s*\(\s*'IFC/i.test(headText);
    return decide(isIfc ? 'ifc' : 'step', stepVersion(headText), 'magic:step');
  }
  // IGES: fixed 80 column records with a section letter in column 73.
  if (head.length > 80) {
    const firstLine = headText.split(/\r?\n/)[0] ?? '';
    if (firstLine.length >= 80 && /[SGDPT]\s*\d+\s*$/.test(firstLine.slice(72))) {
      const version = /1\.0|5\.[0-9]/.exec(headText.slice(0, 2000))?.[0];
      return decide('iges', version ? `IGES ${version}` : null, 'magic:iges');
    }
  }
  if (/^(DBRep_DrawableShape|CASCADE Topology)/.test(trimmed)) {
    return decide('brep', null, 'magic:brep');
  }
  if (looksLikeDxf(trimmed)) {
    return decide('dxf', dxfVersion(headText), 'magic:dxf-ascii');
  }
  if (/^solid\s/i.test(trimmed) && /facet\s+normal/i.test(headText)) {
    return decide('stl', 'ASCII STL', 'magic:stl-ascii');
  }
  if (/^<\?xml/.test(trimmed) || /^<svg/i.test(trimmed)) {
    if (/<COLLADA/i.test(headText)) return decide('dae', null, 'magic:collada');
    if (/<svg/i.test(headText)) return decide('image', 'SVG', 'magic:svg');
    if (/<gltf/i.test(headText)) return decide('gltf', null, 'magic:gltf-xml');
  }
  if (/^\s*\{/.test(trimmed) && /"asset"\s*:/.test(headText) && /"version"/.test(headText)) {
    return decide('gltf', 'glTF 2.0 (JSON)', 'magic:gltf-json');
  }
  if (looksLikeObj(trimmed)) {
    return decide('obj', null, 'heuristic:obj');
  }

  /* --- last resort: trust the extension only for plain-text families ----- */
  const printable = head.subarray(0, 1024).filter((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)).length;
  const isMostlyText = head.length === 0 || printable / Math.min(head.length, 1024) > 0.9;

  if (isMostlyText) {
    if (byExt && (byExt.id === 'csv' || byExt.id === 'txt')) {
      return decide(byExt.id, null, 'extension:text');
    }
    if (looksLikeCsv(trimmed)) return decide('csv', null, 'heuristic:csv');
    if (byExt && byExt.pipeline === 'unsupported') return decide(byExt.id, null, 'extension:unsupported');
    return decide('txt', null, 'heuristic:text');
  }

  // Binary blob we do not recognise. Proprietary CAD formats are matched on the
  // extension so we can show a specific message instead of a generic failure.
  if (byExt && byExt.pipeline === 'unsupported') {
    return decide(byExt.id, null, 'extension:proprietary-binary');
  }
  return decide(null, null, 'unknown:binary');
}
