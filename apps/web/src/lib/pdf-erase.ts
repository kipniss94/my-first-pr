/**
 * Taking text out of a PDF page for good, not just covering it.
 *
 * A page's content stream is read the way a viewer reads it — graphics and
 * text state, text matrix, font widths — so every glyph shown has a place on
 * the page. Glyphs whose place lies in a run being replaced are cut out of
 * their Tj/TJ operator, each replaced by a TJ adjustment as wide as it was:
 * the rest of the line stays exactly where it was, and the old words are no
 * longer in the file to be found, copied or read. Text inside form XObjects,
 * in fonts whose widths are not in the file, or in vertical writing is left
 * alone; the caller covers it instead.
 */

type PdfLib = typeof import('pdf-lib');
type StandardFonts = typeof import('@pdf-lib/standard-fonts');
type PDFDocument = import('pdf-lib').PDFDocument;
type PDFPage = import('pdf-lib').PDFPage;
type PDFDict = import('pdf-lib').PDFDict;

/** A run of text to take out, as PDF.js placed it. */
export interface EraseRegion {
  /** [a, b, c, d, e, f]: the run's first glyph, in the page's user space. */
  transform: number[];
  /** Its advance, in the same units. */
  width: number;
  /** Its text, as PDF.js read it. */
  text: string;
}

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

/* ------------------------------- tokens -------------------------------- */

type Operand = number | Uint8Array | { name: string } | Operand[] | null;

interface Operation {
  op: string;
  operands: Operand[];
  /** Bytes from the first operand to the end of the operator. */
  start: number;
  end: number;
}

const isSpace = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
const isDelimiter = (c: number) =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

