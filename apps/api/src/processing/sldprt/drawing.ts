import { unwrapCodec, type PackageEntry } from './container.js';
import { decodePng, type PngRaster } from './png.js';

/**
 * A SolidWorks drawing (.SLDDRW), read without SolidWorks.
 *
 * A drawing keeps what SolidWorks last drew, so that it can be opened without
 * its models. Two streams hold it, both MFC archives of tightly packed records
 * (sizes and doubles on byte boundaries, one-byte flags in between):
 *
 * `Contents/DisplayLists` — everything drawn on the sheets, in sheet
 * coordinates (metres, origin bottom-left): frames, title blocks, notes,
 * dimensions, centre lines, balloons. Each record is `[u32 size][u32 kind]`:
 *
 *     kind 0x0c  pen: colour (COLORREF), width, line style name
 *     kind 0x04  segment: two points (x, y, z)
 *     kind 0x06  polyline: u32, n, n points
 *     kind 0x02  arc: start, end, centre, normal (anticlockwise about it)
 *     kind 0x0a  font: height, angle, name
 *     kind 0x12  text: position, angle, string, then each character's advance
 *     kind 0x1e  group; a sheet when it carries height, width and the sheet name
 *
 * Each sheet's own content comes before its sheet record. After the last one
 * come the views: for each, its annotations, then a record holding its
 * placement — rotation (left out when it is the identity), offset T, scale s,
 * origin O, and the frame it occupies — anchored here on s:
 *
 *     sheet = O + T + s · (Rᵀ p)          (x, y of it)
 *
 * `Contents/VBLists` — the edges of the views, in model coordinates, in
 * buckets (uiViewBucket_c): each edge a count and that many points. Which view
 * a bucket belongs to is not written anywhere we could find, so it is worked
 * out: the view whose frame holds all of the bucket once placed. A detail view
 * has no bucket of its own and shows its parent's, magnified and cropped.
 *
 * What cannot be placed that way yet — a broken view, a crop — is not dropped:
 * that region of the sheet picture SolidWorks saved is shown instead.
 * Checked against the sheet pictures of the drawings in C:\User\SaaS\Исходно.
 */

export type Point = [number, number];

export interface Pen {
  /** RGB, 0xRRGGBB. */
  color: number;
  /** Line width in millimetres; SolidWorks' default thin line when it gave none. */
  widthMm: number;
  /** Style name as SolidWorks has it: CONTINUOUS, CENTER, HIDDEN … */
  style: string;
}

export interface PathShape {
  kind: 'path';
  points: Point[];
  pen: Pen;
  /** A model edge of a view rather than an annotation. */
  edge?: boolean;
  /** Set when the arc it came from is a whole circle. */
  circle?: { center: Point; radius: number };
}

export interface TextShape {
  kind: 'text';
  at: Point;
  /** Radians, anticlockwise. */
  angle: number;
  /** Character height, metres. */
  height: number;
  font: string;
  text: string;
  /** Advance of each character, metres, when SolidWorks recorded them. */
  advances: number[] | null;
}

export type Shape = PathShape | TextShape;

export interface DrawingView {
  scale: number;
  origin: Point;
  /** Region of the sheet the view occupies: x0, y0, x1, y1. */
  frame: [number, number, number, number];
  /** Drawn from its own edges; false means the sheet picture stands in for it. */
  drawn: boolean;
  /** Not shown by SolidWorks: its edges fall on blank paper in the sheet picture. */
  hidden: boolean;
  /** Share of its edges the sheet picture shows, when there is a picture. */
  ink: number | null;
  edges: number;
}

/**
 * Where the sheet lies in the picture SolidWorks saved of it: pixel
 * (x + X·scale, y − Y·scale) for sheet point (X, Y) in metres. Usually the
 * sheet fitted into the picture; not always — some pictures keep the zoom the
 * window had — so it is measured, not assumed.
 */
export interface PictureMap {
  scale: number;
  x: number;
  y: number;
}

export interface DrawingSheet {
  name: string;
  width: number;
  height: number;
  active: boolean;
  shapes: Shape[];
  views: DrawingView[];
  /** SolidWorks' own picture of the sheet. */
  image: Buffer | null;
  /**
   * Regions (x0, y0, x1, y1, metres) where that picture shows something this
   * reading of the file did not draw: shown from the picture, so nothing on
   * the sheet goes missing.
   */
  patches: [number, number, number, number][];
  /** Where the sheet lies in `image`. */
  picture: PictureMap | null;
}

export interface Drawing {
  sheets: DrawingSheet[];
}

/* -------------------------------------------------------------------------- */

const finite = (v: number) => Number.isFinite(v) && Math.abs(v) < 50;
const near = (v: number, t: number, e = 1e-6) => Math.abs(v - t) < e;

/** An MFC CString (Unicode marker FF FE FF, then length), or null. */
function cstring(data: Buffer, at: number): { text: string; end: number } | null {
  if (at + 4 > data.length || data[at] !== 0xff || data[at + 1] !== 0xfe || data[at + 2] !== 0xff) return null;
  let length = data[at + 3];
  let start = at + 4;
  if (length === 0xff) {
    if (start + 2 > data.length) return null;
    length = data.readUInt16LE(start);
    start += 2;
  }
  const end = start + length * 2;
  if (end > data.length) return null;
  return { text: data.subarray(start, end).toString('utf16le'), end };
}

const DEFAULT_PEN: Pen = { color: 0, widthMm: 0.18, style: 'CONTINUOUS' };
const EDGE_PEN: Pen = { color: 0, widthMm: 0.35, style: 'CONTINUOUS' };

/** A COLORREF (0x00BBGGRR) as 0xRRGGBB. */
const rgb = (colorref: number) => ((colorref & 0xff) << 16) | (colorref & 0xff00) | ((colorref >> 16) & 0xff);

/**
 * SolidWorks' symbol library (kind 0x13 records name a library and a symbol)
 * as characters. Weld symbols and GOST view arrows have none and are left out.
 */
const SYMBOLS: Record<string, string> = {
  'MOD/DIAM': 'Ø',
  'MOD/PM': '±',
  'MOD/DEG': '°',
  'MOD/MMC': 'Ⓜ',
  'MOD/MMC_DIM': 'Ⓜ',
  'MOD/LMC': 'Ⓛ',
  'MOD/RFS': 'Ⓢ',
  'MOD/SPHD': 'SØ',
  'MOD/CL': '℄',
  'MOD/SQUARE': '□',
  'MOD/DEPTH': '↧',
  'MOD/CBORE': '⌴',
  'MOD/CSINK': '⌵',
  'GGTOL/POSI': '⌖',
  'GGTOL/FLAT': '⏥',
  'GGTOL/STRA': '⏤',
  'GGTOL/CIRC': '○',
  'GGTOL/CYL': '⌭',
  'GGTOL/PERP': '⟂',
  'GGTOL/PARA': '∥',
  'GGTOL/ANGU': '∠',
  'GGTOL/CONC': '◎',
  'GGTOL/SYMM': '⌯',
  'GGTOL/SRUN': '↗',
  'GGTOL/TRUN': '⌰',
  'GGTOL/LPRO': '⌒',
  'GGTOL/SPRO': '⌓',
};

interface Located<T> {
  at: number;
  shape: T;
}

/** Every pen, segment, polyline, arc, font and text in the sheet stream, in order. */
function readAnnotations(dl: Buffer): Located<Shape>[] {
  const out: Located<Shape>[] = [];
  let pen = DEFAULT_PEN;
  let font = { height: 0.0035, name: 'GOST type A' };
  const f64 = (at: number) => dl.readDoubleLE(at);

  for (let i = 0; i + 16 <= dl.length; i += 1) {
    const size = dl.readUInt32LE(i);
    const kind = dl.readUInt32LE(i + 4);

    if (kind === 4 && size === 0x50 && i + 56 <= dl.length) {
      const v = [0, 1, 2, 3, 4, 5].map((k) => f64(i + 8 + k * 8));
      if (v.every(finite)) {
        out.push({ at: i, shape: { kind: 'path', points: [[v[0], v[1]], [v[3], v[4]]], pen } });
        i += 55;
        continue;
      }
    }
    if (kind === 6 && (size & 0xff) === 0x50) {
      const n = dl.readUInt32LE(i + 12);
      if (n >= 2 && n < 100_000 && i + 16 + n * 24 <= dl.length) {
        const points: Point[] = [];
        for (let k = 0; k < n; k += 1) points.push([f64(i + 16 + k * 24), f64(i + 24 + k * 24)]);
        if (points.every(([x, y]) => finite(x) && finite(y))) {
          out.push({ at: i, shape: { kind: 'path', points, pen } });
          i += 15 + n * 24;
          continue;
        }
      }
    }
    if (kind === 2 && size >= 0x40 && size < 0x200 && i + 104 <= dl.length) {
      const v = Array.from({ length: 12 }, (_, k) => f64(i + 8 + k * 8));
      if (v.every(finite) && near(Math.hypot(v[9], v[10], v[11]), 1)) {
        const whole = Math.hypot(v[0] - v[3], v[1] - v[4]) < 1e-9;
        const circle = whole ? { center: [v[6], v[7]] as Point, radius: Math.hypot(v[0] - v[6], v[1] - v[7]) } : undefined;
        out.push({ at: i, shape: { kind: 'path', points: arcPoints(v), pen, ...(circle ? { circle } : {}) } });
        i += 103;
        continue;
      }
    }
    if (kind === 0x0c && i + 30 <= dl.length) {
      const width = dl.readFloatLE(i + 14);
      const style = width >= -1 && width < 1 ? cstring(dl, i + 26) : null;
      if (style) {
        pen = { color: rgb(dl.readUInt32LE(i + 8)), widthMm: width > 0 ? Math.max(0.1, width * 1000) : DEFAULT_PEN.widthMm, style: style.text.toUpperCase() };
        i = style.end - 1;
        continue;
      }
    }
    if (kind === 0x0a && i + 44 <= dl.length) {
      const height = f64(i + 8);
      const name = height > 0 && height < 0.2 ? cstring(dl, i + 40) : null;
      if (name) {
        font = { height, name: name.text };
        i = name.end - 1;
        continue;
      }
    }
    if (kind === 0x13 && size >= 0x40 && size < 0x400 && i + 60 <= dl.length) {
      // A symbol from SolidWorks' library, set like a character.
      const v = [f64(i + 8), f64(i + 16), f64(i + 36), f64(i + 44)];
      const library = v.every(finite) ? cstring(dl, i + 52) : null;
      const name = library ? cstring(dl, library.end) : null;
      if (library && name) {
        const glyph = SYMBOLS[`${library.text}/${name.text}`];
        if (glyph && v[3] > 0 && v[3] < 0.2) {
          out.push({
            at: i,
            // Set in the size of the text around it; its own height is its box's.
            shape: { kind: 'text', at: [v[0], v[1]], angle: v[2], height: Math.min(v[3], font.height), font: 'sans-serif', text: glyph, advances: null },
          });
        }
        i = name.end - 1;
        continue;
      }
    }
    if (kind === 0x12 && i + 52 <= dl.length) {
      const v = [f64(i + 8), f64(i + 16), f64(i + 24), f64(i + 36)];
      const text = v.every(finite) ? cstring(dl, i + 48) : null;
      if (text && text.text.length < 1000) {
        const advances = readAdvances(dl, text.end, text.text.length);
        out.push({
          at: i,
          shape: { kind: 'text', at: [v[0], v[1]], angle: v[3], height: font.height, font: font.name, text: text.text, advances },
        });
        i = text.end - 1;
        continue;
      }
    }
  }
  return out;
}

/** After a text's string: a u16, the character count, then one f32 advance per character. */
function readAdvances(dl: Buffer, at: number, count: number): number[] | null {
  if (count === 0 || at + 6 + count * 4 > dl.length || dl.readUInt32LE(at + 2) !== count) return null;
  const advances: number[] = [];
  for (let k = 0; k < count; k += 1) {
    const a = dl.readFloatLE(at + 6 + k * 4);
    if (!(a >= 0 && a < 0.5)) return null;
    advances.push(a);
  }
  return advances;
}