/** The operations of a content stream, each with its operands. */
export function parseContent(src: Uint8Array): Operation[] {
  const operations: Operation[] = [];
  let i = 0;
  const skipSpace = () => {
    while (i < src.length) {
      if (isSpace(src[i])) i += 1;
      else if (src[i] === 0x25) while (i < src.length && src[i] !== 0x0a && src[i] !== 0x0d) i += 1;
      else break;
    }
  };
  const regular = () => {
    const from = i;
    while (i < src.length && !isSpace(src[i]) && !isDelimiter(src[i])) i += 1;
    return String.fromCharCode(...src.subarray(from, i));
  };
  const literal = (): Uint8Array => {
    const out: number[] = [];
    let depth = 1;
    i += 1;
    while (i < src.length) {
      const c = src[i];
      if (c === 0x5c) {
        const n = src[i + 1];
        i += 2;
        if (n === 0x6e) out.push(0x0a);
        else if (n === 0x72) out.push(0x0d);
        else if (n === 0x74) out.push(0x09);
        else if (n === 0x62) out.push(0x08);
        else if (n === 0x66) out.push(0x0c);
        else if (n === 0x0d) {
          if (src[i] === 0x0a) i += 1;
        } else if (n === 0x0a) {
          // A line continued.
        } else if (n >= 0x30 && n <= 0x37) {
          let v = n - 0x30;
          for (let k = 0; k < 2 && src[i] >= 0x30 && src[i] <= 0x37; k += 1) v = v * 8 + (src[i++] - 0x30);
          out.push(v & 0xff);
        } else if (n !== undefined) out.push(n);
        continue;
      }
      if (c === 0x28) depth += 1;
      if (c === 0x29 && --depth === 0) {
        i += 1;
        break;
      }
      out.push(c);
      i += 1;
    }
    return Uint8Array.from(out);
  };
  const hex = (): Uint8Array => {
    const out: number[] = [];
    let high = -1;
    i += 1;
    while (i < src.length && src[i] !== 0x3e) {
      const v = hexValue(src[i]);
      i += 1;
      if (v < 0) continue;
      if (high < 0) high = v;
      else {
        out.push(high * 16 + v);
        high = -1;
      }
    }
    if (high >= 0) out.push(high * 16);
    i += 1;
    return Uint8Array.from(out);
  };
  const name = () => {
    i += 1;
    return { name: regular().replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))) };
  };
  // One operand, or null at an operator or the end of an array or dictionary.
  const operand = (): Operand | undefined => {
    skipSpace();
    if (i >= src.length) return undefined;
    const c = src[i];
    if (c === 0x28) return literal();
    if (c === 0x3c && src[i + 1] === 0x3c) {
      i += 2;
      // A dictionary (marked-content properties): kept whole, read past.
      for (;;) {
        skipSpace();
        if (i >= src.length) break;
        if (src[i] === 0x3e && src[i + 1] === 0x3e) {
          i += 2;
          break;
        }
        if (operand() === undefined) break;
      }
      return null;
    }
    if (c === 0x3c) return hex();
    if (c === 0x2f) return name();
    if (c === 0x5b) {
      i += 1;
      const items: Operand[] = [];
      for (;;) {
        skipSpace();
        if (i >= src.length) break;
        if (src[i] === 0x5d) {
          i += 1;
          break;
        }
        const item = operand();
        if (item === undefined) break;
        items.push(item);
      }
      return items;
    }
    if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7b || c === 0x7d) {
      i += 1;
      return null;
    }
    const from = i;
    const word = regular();
    if (word.length === 0) {
      i += 1;
      return null;
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return Number(word);
    if (word === 'true' || word === 'false' || word === 'null') return null;
    i = from;
    return undefined;
  };

  while (i < src.length) {
    skipSpace();
    if (i >= src.length) break;
    const start = i;
    const operands: Operand[] = [];
    for (;;) {
      const before = i;
      const value = operand();
      if (value === undefined) {
        i = before;
        break;
      }
      operands.push(value);
    }
    skipSpace();
    if (i >= src.length) break;
    const op = regular();
    if (op.length === 0) {
      i += 1;
      continue;
    }
    operations.push({ op, operands, start, end: i });
    if (op === 'BI') {
      // An inline image: its parameters, ID, one blank, the data, EI.
      while (i < src.length) {
        const at = i;
        skipSpace();
        if (src[i] === 0x49 && src[i + 1] === 0x44 && (isSpace(src[i + 2]) || i + 2 >= src.length)) {
          i += 3;
          break;
        }
        if (operand() === undefined) i = at + 1;
      }
      while (i < src.length) {
        if (isSpace(src[i - 1]) && src[i] === 0x45 && src[i + 1] === 0x49 && (i + 2 >= src.length || isSpace(src[i + 2]))) {
          i += 2;
          break;
        }
        i += 1;
      }
    }
  }
  return operations;
}

/* -------------------------------- fonts -------------------------------- */

interface FontWidths {
  /** Bytes per character code. */
  bytes: 1 | 2;
  /** A code's advance in text space, before the font size (w0). */
  width: (code: number) => number;
}

/** The standard 14 font a font name stands for ("Arial,Bold" is Helvetica-Bold), or null. */
function standardFont(base: string): string | null {
  const name = base.replace(/^[A-Z]{6}\+/, '');
  const flat = name.toLowerCase().replace(/[\s,_-]|mt$|ps$/g, '');
  const bold = /bold|black|heavy/.test(flat);
  const italic = /italic|oblique/.test(flat);
  if (/^symbol/.test(flat)) return 'Symbol';
  if (/^zapfdingbats|^dingbats/.test(flat)) return 'ZapfDingbats';
  if (/^(helvetica|arial)/.test(flat)) return `Helvetica${bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : ''}`;
  if (/^times/.test(flat)) return `Times-${bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Roman'}`;
  if (/^courier/.test(flat)) return `Courier${bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : ''}`;
  return null;
}

const metricsCache = new Map<string, ReturnType<StandardFonts['Font']['load']>>();