/** An arc record (start, end, centre, normal) as points, anticlockwise about its normal. */
function arcPoints(v: number[]): Point[] {
  const [sx, sy, , ex, ey, , cx, cy, , , , nz] = v;
  const r = Math.hypot(sx - cx, sy - cy);
  let a0 = Math.atan2(sy - cy, sx - cx);
  let a1 = Math.atan2(ey - cy, ex - cx);
  if (nz < 0) [a0, a1] = [a1, a0];
  if (a1 <= a0 + 1e-9) a1 += Math.PI * 2;
  const steps = Math.max(8, Math.ceil((a1 - a0) / 0.05));
  const points: Point[] = [];
  for (let k = 0; k <= steps; k += 1) {
    const t = a0 + ((a1 - a0) * k) / steps;
    points.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return nz < 0 ? points.reverse() : points;
}

/* -------------------------------------------------------------------------- */

interface SheetRecord {
  at: number;
  name: string;
  width: number;
  height: number;
}

/** A group record carrying a sheet: height, width, then its name. */
function readSheets(dl: Buffer): SheetRecord[] {
  const sheets: SheetRecord[] = [];
  for (let i = 0; i + 60 < dl.length; i += 1) {
    if (dl.readUInt32LE(i + 4) !== 0x1e) continue;
    const height = dl.readDoubleLE(i + 36);
    const width = dl.readDoubleLE(i + 44);
    if (!(height > 0.05 && height < 5 && width > 0.05 && width < 5)) continue;
    const name = cstring(dl, i + 52);
    if (!name || !name.text) continue;
    sheets.push({ at: i, name: name.text, width, height });
  }
  return sheets;
}

interface ViewRecord {
  at: number;
  /** Rows of the rotation; the placement uses its columns. */
  rotation: number[][];
  offset: number[];
  scale: number;
  origin: Point;
  frame: [number, number, number, number];
  buckets: number[];
  /** A detail view's boundary on the sheet, when it is a circle. */
  circle?: { center: Point; radius: number };
}

/**
 * View placements, anchored on the scale s at p: origin at p+10, outer and
 * inner frames at p+47 and p+79, offset T at p-24, rotation at p-96 — or no
 * rotation at all when it is the identity.
 */
function readViews(dl: Buffer): ViewRecord[] {
  const views: ViewRecord[] = [];
  const box = (at: number) => [0, 1, 2, 3].map((k) => dl.readDoubleLE(at + k * 8)) as [number, number, number, number];
  const holds = (outer: number[], inner: number[]) =>
    inner[0] >= outer[0] - 1e-6 && inner[1] >= outer[1] - 1e-6 && inner[2] <= outer[2] + 1e-6 && inner[3] <= outer[3] + 1e-6;
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (let p = 96; p + 111 <= dl.length; p += 1) {
    const scale = dl.readDoubleLE(p);
    if (!(scale > 1e-4 && scale < 1e3)) continue;
    const outer = box(p + 47);
    const inner = box(p + 79);
    if (!outer.every(finite) || !inner.every(finite)) continue;
    if (!(inner[0] < inner[2] && inner[1] < inner[3]) || !holds(outer, inner)) continue;
    if (outer[2] - outer[0] > 10 || inner[2] - inner[0] < 1e-5) continue;
    const origin: Point = [dl.readDoubleLE(p + 10), dl.readDoubleLE(p + 18)];
    const offset = [dl.readDoubleLE(p - 24), dl.readDoubleLE(p - 16), dl.readDoubleLE(p - 8)];
    if (!origin.every(finite) || !offset.every(finite)) continue;
    const m = Array.from({ length: 9 }, (_, k) => dl.readDoubleLE(p - 96 + k * 8));
    const rows = [m.slice(0, 3), m.slice(3, 6), m.slice(6, 9)];
    const rotated =
      m.every(Number.isFinite) &&
      rows.every((r) => near(Math.hypot(r[0], r[1], r[2]), 1)) &&
      near(dot(rows[0], rows[1]), 0) &&
      near(dot(rows[0], rows[2]), 0) &&
      near(dot(rows[1], rows[2]), 0);
    views.push({
      at: p,
      rotation: rotated ? rows : [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      offset,
      scale,
      origin,
      frame: inner,
      buckets: [],
    });
    p += 110;
  }
  return views;
}

function place(view: ViewRecord, p: number[]): Point {
  const r = view.rotation;
  const x = r[0][0] * p[0] + r[1][0] * p[1] + r[2][0] * p[2];
  const y = r[0][1] * p[0] + r[1][1] * p[1] + r[2][1] * p[2];
  return [view.origin[0] + view.offset[0] + view.scale * x, view.origin[1] + view.offset[1] + view.scale * y];
}

/* -------------------------------------------------------------------------- */

interface Bucket {
  /** The direction its header starts with; usually, not always, its view's. */
  direction: number[];
  edges: number[][][];
}

/**
 * The view buckets and their edges. Buckets start at the class record and at
 * every later reference to it (0x8001) followed by a unit vector. An edge is a
 * count and that many points, each near the last; tessellation vertex arrays
 * have the same shape behind a [12, 100, 2] header and are skipped.
 */
function readBuckets(vb: Buffer): Bucket[] {
  const starts: number[] = [];
  const cls = vb.indexOf(Buffer.from('uiViewBucket_c', 'latin1'));
  if (cls < 0) return [];
  starts.push(cls + 14);
  const ref = Buffer.from([0x01, 0x80]);
  for (let k = vb.indexOf(ref, cls); k >= 0 && k + 26 <= vb.length; k = vb.indexOf(ref, k + 1)) {
    const d = [0, 1, 2].map((j) => vb.readDoubleLE(k + 2 + j * 8));
    if (d.every(finite) && near(Math.hypot(d[0], d[1], d[2]), 1)) starts.push(k + 2);
  }
  starts.sort((a, b) => a - b);

  // Points are doubles; files from older SolidWorks versions keep them as floats.
  const scan = (bytes: 8 | 4): Bucket[] => {
    const read = (o: number) => (bytes === 8 ? vb.readDoubleLE(o) : vb.readFloatLE(o));
    const stride = bytes * 3;
    // Values like 6e-18 are real (a cosine of 90°); only denormal-sized ones are not numbers at all.
    const tiny = bytes === 8 ? 1e-200 : 1e-30;
    const plausible = (v: number) => Number.isFinite(v) && Math.abs(v) < 20 && (v === 0 || Math.abs(v) > tiny);
    return starts.map((start, index) => {
      const end = starts[index + 1] ?? vb.length;
      const direction = [0, 1, 2].map((j) => vb.readDoubleLE(start + j * 8));
      const edges: number[][][] = [];
      for (let i = start + 4; i + 4 + stride * 2 <= end; i += 1) {
        const n = vb.readUInt32LE(i);
        if (n < 2 || n > 100_000 || i + 4 + n * stride > end) continue;
        // A tessellation array, [12][100][2][n]: its 2 is not an edge's count,
        // and what follows its n is not edges.
        if (i >= 8 && vb.readUInt32LE(i - 8) === 12 && vb.readUInt32LE(i - 4) === 100) continue;
        if (i >= 12 && vb.readUInt32LE(i - 12) === 12 && vb.readUInt32LE(i - 8) === 100 && vb.readUInt32LE(i - 4) === 2) {
          i += 3 + n * stride;
          continue;
        }
        const points: number[][] = [];
        let good = true;
        for (let k = 0; k < n; k += 1) {
          const o = i + 4 + k * stride;
          const q = [read(o), read(o + bytes), read(o + bytes * 2)];
          const last = points[k - 1];
          // A step of metres is real: a 4 m duct's side is one straight edge.
          if (!q.every(plausible) || (last && Math.hypot(q[0] - last[0], q[1] - last[1], q[2] - last[2]) > 10)) {
            good = false;
            break;
          }
          points.push(q);
        }
        if (!good || points.every((q) => q[0] === points[0][0] && q[1] === points[0][1] && q[2] === points[0][2])) continue;
        edges.push(points);
        i += 3 + n * stride;
      }
      return { direction, edges };
    });
  };
  const doubles = scan(8);
  return doubles.some((b) => b.edges.length > 0) ? doubles : scan(4);
}

/** Share of a bucket's points that land inside a view's frame once placed. */
function fit(view: ViewRecord, bucket: Bucket): { inside: number; all: number } {
  const [x0, y0, x1, y1] = view.frame;
  const e = 1.5e-3;
  let inside = 0;
  let all = 0;
  for (const edge of bucket.edges) {
    for (const p of edge) {
      const [x, y] = place(view, p);
      all += 1;
      if (x >= x0 - e && x <= x1 + e && y >= y0 - e && y <= y1 + e) inside += 1;
    }
  }
  return { inside, all };
}

/**
 * Which views each bucket's edges belong to — nothing in the file says, so it
 * is worked out and only accepted when the geometry agrees.
 *
 * A bucket's header starts with its view's direction (the third row of the
 * rotation). Buckets and views come in the same order, so bucket i is view
 * i's for as long as their directions agree and the bucket lands in the
 * view's frame. The rest: among the views on a sheet looking exactly that
 * way, the one whose frame holds (nine tenths of) it, the smallest such frame;
 * what spills over is cropped. When none holds it — a broken view, shortened
 * on the sheet — or none looks that way, it is left out rather than given to
 * some other view it happens to fit.
 *
 * A view left without edges (broken views, detail views, crops) is shown from
 * the sheet picture instead: blurry but right beats sharp but wrong.
 */
function assignBuckets(views: ViewRecord[], shown: Set<ViewRecord>, buckets: Bucket[], directions: number[][]): void {
  const holds = (view: ViewRecord, bucket: Bucket) => {
    const { inside, all } = fit(view, bucket);
    return all > 0 && inside / all >= 0.9;
  };
  // Same direction, sign included: a bucket facing the other way is not that view's.
  const facing = (v: ViewRecord, d: number[]) => v.rotation[2][0] * d[0] + v.rotation[2][1] * d[1] + v.rotation[2][2] * d[2] > 1 - 1e-6;
  const withEdges = buckets.map((b, n) => (b.edges.length > 0 ? n : -1)).filter((n) => n >= 0);
  // Buckets and views come in the same order — views off the sheet included —
  // for as long as each bucket looks the way its view does.
  let k = 0;
  for (; k < withEdges.length && k < views.length; k += 1) {
    const n = withEdges[k];
    if (!facing(views[k], directions[n]) || !holds(views[k], buckets[n])) break;
    views[k].buckets.push(n);
  }
  // The rest by direction and frame, among the views on a sheet. A view's
  // frame is its model's extent seen its way, so any bucket of that model
  // fits a view looking the same way: the direction decides, the frame only
  // confirms, and the smallest frame wins (a detail view's parent holds it too).
  const area = (v: ViewRecord) => (v.frame[2] - v.frame[0]) * (v.frame[3] - v.frame[1]);
  for (const n of withEdges.slice(k)) {
    let best: ViewRecord | null = null;
    for (const view of views) {
      if (!shown.has(view) || !facing(view, directions[n]) || !holds(view, buckets[n])) continue;
      if (!best || area(view) < area(best)) best = view;
    }
    best?.buckets.push(n);
  }
}

/** A segment cropped to a rectangle (Liang–Barsky), or null when it misses it. */
function clip(a: Point, b: Point, [x0, y0, x1, y1]: number[]): [Point, Point] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  for (const [p, q] of [
    [-dx, a[0] - x0],
    [dx, x1 - a[0]],
    [-dy, a[1] - y0],
    [dy, y1 - a[1]],
  ]) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [
    [a[0] + t0 * dx, a[1] + t0 * dy],
    [a[0] + t1 * dx, a[1] + t1 * dy],
  ];
}

/** The part of a segment inside a circle, or null. */
function clipCircle(a: Point, b: Point, c: Point, r: number): [Point, Point] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const fx = a[0] - c[0];
  const fy = a[1] - c[1];
  const A = dx * dx + dy * dy;
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  if (A === 0) return C <= 0 ? [a, b] : null;
  const disc = B * B - 4 * A * C;
  if (disc <= 0) return null;
  const root = Math.sqrt(disc);
  const t0 = Math.max(0, (-B - root) / (2 * A));
  const t1 = Math.min(1, (-B + root) / (2 * A));
  if (t0 >= t1) return null;
  return [
    [a[0] + t0 * dx, a[1] + t0 * dy],
    [a[0] + t1 * dx, a[1] + t1 * dy],
  ];
}

/**
 * Detail views: they have no geometry of their own but show their parent's,
 * magnified and cropped by the detail circle drawn on the parent. That circle
 * is among the sheet's annotations; carried into the detail view (same
 * orientation, so only offset and scale differ) it must hold the detail's
 * frame and span most of it. Views that do not find one stay with the sheet
 * picture.
 */
function findDetails(views: ViewRecord[], circles: { center: Point; radius: number }[], buckets: Bucket[]): void {
  const same = (a: ViewRecord, b: ViewRecord) => a.rotation.every((row, i) => row.every((v, j) => near(v, b.rotation[i][j])));
  for (const view of views) {
    if (view.buckets.length > 0) continue;
    let best: { parent: ViewRecord; center: Point; radius: number } | null = null;
    let bestScore = 0.2;
    for (const parent of views) {
      if (parent === view || parent.buckets.length === 0 || parent.scale >= view.scale - 1e-9 || !same(parent, view)) continue;
      const [px0, py0, px1, py1] = parent.frame;
      for (const circle of circles) {
        const [cx, cy] = circle.center;
        if (cx < px0 - circle.radius || cx > px1 + circle.radius || cy < py0 - circle.radius || cy > py1 + circle.radius) continue;
        const k = view.scale / parent.scale;
        const center: Point = [
          view.origin[0] + view.offset[0] + (cx - parent.origin[0] - parent.offset[0]) * k,
          view.origin[1] + view.offset[1] + (cy - parent.origin[1] - parent.offset[1]) * k,
        ];
        const radius = circle.radius * k;
        const [x0, y0, x1, y1] = view.frame;
        // SolidWorks frames a detail view a little wider than its circle.
        const e = radius * 0.3 + 5e-4;
        if (x0 < center[0] - radius - e || x1 > center[0] + radius + e || y0 < center[1] - radius - e || y1 > center[1] + radius + e) continue;
        const score = ((x1 - x0) * (y1 - y0)) / (4 * radius * radius);
        if (score > bestScore) {
          bestScore = score;
          best = { parent, center, radius };
        }
      }
    }
    if (best) {
      view.buckets.push(...best.parent.buckets);
      view.circle = { center: best.center, radius: best.radius };
      continue;
    }
    // No circle: a detail with a rectangular boundary — its frame. The parent
    // is the view looking the same way whose geometry, magnified, fills it most.
    let parent: ViewRecord | null = null;
    let most = 50;
    for (const candidate of views) {
      if (candidate === view || candidate.buckets.length === 0 || candidate.scale >= view.scale - 1e-9 || !same(candidate, view)) continue;
      const inside = candidate.buckets.reduce((n, b) => n + fit(view, buckets[b]).inside, 0);
      if (inside > most) {
        most = inside;
        parent = candidate;
      }
    }
    if (parent) view.buckets.push(...parent.buckets);
  }
}