/** Glyph names by character code, for the encodings the standard fonts come with. */
function encodingTable(fonts: StandardFonts, name: 'WinAnsi' | 'Symbol' | 'ZapfDingbats'): string[] {
  const encoding = fonts.Encodings[name];
  const table: string[] = [];
  for (const point of encoding.supportedCodePoints) {
    const { code, name: glyph } = encoding.encodeUnicodeCodePoint(point);
    table[code] ??= glyph;
  }
  return table;
}

/**
 * Widths of a simple font whose program and widths are not in the file: one
 * of the standard 14, measured from its metrics through its encoding. Mac
 * Roman and Standard encodings are read as WinAnsi, which they match in the
 * ASCII range bar two quotes.
 */
function standardWidths(lib: PdfLib, fonts: StandardFonts, font: PDFDict): ((code: number) => number) | null {
  const { PDFArray, PDFDict, PDFName, PDFNumber } = lib;
  const base = font.lookup(PDFName.of('BaseFont'));
  const standard = base instanceof PDFName ? standardFont(base.decodeText()) : null;
  if (!standard) return null;
  let metrics = metricsCache.get(standard);
  if (!metrics) {
    metrics = fonts.Font.load(standard as Parameters<StandardFonts['Font']['load']>[0]);
    metricsCache.set(standard, metrics);
  }
  const symbolic = standard === 'Symbol' || standard === 'ZapfDingbats';
  const names = encodingTable(fonts, symbolic ? (standard as 'Symbol' | 'ZapfDingbats') : 'WinAnsi');
  const encoding = font.lookup(PDFName.of('Encoding'));
  const standardEncoding = !symbolic && (encoding === undefined || encoding === PDFName.of('StandardEncoding'));
  if (standardEncoding) {
    names[39] = 'quoteright';
    names[96] = 'quoteleft';
  }
  if (encoding instanceof PDFDict) {
    const differences = encoding.lookup(PDFName.of('Differences'));
    if (differences instanceof PDFArray) {
      let code = 0;
      for (let k = 0; k < differences.size(); k += 1) {
        const item = differences.lookup(k);
        if (item instanceof PDFNumber) code = item.asNumber();
        else if (item instanceof PDFName) names[code++] = item.decodeText();
      }
    }
  }
  return (code) => (metrics.getWidthOfGlyph(names[code] ?? '') ?? 0) / 1000;
}

function fontWidths(lib: PdfLib, fonts: StandardFonts, font: PDFDict): FontWidths | null {
  const { PDFArray, PDFName, PDFNumber, PDFDict: Dict } = lib;
  const num = (value: unknown, fallback = 0) => (value instanceof PDFNumber ? value.asNumber() : fallback);
  const subtype = font.lookup(PDFName.of('Subtype'));
  if (subtype === PDFName.of('Type0')) {
    if (font.lookup(PDFName.of('Encoding')) !== PDFName.of('Identity-H')) return null;
    const descendants = font.lookup(PDFName.of('DescendantFonts'));
    const cid = descendants instanceof PDFArray ? descendants.lookup(0) : null;
    if (!(cid instanceof Dict)) return null;
    const fallback = num(cid.lookup(PDFName.of('DW')), 1000);
    const widths = new Map<number, number>();
    const w = cid.lookup(PDFName.of('W'));
    if (w instanceof PDFArray) {
      for (let k = 0; k < w.size(); ) {
        const first = num(w.lookup(k));
        const next = w.lookup(k + 1);
        if (next instanceof PDFArray) {
          for (let j = 0; j < next.size(); j += 1) widths.set(first + j, num(next.lookup(j)));
          k += 2;
        } else {
          const last = num(next);
          const value = num(w.lookup(k + 2));
          for (let c = first; c <= last && c - first < 65536; c += 1) widths.set(c, value);
          k += 3;
        }
      }
    }
    return { bytes: 2, width: (code) => (widths.get(code) ?? fallback) / 1000 };
  }
  const list = font.lookup(PDFName.of('Widths'));
  if (!(list instanceof PDFArray)) {
    const standard = subtype === PDFName.of('Type3') ? null : standardWidths(lib, fonts, font);
    return standard ? { bytes: 1, width: standard } : null;
  }
  const first = num(font.lookup(PDFName.of('FirstChar')));
  const descriptor = font.lookup(PDFName.of('FontDescriptor'));
  const missing = descriptor instanceof Dict ? num(descriptor.lookup(PDFName.of('MissingWidth'))) : 0;
  // Type 3 glyphs are measured in their own space, scaled by the font matrix.
  let scale = 1 / 1000;
  if (subtype === PDFName.of('Type3')) {
    const matrix = font.lookup(PDFName.of('FontMatrix'));
    if (!(matrix instanceof PDFArray)) return null;
    scale = num(matrix.lookup(0));
  }
  const widths = Array.from({ length: list.size() }, (_, k) => num(list.lookup(k), missing));
  return { bytes: 1, width: (code) => (widths[code - first] ?? missing) * scale };
}