/** A view's edges on the sheet, cropped to its frame (and a detail view's to its circle). */
function viewEdges(view: ViewRecord, buckets: Bucket[]): PathShape[] {
  const margin = 5e-4;
  const frame = [view.frame[0] - margin, view.frame[1] - margin, view.frame[2] + margin, view.frame[3] + margin];
  const shapes: PathShape[] = [];
  for (const n of view.buckets) {
    for (const edge of buckets[n].edges) {
      const placed = edge.map((p) => place(view, p));
      let run: Point[] = [];
      const flush = () => {
        if (run.length >= 2) shapes.push({ kind: 'path', points: run, pen: EDGE_PEN, edge: true });
        run = [];
      };
      for (let k = 1; k < placed.length; k += 1) {
        let c = clip(placed[k - 1], placed[k], frame);
        if (c && view.circle) c = clipCircle(c[0], c[1], view.circle.center, view.circle.radius);
        if (!c) {
          flush();
          continue;
        }
        if (run.length === 0) run.push(c[0]);
        else if (Math.hypot(run[run.length - 1][0] - c[0][0], run[run.length - 1][1] - c[0][1]) > 1e-9) {
          flush();
          run.push(c[0]);
        }
        run.push(c[1]);
        if (c[1][0] !== placed[k][0] || c[1][1] !== placed[k][1]) flush();
      }
      flush();
    }
  }
  // The detail circle itself, where it crosses the view: its boundary.
  if (view.circle && shapes.length > 0) {
    const { center, radius } = view.circle;
    const steps = 144;
    let run: Point[] = [];
    for (let k = 0; k <= steps; k += 1) {
      const t = (k / steps) * Math.PI * 2;
      const p: Point = [center[0] + radius * Math.cos(t), center[1] + radius * Math.sin(t)];
      if (p[0] >= frame[0] && p[0] <= frame[2] && p[1] >= frame[1] && p[1] <= frame[3]) run.push(p);
      else {
        if (run.length >= 2) shapes.push({ kind: 'path', points: run, pen: EDGE_PEN, edge: true });
        run = [];
      }
    }
    if (run.length >= 2) shapes.push({ kind: 'path', points: run, pen: EDGE_PEN, edge: true });
  }
  return shapes;
}

/* -------------------------------------------------------------------------- */

function streamOf(entries: PackageEntry[], name: string): Buffer | null {
  const entry = entries.find((e) => e.name === name);
  if (!entry) return null;
  return unwrapCodec(entry.data) ?? entry.data;
}

/** Points to test a shape against the sheet pictures with. */
function samples(shape: Shape): Point[] {
  if (shape.kind === 'text') return [shape.at];
  const step = Math.max(1, Math.ceil(shape.points.length / 12));
  return shape.points.filter((_, k) => k % step === 0);
}

/** Standard sheets, metres, landscape; portrait is tried too. */
const PAPERS: [number, number][] = [
  [0.297, 0.21],
  [0.42, 0.297],
  [0.594, 0.42],
  [0.841, 0.594],
  [1.189, 0.841],
  [0.2794, 0.2159],
  [0.4318, 0.2794],
  [0.5588, 0.4318],
  [0.8636, 0.5588],
  [1.1176, 0.8636],
];

/**
 * The paper of a drawing that does not record its sheet (older files): the
 * smallest standard sheet holding the outer frame — the largest rectangle
 * drawn — or, without one, everything drawn. Notes left outside the frame do
 * not count: SolidWorks does not print them either.
 */
function paperOf(shapes: Shape[]): { width: number; height: number } {
  let box: number[] | null = null;
  let boxArea = 0;
  const all = [Infinity, Infinity, -Infinity, -Infinity];
  for (const shape of shapes) {
    if (shape.kind !== 'path') continue;
    const xs = shape.points.map((p) => p[0]);
    const ys = shape.points.map((p) => p[1]);
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (let n = 0; n < xs.length; n += 1) {
      b[0] = Math.min(b[0], xs[n]);
      b[1] = Math.min(b[1], ys[n]);
      b[2] = Math.max(b[2], xs[n]);
      b[3] = Math.max(b[3], ys[n]);
    }
    all[0] = Math.min(all[0], b[0]);
    all[1] = Math.min(all[1], b[1]);
    all[2] = Math.max(all[2], b[2]);
    all[3] = Math.max(all[3], b[3]);
    const rectangle =
      shape.points.length >= 4 &&
      shape.points.length <= 5 &&
      shape.points.every(([x, y]) => (near(x, b[0], 1e-5) || near(x, b[2], 1e-5)) && (near(y, b[1], 1e-5) || near(y, b[3], 1e-5)));
    const area = (b[2] - b[0]) * (b[3] - b[1]);
    if (rectangle && area > boxArea) {
      box = b;
      boxArea = area;
    }
  }
  const target = box ?? all;
  if (!Number.isFinite(target[0])) return { width: 0.42, height: 0.297 };
  const w = target[2] + Math.max(0, target[0]);
  const h = target[3] + Math.max(0, target[1]);
  const fits = PAPERS.flatMap(([a, b]) => [
    [a, b],
    [b, a],
  ]).filter(([pw, ph]) => w <= pw + 0.002 && h <= ph + 0.002);
  const paper = fits.sort((p, q) => p[0] * p[1] - q[0] * q[1])[0];
  return paper ? { width: paper[0], height: paper[1] } : { width: w, height: h };
}

export function readDrawing(entries: PackageEntry[]): Drawing | null {
  const dl = streamOf(entries, 'Contents/DisplayLists');
  if (!dl) return null;
  const vb = streamOf(entries, 'Contents/VBLists');

  const records = readSheets(dl);
  const annotations = readAnnotations(dl);
  const sheetRecords: SheetRecord[] =
    records.length > 0 ? records : [{ at: dl.length, name: 'Sheet1', ...paperOf(annotations.map((a) => a.shape)) }];
  const images = sheetRecords.map((_, k) => entries.find((e) => e.name === `Images/Sheet_${k}`)?.data ?? null);
  const rasters: (PngRaster | null)[] = images.map((png) => (png ? decodePng(png) : null));

  const maps: (PictureMap | null)[] = sheetRecords.map(() => null);
  const onSheet = (k: number, [x, y]: Point): boolean => {
    const raster = rasters[k];
    const map = maps[k];
    if (!raster || !map) return false;
    const px = Math.round(map.x + x * map.scale);
    const py = Math.round(map.y - y * map.scale);
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) if (raster.dark(px + dx, py + dy)) return true;
    return false;
  };
  const activeIndex = Math.max(0, sheetRecords.findIndex((s) => /-Active$/.test(s.name)));
  const byInk = (points: Point[]): number => {
    if (sheetRecords.length < 2) return 0;
    let best = activeIndex;
    let bestScore = 0;
    sheetRecords.forEach((_, k) => {
      const score = points.reduce((n, p) => n + (onSheet(k, p) ? 1 : 0), 0);
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    });
    return best;
  };
  const lastRecord = sheetRecords[sheetRecords.length - 1].at;

  const sheets: DrawingSheet[] = sheetRecords.map((record, k) => ({
    name: record.name.replace(/-Active$/, ''),
    width: record.width,
    height: record.height,
    active: k === activeIndex,
    shapes: [],
    views: [],
    image: images[k],
    patches: [],
    picture: null,
  }));

  // First what the stream itself places — each sheet's own format and notes —
  // which also tells where each sheet lies in its picture; then the rest.
  const later: Shape[] = [];
  for (const { at, shape } of annotations) {
    const k = sheetRecords.findIndex((record) => at < record.at);
    if (k < 0 || at >= lastRecord) later.push(shape);
    else sheets[k].shapes.push(shape);
  }
  sheets.forEach((sheet, k) => {
    const raster = rasters[k];
    if (!raster) return;
    // A sheet without a record of its own (older files) has everything as its own.
    const own = sheetRecords.length === 1 && records.length === 0 ? later : sheet.shapes;
    maps[k] = registerPicture(own, sheet, raster);
    sheet.picture = maps[k];
  });
  for (const shape of later) sheets[byInk(samples(shape))].shapes.push(shape);

  // Views on a sheet, by where their frame is: the view palette keeps its
  // thumbnails off the sheet, while a detail view's origin can be far off it
  // (its model's origin, magnified) with the view itself on the sheet.
  const largest = sheetRecords.reduce((a, b) => (a.width * a.height > b.width * b.height ? a : b));
  const allViews = readViews(dl);
  const shown = new Set(
    allViews.filter((view) => {
      const cx = (view.frame[0] + view.frame[2]) / 2;
      const cy = (view.frame[1] + view.frame[3]) / 2;
      return cx > -0.01 && cy > -0.01 && cx < largest.width + 0.01 && cy < largest.height + 0.01;
    }),
  );
  const buckets = vb ? readBuckets(vb) : [];
  assignBuckets(allViews, shown, buckets, buckets.map((b) => b.direction));
  const views = allViews.filter((view) => shown.has(view));
  findDetails(
    views,
    annotations.flatMap(({ shape }) => (shape.kind === 'path' && shape.circle ? [shape.circle] : [])),
    buckets,
  );

  for (const view of views) {
    const edges = viewEdges(view, buckets);
    const all: Point[] = [];
    for (const shape of edges) all.push(...samples(shape));
    const points = all.filter((_, n) => n % Math.max(1, Math.floor(all.length / 300)) === 0);
    const k = byInk(points.length > 0 ? points : [view.origin, [view.frame[0], view.frame[1]], [view.frame[2], view.frame[3]]]);
    // How much of the view the sheet picture shows. A view SolidWorks does not
    // draw — hidden — still has its record and edges, but they fall on paper.
    const ink = rasters[k] && points.length > 0 ? points.filter((p) => onSheet(k, p)).length / points.length : null;
    const hidden = ink !== null && ink < 0.3;
    // Much of it on blank paper but not all: placed wrong, somehow. Not drawn;
    // the picture fills in whatever of it SolidWorks did show.
    const doubtful = ink !== null && ink < 0.6;
    // One at a time: a big assembly view has more edges than a spread call takes.
    if (!hidden && !doubtful) for (const shape of edges) sheets[k].shapes.push(shape);
    sheets[k].views.push({
      scale: view.scale,
      origin: view.origin,
      frame: view.frame,
      drawn: edges.length > 0 && !hidden && !doubtful,
      hidden,
      ink,
      edges: edges.length,
    });
  }
  sheets.forEach((sheet, k) => {
    const raster = rasters[k];
    const map = maps[k];
    if (raster && map) sheet.patches = missingRegions(sheet, raster, map);
  });
  return { sheets };
}

/** The sheet fitted into the picture, centred: what most pictures are. */
function fitMap(sheet: { width: number; height: number }, raster: PngRaster): PictureMap {
  const scale = Math.min(raster.width / sheet.width, raster.height / sheet.height);
  const x = (raster.width - sheet.width * scale) / 2;
  const y = raster.height - (raster.height - sheet.height * scale) / 2;
  return { scale, x, y };
}

/**
 * Where the sheet lies in its picture, measured on the sheet's own lines (its
 * frame, title block, notes): the fitted placement when they fall on the
 * picture's ink, otherwise the one that puts the sheet's frame — its longest
 * straight lines — on the picture's, fine-tuned by a small search.
 */