/* -------------------------------- pages -------------------------------- */

interface Glyph {
  op: number;
  /** Which string of the operation (0 for Tj), and where in it. */
  part: number;
  offset: number;
  /** Its advance as a TJ adjustment would give it. */
  adjustment: number;
  x: number;
  y: number;
  /** Writing direction on the page. */
  ux: number;
  uy: number;
  space: boolean;
}

interface TextState {
  ctm: Matrix;
  charSpacing: number;
  wordSpacing: number;
  scale: number;
  leading: number;
  font: FontWidths | null;
  size: number;
  rise: number;
}

/** The page's content, as one stream of bytes, or null when it cannot be read. */
function pageContent(lib: PdfLib, doc: PDFDocument, page: PDFPage): Uint8Array | null {
  const { PDFArray, PDFRawStream, decodePDFRawStream } = lib;
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
  const parts: Uint8Array[] = [];
  for (const stream of streams) {
    if (!(stream instanceof PDFRawStream)) return null;
    try {
      parts.push(decodePDFRawStream(stream).decode());
    } catch {
      return null;
    }
  }
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    out[at + part.length] = 0x0a;
    at += part.length + 1;
  }
  return out;
}

/** Every glyph a page's own content stream shows, with where it lands. */
function pageGlyphs(lib: PdfLib, standard: StandardFonts, page: PDFPage, operations: Operation[]): { glyphs: Glyph[]; states: (TextState | null)[] } {
  const { PDFDict, PDFName } = lib;
  const fonts = page.node.Resources()?.lookup(PDFName.of('Font'));
  const cache = new Map<string, FontWidths | null>();
  const fontNamed = (name: string) => {
    if (!cache.has(name)) {
      const dict = fonts instanceof PDFDict ? fonts.lookup(PDFName.of(name)) : null;
      cache.set(name, dict instanceof PDFDict ? fontWidths(lib, standard, dict) : null);
    }
    return cache.get(name) ?? null;
  };

  let state: TextState = { ctm: IDENTITY, charSpacing: 0, wordSpacing: 0, scale: 1, leading: 0, font: null, size: 0, rise: 0 };
  const saved: TextState[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  const glyphs: Glyph[] = [];
  // The text state each showing operation ran with.
  const states: (TextState | null)[] = operations.map(() => null);
  const n = (v: Operand) => (typeof v === 'number' ? v : 0);
  const moveTo = (tx: number, ty: number) => {
    tlm = multiply([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };
  const show = (k: number, parts: Operand[]) => {
    states[k] = { ...state };
    const { font, size, scale, charSpacing, wordSpacing, rise } = state;
    parts.forEach((part, index) => {
      if (typeof part === 'number') {
        tm = multiply([1, 0, 0, 1, (-part / 1000) * size * scale, 0], tm);
        return;
      }
      if (!(part instanceof Uint8Array)) return;
      const step = font?.bytes ?? 1;
      for (let offset = 0; offset + step <= part.length; offset += step) {
        const code = step === 2 ? part[offset] * 256 + part[offset + 1] : part[offset];
        const w0 = font ? font.width(code) : 0;
        const space = step === 1 && code === 32;
        const trm = multiply(multiply([size * scale, 0, 0, size, 0, rise], tm), state.ctm);
        const length = Math.hypot(trm[0], trm[1]) || 1;
        if (font && size !== 0) {
          glyphs.push({
            op: k,
            part: index,
            offset,
            adjustment: -(w0 + (charSpacing + (space ? wordSpacing : 0)) / size) * 1000,
            x: trm[4],
            y: trm[5],
            ux: trm[0] / length,
            uy: trm[1] / length,
            space,
          });
        }
        tm = multiply([1, 0, 0, 1, (w0 * size + charSpacing + (space ? wordSpacing : 0)) * scale, 0], tm);
      }
    });
  };

  operations.forEach(({ op, operands: o }, k) => {
    switch (op) {
      case 'q':
        saved.push({ ...state });
        break;
      case 'Q':
        state = saved.pop() ?? state;
        break;
      case 'cm':
        state.ctm = multiply(o.slice(0, 6).map(n) as Matrix, state.ctm);
        break;
      case 'BT':
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case 'Tc':
        state.charSpacing = n(o[0]);
        break;
      case 'Tw':
        state.wordSpacing = n(o[0]);
        break;
      case 'Tz':
        state.scale = n(o[0]) / 100;
        break;
      case 'TL':
        state.leading = n(o[0]);
        break;
      case 'Ts':
        state.rise = n(o[0]);
        break;
      case 'Tf': {
        const name = o[0] && typeof o[0] === 'object' && 'name' in o[0] ? o[0].name : '';
        state.font = fontNamed(name);
        state.size = n(o[1]);
        break;
      }
      case 'Td':
        moveTo(n(o[0]), n(o[1]));
        break;
      case 'TD':
        state.leading = -n(o[1]);
        moveTo(n(o[0]), n(o[1]));
        break;
      case 'Tm':
        tm = o.slice(0, 6).map(n) as Matrix;
        tlm = tm;
        break;
      case 'T*':
        moveTo(0, -state.leading);
        break;
      case 'Tj':
        show(k, [o[0]]);
        break;
      case 'TJ':
        show(k, Array.isArray(o[0]) ? o[0] : []);
        break;
      case "'":
        moveTo(0, -state.leading);
        show(k, [o[0]]);
        break;
      case '"':
        state.wordSpacing = n(o[0]);
        state.charSpacing = n(o[1]);
        moveTo(0, -state.leading);
        show(k, [o[2]]);
        break;
    }
  });
  return { glyphs, states };
}

const hexOf = (bytes: Uint8Array) => `<${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}>`;
const numberOf = (v: number) => String(Math.round(v * 1000) / 1000);

/** A showing operation rewritten without the glyphs taken out, each one's width kept. */
function rewrite(operation: Operation, removed: Map<string, Glyph>, state: TextState): string {
  const { op, operands } = operation;
  const parts: Operand[] = op === 'TJ' ? (Array.isArray(operands[0]) ? operands[0] : []) : [op === '"' ? operands[2] : operands[0]];
  const step = state.font?.bytes ?? 1;
  const items: string[] = [];
  parts.forEach((part, index) => {
    if (typeof part === 'number') {
      items.push(numberOf(part));
      return;
    }
    if (!(part instanceof Uint8Array)) return;
    let kept: number[] = [];
    let adjustment = 0;
    const flush = () => {
      if (kept.length > 0) items.push(hexOf(Uint8Array.from(kept)));
      if (adjustment !== 0) items.push(numberOf(adjustment));
      kept = [];
      adjustment = 0;
    };
    for (let offset = 0; offset + step <= part.length; offset += step) {
      const glyph = removed.get(`${index}:${offset}`);
      if (glyph) {
        if (kept.length > 0) {
          items.push(hexOf(Uint8Array.from(kept)));
          kept = [];
        }
        adjustment += glyph.adjustment;
      } else {
        if (adjustment !== 0) {
          items.push(numberOf(adjustment));
          adjustment = 0;
        }
        for (let j = 0; j < step; j += 1) kept.push(part[offset + j]);
      }
    }
    flush();
  });
  const shown = `[${items.join(' ')}] TJ`;
  if (op === "'") return `T* ${shown}`;
  if (op === '"') return `${numberOf(state.wordSpacing)} Tw ${numberOf(state.charSpacing)} Tc T* ${shown}`;
  return shown;
}

/**
 * Takes the glyphs of each region out of the page. Returns, per region, how
 * many glyphs other than spaces were taken out.
 */
export function eraseRuns(lib: PdfLib, standard: StandardFonts, doc: PDFDocument, page: PDFPage, regions: EraseRegion[]): number[] {
  const counts = regions.map(() => 0);
  if (regions.length === 0) return counts;
  const content = pageContent(lib, doc, page);
  if (!content) return counts;
  const operations = parseContent(content);
  const { glyphs, states } = pageGlyphs(lib, standard, page, operations);

  // A run is the glyphs shown one after another from where it starts, as many
  // as it has letters: text drawn over it by other operations — title-block
  // fields often overlap — is not its.
  const removed = new Map<number, Map<string, Glyph>>();
  regions.forEach((region, r) => {
    const [a, b, c, d, e, f] = region.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b);
    const length = Math.hypot(a, b);
    if (!(size > 0) || !(length > 0)) return;
    const ux = a / length;
    const uy = b / length;
    const place = (glyph: Glyph) => ({
      along: (glyph.x - e) * ux + (glyph.y - f) * uy,
      across: (glyph.y - f) * ux - (glyph.x - e) * uy,
      aligned: glyph.ux * ux + glyph.uy * uy >= 0.95,
    });
    let start = -1;
    let nearest = 0.15 * size;
    glyphs.forEach((glyph, k) => {
      const { along, across, aligned } = place(glyph);
      const distance = Math.hypot(along, across);
      if (aligned && distance < nearest) {
        nearest = distance;
        start = k;
      }
    });
    if (start < 0) return;
    // Where it ends: PDF.js counts spaces that are not glyphs and joins nearby
    // runs, so its letters are only a bound; the run's own width decides.
    // It reads forwards: a step back is other text over it — unless it is the
    // run again from its start, drawn twice to look bold.
    let last = -Infinity;
    for (let k = start, taken = 0; k < glyphs.length && taken < region.text.length * 2 + 8; k += 1, taken += 1) {
      const glyph = glyphs[k];
      const { along, across, aligned } = place(glyph);
      if (!aligned || along < -0.25 * size || along > region.width - 0.1 * size || Math.abs(across) > 0.3 * size) break;
      if (along < last - 0.1 * size && Math.hypot(along, across) > 0.15 * size) break;
      last = along;
      const map = removed.get(glyph.op) ?? new Map<string, Glyph>();
      const key = `${glyph.part}:${glyph.offset}`;
      if (!map.has(key) && !glyph.space) counts[r] += 1;
      map.set(key, glyph);
      removed.set(glyph.op, map);
    }
  });
  if (removed.size === 0) return counts;

  // The stream again, each operation that lost glyphs written anew.
  const encoder = new TextEncoder();
  const pieces: Uint8Array[] = [];
  let at = 0;
  for (const [k, map] of [...removed].sort((x, y) => x[0] - y[0])) {
    const operation = operations[k];
    const state = states[k];
    if (!state) continue;
    pieces.push(content.subarray(at, operation.start), encoder.encode(rewrite(operation, map, state)));
    at = operation.end;
  }
  pieces.push(content.subarray(at));
  const out = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const piece of pieces) {
    out.set(piece, offset);
    offset += piece.length;
  }
  page.node.set(lib.PDFName.of('Contents'), doc.context.register(doc.context.flateStream(out)));
  return counts;
}