function registerPicture(shapes: Shape[], sheet: { width: number; height: number }, raster: PngRaster): PictureMap {
  const fitted = fitMap(sheet, raster);
  const points: Point[] = [];
  for (const shape of shapes) {
    if (shape.kind !== 'path') continue;
    for (let k = 1; k < shape.points.length; k += 1) {
      const [a, b] = [shape.points[k - 1], shape.points[k]];
      const n = Math.min(200, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.002));
      for (let t = 0; t < n; t += 1) points.push([a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n]);
    }
  }
  if (points.length < 20) return fitted;
  const step = Math.max(1, Math.floor(points.length / 1500));
  const probe = points.filter((_, n) => n % step === 0);
  const score = (m: PictureMap) => {
    let hits = 0;
    for (const [x, y] of probe) {
      const px = Math.round(m.x + x * m.scale);
      const py = Math.round(m.y - y * m.scale);
      search: for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          if (raster.dark(px + dx, py + dy)) {
            hits += 1;
            break search;
          }
        }
      }
    }
    return hits / probe.length;
  };
  // Off by a pixel or two is common and enough to leave the picture's lines
  // beside the drawn ones: always fine-tuned, on exact hits.
  const exact = (m: PictureMap) => {
    let hits = 0;
    for (const [x, y] of probe) if (raster.dark(Math.round(m.x + x * m.scale), Math.round(m.y - y * m.scale))) hits += 1;
    return hits;
  };
  const tune = (start: PictureMap): PictureMap => {
    let found = start;
    let most = exact(start);
    for (const k of [0.99, 0.995, 1, 1.005, 1.01]) {
      for (let dx = -4; dx <= 4; dx += 1) {
        for (let dy = -4; dy <= 4; dy += 1) {
          const m = { scale: start.scale * k, x: start.x + dx, y: start.y + dy };
          const hits = exact(m);
          if (hits > most) {
            most = hits;
            found = m;
          }
        }
      }
    }
    return found;
  };
  const base = score(fitted);
  if (base >= 0.8) return tune(fitted);

  // The frame: the outermost long straight lines, in the sheet and in the picture.
  const sheetFrame = [Infinity, Infinity, -Infinity, -Infinity];
  for (const shape of shapes) {
    if (shape.kind !== 'path') continue;
    for (let k = 1; k < shape.points.length; k += 1) {
      const [a, b] = [shape.points[k - 1], shape.points[k]];
      if (Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(a[0] - b[0]) > sheet.width * 0.3) {
        sheetFrame[1] = Math.min(sheetFrame[1], a[1]);
        sheetFrame[3] = Math.max(sheetFrame[3], a[1]);
      }
      if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) > sheet.height * 0.3) {
        sheetFrame[0] = Math.min(sheetFrame[0], a[0]);
        sheetFrame[2] = Math.max(sheetFrame[2], a[0]);
      }
    }
  }
  const { width: W, height: H } = raster;
  let top = -1;
  let bottom = -1;
  let left = -1;
  let right = -1;
  for (let y = 0; y < H; y += 1) {
    let n = 0;
    for (let x = 0; x < W; x += 1) if (raster.dark(x, y)) n += 1;
    if (n >= W * 0.25) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  for (let x = 0; x < W; x += 1) {
    let n = 0;
    for (let y = 0; y < H; y += 1) if (raster.dark(x, y)) n += 1;
    if (n >= H * 0.25) {
      if (left < 0) left = x;
      right = x;
    }
  }
  let best = fitted;
  const bestScore = base;
  if (sheetFrame.every(Number.isFinite) && top >= 0 && left >= 0 && right > left && bottom > top) {
    const sx = (right - left) / (sheetFrame[2] - sheetFrame[0]);
    const sy = (bottom - top) / (sheetFrame[3] - sheetFrame[1]);
    if (Math.abs(sx - sy) / Math.max(sx, sy) < 0.06) {
      const scale = (sx + sy) / 2;
      const guess = tune({ scale, x: left - sheetFrame[0] * scale, y: bottom + sheetFrame[1] * scale });
      if (score(guess) > bestScore) best = guess;
    }
  }
  return best;
}

/**
 * Where the sheet picture has ink that the drawn sheet does not: the drawn
 * sheet is rasterised at the picture's resolution, wider than drawn (the
 * picture's lines are thicker and may sit a pixel off), and the uncovered
 * dark pixels are grouped into regions. Specks — a filled arrowhead drawn as
 * an outline, the odd pixel of a different font — are not worth a patch.
 */
function missingRegions(sheet: DrawingSheet, raster: PngRaster, map: PictureMap): [number, number, number, number][] {
  const { width: W, height: H } = raster;
  const s = map.scale;
  const toPx = ([x, y]: Point): Point => [map.x + x * s, map.y - y * s];
  // Only the sheet's own area of the picture: some pictures show more.
  const [sx0, sy0] = toPx([0, sheet.height]);
  const [sx1, sy1] = toPx([sheet.width, 0]);
  const covered = new Uint8Array(W * H);
  const pad = 3;
  const mark = (px: number, py: number) => {
    const cx = Math.round(px);
    const cy = Math.round(py);
    for (let dy = -pad; dy <= pad; dy += 1) {
      const y = cy + dy;
      if (y < 0 || y >= H) continue;
      for (let dx = -pad; dx <= pad; dx += 1) {
        const x = cx + dx;
        if (x >= 0 && x < W) covered[y * W + x] = 1;
      }
    }
  };
  const fill = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = Math.max(0, Math.floor(y0) - pad); y <= Math.min(H - 1, Math.ceil(y1) + pad); y += 1) {
      for (let x = Math.max(0, Math.floor(x0) - pad); x <= Math.min(W - 1, Math.ceil(x1) + pad); x += 1) covered[y * W + x] = 1;
    }
  };
  for (const shape of sheet.shapes) {
    if (shape.kind === 'path') {
      for (let k = 1; k < shape.points.length; k += 1) {
        const a = toPx(shape.points[k - 1]);
        const b = toPx(shape.points[k]);
        const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 2));
        if (steps > 20_000) continue;
        for (let t = 0; t <= steps; t += 1) mark(a[0] + ((b[0] - a[0]) * t) / steps, a[1] + ((b[1] - a[1]) * t) / steps);
      }
      if (shape.points.length === 1) mark(...toPx(shape.points[0]));
    } else {
      const length = shape.advances ? shape.advances.reduce((a, b) => a + b, 0) : shape.text.length * shape.height * 0.7;
      const c = Math.cos(shape.angle);
      const n = Math.sin(shape.angle);
      const corners = [
        // Generous: SolidWorks' picture sets text in its own font, often larger.
        [-0.6 * shape.height, -1],
        [length + 0.6 * shape.height, -1],
        [length + 0.6 * shape.height, 2],
        [-0.6 * shape.height, 2],
      ].map(([u, v]) => toPx([shape.at[0] + u * c - v * shape.height * n, shape.at[1] + u * n + v * shape.height * c]));
      fill(
        Math.min(...corners.map((p) => p[0])),
        Math.min(...corners.map((p) => p[1])),
        Math.max(...corners.map((p) => p[0])),
        Math.max(...corners.map((p) => p[1])),
      );
    }
  }

  // Uncovered ink, counted in cells of 4×4 pixels; cells joined when they touch.
  const cell = 4;
  const CW = Math.ceil(W / cell);
  const CH = Math.ceil(H / cell);
  const count = new Uint16Array(CW * CH);
  for (let y = 0; y < H; y += 1) {
    if (y < sy0 || y > sy1) continue;
    for (let x = Math.max(0, Math.ceil(sx0)); x < Math.min(W, sx1); x += 1) if (!covered[y * W + x] && raster.dark(x, y)) count[Math.floor(y / cell) * CW + Math.floor(x / cell)] += 1;
  }
  const seen = new Uint8Array(CW * CH);
  const regions: [number, number, number, number][] = [];
  for (let start = 0; start < CW * CH; start += 1) {
    if (seen[start] || count[start] < 2) continue;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    let pixels = 0;
    let cells = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const c = stack.pop() as number;
      const cx = c % CW;
      const cy = (c - cx) / CW;
      pixels += count[c];
      cells += 1;
      x0 = Math.min(x0, cx);
      y0 = Math.min(y0, cy);
      x1 = Math.max(x1, cx);
      y1 = Math.max(y1, cy);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= CW || ny >= CH) continue;
          const nc = ny * CW + nx;
          if (!seen[nc] && count[nc] >= 2) {
            seen[nc] = 1;
            stack.push(nc);
          }
        }
      }
    }
    if (pixels < 24 || cells < 3) continue;
    // Back to the sheet, one cell wider all round.
    const px0 = (x0 - 1) * cell;
    const px1 = (x1 + 2) * cell;
    const py0 = (y0 - 1) * cell;
    const py1 = (y1 + 2) * cell;
    regions.push([
      Math.max(0, (px0 - map.x) / s),
      Math.max(0, (map.y - py1) / s),
      Math.min(sheet.width, (px1 - map.x) / s),
      Math.min(sheet.height, (map.y - py0) / s),
    ]);
  }
  return regions;
}

/* ---------------------------------- SVG ----------------------------------- */

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const mm = (v: number) => Math.round(v * 1e5) / 100;

function dashes(style: string): string | null {
  if (/CENTER|CHAIN|ОСЕВ|ШТРИХПУНКТ/.test(style)) return '8 1.5 1 1.5';
  if (/PHANTOM|DIVIDE/.test(style)) return '10 1.5 1 1.5 1 1.5';
  if (/HIDDEN|DASH|ШТРИХ/.test(style)) return '3 1.5';
  if (/DOT/.test(style)) return '0.5 1';
  return null;
}

/**
 * One sheet as SVG, in millimetres with the sheet's top-left at 0,0. What
 * the file's own graphics did not give — see `patches` — shows from the
 * picture SolidWorks saved of the sheet, so nothing on it goes missing.
 */
export function sheetSvg(sheet: DrawingSheet): string {
  const raster = sheet.image ? decodePng(sheet.image) : null;
  // Inline: an SVG shown as an image may not fetch anything else.
  const imageHref = sheet.image && raster ? `data:image/png;base64,${sheet.image.toString('base64')}` : null;
  const W = sheet.width;
  const H = sheet.height;
  const X = (x: number) => mm(x);
  const Y = (y: number) => mm(H - y);
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${mm(W)} ${mm(H)}" width="${mm(W)}mm" height="${mm(H)}mm">`,
  );
  out.push(`<rect x="0" y="0" width="${mm(W)}" height="${mm(H)}" fill="#fff"/>`);

  const missing = sheet.patches;
  if (imageHref && raster && sheet.picture && missing.length > 0) {
    const { scale: s, x: px, y: py } = sheet.picture;
    out.push('<defs>');
    // The picture's paper is grey: lift the light tones to white so it sits on the
    // sheet, and keep its thin grey lines grey rather than blacken them.
    out.push(
      '<filter id="paper"><feComponentTransfer><feFuncR type="table" tableValues="0.1 0.55 0.85 1 1"/><feFuncG type="table" tableValues="0.1 0.55 0.85 1 1"/><feFuncB type="table" tableValues="0.1 0.55 0.85 1 1"/></feComponentTransfer></filter>',
    );
    // One clip of all the patches, one picture under it.
    out.push(
      `<clipPath id="patches">${missing
        .map(([x0, y0, x1, y1]) => `<rect x="${X(x0)}" y="${Y(y1)}" width="${mm(x1 - x0)}" height="${mm(y1 - y0)}"/>`)
        .join('')}</clipPath>`,
    );
    out.push('</defs>');
    out.push(
      `<image xlink:href="${esc(imageHref)}" href="${esc(imageHref)}" x="${mm(-px / s)}" y="${mm(H - py / s)}" width="${mm(raster.width / s)}" height="${mm(raster.height / s)}" clip-path="url(#patches)" filter="url(#paper)" preserveAspectRatio="none" data-sheet-picture="1"/>`,
    );
  }

  // Paths grouped by pen, so a sheet of thousands of edges stays a few elements.
  const groups = new Map<string, string[]>();
  for (const shape of sheet.shapes) {
    if (shape.kind !== 'path') continue;
    const d = shape.points.map(([x, y], k) => `${k ? 'L' : 'M'}${X(x)} ${Y(y)}`).join('');
    const key = `${shape.pen.color}|${shape.pen.widthMm}|${shape.pen.style}`;
    const list = groups.get(key) ?? [];
    list.push(d);
    groups.set(key, list);
  }
  for (const [key, list] of groups) {
    const [color, width, style] = key.split('|');
    const dash = dashes(style);
    out.push(
      `<path d="${list.join('')}" fill="none" stroke="#${Number(color).toString(16).padStart(6, '0')}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`,
    );
  }

  for (const shape of sheet.shapes) {
    if (shape.kind !== 'text' || !shape.text.trim()) continue;
    const size = mm(shape.height / 0.72);
    const deg = Math.round((-shape.angle * 180) / Math.PI * 100) / 100;
    // The line takes the length SolidWorks laid it out in, whatever font stands in.
    const length = shape.advances && shape.advances.length === shape.text.length ? shape.advances.reduce((a, b) => a + b, 0) : 0;
    const xs = length > 0 ? ` textLength="${mm(length)}" lengthAdjust="spacingAndGlyphs"` : '';
    out.push(
      `<text transform="translate(${X(shape.at[0])} ${Y(shape.at[1])})${deg ? ` rotate(${deg})` : ''}"${xs} font-size="${size}" font-family="${esc(shape.font)}, 'GOST type A', ISOCPEUR, 'Arial Narrow', Arial, sans-serif" font-style="italic" fill="#000" xml:space="preserve">${esc(shape.text)}</text>`,
    );
  }
  out.push('</svg>');
  return out.join('\n');
}

/** For investigating a drawing: its views, its buckets and how each bucket fits each view. */
export function drawingDiagnostics(entries: PackageEntry[]) {
  const dl = streamOf(entries, 'Contents/DisplayLists');
  const vb = streamOf(entries, 'Contents/VBLists');
  if (!dl) return null;
  const views = readViews(dl);
  const buckets = vb ? readBuckets(vb) : [];
  return {
    sheets: readSheets(dl).map((s) => ({ name: s.name, width: s.width, height: s.height, at: s.at })),
    views: views.map((v) => ({ at: v.at, scale: v.scale, origin: v.origin, frame: v.frame, direction: v.rotation[2] })),
    buckets: buckets.map((b) => ({
      direction: b.direction,
      edges: b.edges.length,
      fits: views.map((v) => {
        const { inside, all } = fit(v, b);
        return all ? Math.round((inside / all) * 100) : 0;
      }),
    })),
  };
}
