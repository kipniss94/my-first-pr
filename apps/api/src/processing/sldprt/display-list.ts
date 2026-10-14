/**
 * SolidWorks' own display mesh, read out of the part file.
 *
 * `Contents/DisplayLists` holds the triangulation SolidWorks draws on screen,
 * saved with the part. It is an MFC archive — class tags such as
 * `uoTempBodyTessData_c` for a body and `uoTempFaceTessData_c` for each face —
 * and each face carries its tessellation in a regular, self-describing layout:
 *
 *     4, 8, 2, <strips>, <length of each strip …>     strip table (u32 LE)
 *     12, 100, 2, <n>, x y z × n                       positions (f32 LE, metres)
 *     12, 100, 2, <n>, x y z × n                       normals   (f32 LE)
 *
 * The strip lengths must add up to `n`, and the normals must declare the same
 * `n` again. Those two agreements are what let a face be found by scanning
 * without first understanding every other record in the archive: a chance
 * alignment satisfying both does not happen.
 *
 * Why this and not the Parasolid B-rep next to it: the B-rep is exact, but
 * turning it into triangles means reimplementing a geometry kernel. This mesh
 * is already triangles, made by SolidWorks itself, with its own normals — so
 * curved faces shade smoothly and planar ones stay flat, exactly as they looked
 * in SolidWorks.
 *
 * ## How it was checked
 *
 * Against parts whose answer is known, by volume as well as size, because
 * volume only comes out right when every face is present, closed and oriented:
 *
 *     cube 10 mm          600 mm²   1000 mm³   exact
 *     cube 20 mm         2400 mm²   8000 mm³   exact
 *     sheet 50×100×2    10600 mm²  10000 mm³   exact
 *     cylinder Ø50×100  19610 mm² 195723 mm³   −0.3 %: the facets of a curve
 *     50 cube, Ø20 hole            109399 mm³   expected 109292
 *
 * and across 132 real parts, every one decodes to a closed mesh with positive
 * volume, in 5 ms on the median part.
 */

import { unwrapCodec, type PackageEntry } from './container.js';

const STRIP_TABLE = [4, 8, 2];
const VERTEX_ARRAY = [12, 100, 2];
/** A face with more strips than this is not a face; the header matched by chance. */
const MAX_STRIPS = 1_000_000;

export interface DisplayFace {
  /** Positions, metres, xyz interleaved. */
  positions: Float32Array;
  /** Unit normals, xyz interleaved, one per position. */
  normals: Float32Array;
  /** Triangle-strip lengths; they sum to the vertex count. */
  strips: number[];
  /** Its colour as SolidWorks shows it, 0–255, when the file says. */
  color?: [number, number, number];
}

function header(data: Buffer, at: number, expected: number[]): boolean {
  if (at + expected.length * 4 > data.length) return false;
  for (let i = 0; i < expected.length; i += 1) if (data.readUInt32LE(at + i * 4) !== expected[i]) return false;
  return true;
}

function readFloats(data: Buffer, at: number, count: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) out[i] = data.readFloatLE(at + i * 4);
  return out;
}

/** Every face tessellation in one display-list entry. */
export function decodeDisplayList(data: Buffer): DisplayFace[] {
  return decodeFaces(data).faces;
}

/** The faces, and where in the data each one's record lies. */
export function decodeFaces(data: Buffer): { faces: DisplayFace[]; spans: { at: number; end: number }[] } {
  const faces: DisplayFace[] = [];
  const spans: { at: number; end: number }[] = [];
  let at = 0;

  while (at + 20 <= data.length) {
    if (!header(data, at, STRIP_TABLE)) {
      at += 1;
      continue;
    }
    const stripCount = data.readUInt32LE(at + 12);
    const vertexHeader = at + 16 + stripCount * 4;
    if (stripCount < 1 || stripCount > MAX_STRIPS || !header(data, vertexHeader, VERTEX_ARRAY)) {
      at += 1;
      continue;
    }

    const strips: number[] = [];
    let total = 0;
    for (let i = 0; i < stripCount; i += 1) {
      const length = data.readUInt32LE(at + 16 + i * 4);
      strips.push(length);
      total += length;
    }
    const count = data.readUInt32LE(vertexHeader + 12);
    const positionsAt = vertexHeader + 16;
    const normalHeader = positionsAt + count * 12;
    if (
      count !== total ||
      count < 3 ||
      normalHeader + 16 + count * 12 > data.length ||
      !header(data, normalHeader, VERTEX_ARRAY) ||
      data.readUInt32LE(normalHeader + 12) !== count
    ) {
      at += 1;
      continue;
    }

    faces.push({
      positions: readFloats(data, positionsAt, count * 3),
      normals: readFloats(data, normalHeader + 16, count * 3),
      strips,
    });
    spans.push({ at, end: normalHeader + 16 + count * 12 });
    at = normalHeader + 16 + count * 12;
  }

  readColours(data, spans).forEach((color, k) => {
    if (color) faces[k].color = color;
  });
  return { faces, spans };
}

/* --------------------------------- colour --------------------------------- */

/**
 * The appearance inside a visual-properties object: its material's name, a
 * small flag, the colour as R G B 0, then 1.0f. The first one in [from, to).
 */
export function appearance(
  data: Buffer,
  from: number,
  to: number,
): { color: [number, number, number] | null; start: number; end: number } | null {
  for (let i = Math.max(0, from); i + 13 <= Math.min(to, data.length); i += 1) {
    if (data[i] !== 0xff || data[i + 1] !== 0xfe || data[i + 2] !== 0xff) continue;
    const n = data[i + 3];
    const end = i + 4 + n * 2;
    if (n > 0 && end + 9 <= data.length && data[end] <= 3 && data[end + 4] === 0 && data.readFloatLE(end + 5) === 1) {
      let color: [number, number, number] = [data[end + 1], data[end + 2], data[end + 3]];
      // A grey metal saved with a loud colour (pure red on a stainless bolt)
      // is a material SolidWorks did not find, not the colour it showed.
      const material = data.subarray(i + 4, end).toString('utf16le');
      // A textured material (wood, glass…) keeps white as its tint: the
      // picture gives its colour, so the colour it mostly has stands in.
      if (color.every((c) => c >= 240)) color = TEXTURES.find(([pattern]) => pattern.test(material))?.[1] ?? color;
      const max = Math.max(...color);
      const loud = max > 0 && (max - Math.min(...color)) / max > 0.6;
      const grey = /steel|alumin|nickel|chrom|zinc|galvani|iron|titan/i.test(material);
      return { color: loud && grey ? null : color, start: i, end: end + 9 };
    }
  }
  return null;
}

/** Textured appearances, by name, and the colour each mostly shows. */
const TEXTURES: [RegExp, [number, number, number]][] = [
  [/walnut/i, [112, 74, 48]],
  [/mahogany/i, [122, 58, 42]],
  [/cherry/i, [158, 92, 62]],
  [/teak/i, [158, 108, 62]],
  [/oak/i, [178, 128, 78]],
  [/pine/i, [214, 172, 112]],
  [/maple|birch|beech|ash/i, [222, 190, 142]],
  [/wood|plywood|veneer|bamboo/i, [190, 146, 96]],
  [/glass/i, [205, 226, 236]],
  [/concrete|cement/i, [172, 172, 166]],
  [/brick/i, [160, 82, 62]],
  [/granite|marble|stone/i, [196, 194, 190]],
  [/carpet|fabric|cloth|leather/i, [110, 100, 92]],
];

/** What stands in front of a face's colour pointer, in the two record versions seen. */
const SLOTS = [Buffer.from([1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]), Buffer.from([2, 0, 0, 0, 1, 0, 0, 0])];
const PROPS_CLASS = Buffer.from('moVisualProperties_c', 'latin1');
const BODY_CLASS = Buffer.from('uoTempBodyTessData_c', 'latin1');
const FACE_CLASS = Buffer.from('uoTempFaceTessData_c', 'latin1');

/**
 * Each face's colour, as SolidWorks drew it.
 *
 * The display list is an MFC archive, and colours are visual-properties
 * objects (`moVisualProperties_c`) in it. One stands before each body: the
 * body's colour. Each face record ends, after its arrays, with a pointer to
 * its own — behind `01 00 00 00 FF FF FF FF`, or in older files behind
 * `02 00 00 00 01 00 00 00` and given twice: 0 when the face has none (it
 * takes the body's), a new object (the class index | 0x8000, or the class
 * defined there), or the load index of one stored before. MFC numbers
 * classes and objects in the order they are read, so counting from the face
 * class — whose index is the tag in front of the second face, the first face
 * following its class's definition — gives every object its index: one per
 * face and body, one per colour stored. A pointer that does not lead to a
 * colour leaves the body's.
 *
 * Checked against the pictures SolidWorks saves in the file: a diode's black
 * body, white band and yellow leads come out face by face.
 */
function readColours(data: Buffer, spans: { at: number; end: number }[]): ([number, number, number] | null)[] {
  if (spans.length === 0) return [];
  // The first body's colour: the last appearance before its first face.
  let body: [number, number, number] | null = null;
  for (let from = Math.max(0, spans[0].at - 4000); ; ) {
    const found = appearance(data, from, spans[0].at);
    if (!found) break;
    body = found.color;
    from = found.end;
  }
  const own: ([number, number, number] | null)[] = spans.map(() => null);
  const bodies: ([number, number, number] | null)[] = spans.map(() => body);

  // Object indices, when the face class can be placed: right after the body
  // class, which comes right after the body's colour (one object each).
  const faceClassAt = data.lastIndexOf(FACE_CLASS, spans[0].at);
  const bodyClassAt = faceClassAt >= 0 ? data.lastIndexOf(BODY_CLASS, faceClassAt) : -1;
  const tag = spans.length > 1 ? data.readUInt16LE(spans[1].at - 10) : 0;
  const counting = faceClassAt >= 0 && spans[0].at - faceClassAt <= 40 && (tag & 0x8000) !== 0;
  let counter = tag & 0x7fff;
  const colours = new Map<number, [number, number, number]>();
  if (counting && body && bodyClassAt >= 0 && faceClassAt - bodyClassAt <= 40) colours.set(counter - 3, body);
  // Where the colour class is defined, looked up once: per face, a miss would scan to the end.
  const propsClassAt = data.indexOf(PROPS_CLASS);
  let classSeen = propsClassAt >= 0 && propsClassAt < spans[0].at;

  for (let k = 0; k < spans.length; k += 1) {
    const from = spans[k].end;
    const to = k + 1 < spans.length ? spans[k + 1].at - 10 : Math.min(data.length, spans[k].end + 4000);
    counter += 1; // this face
    bodies[k] = body;

    // Every colour stored new in this stretch, each with its index.
    const stored: { start: number; end: number; index: number; color: [number, number, number] | null }[] = [];
    const classAt = !classSeen && propsClassAt >= from && propsClassAt < to ? propsClassAt : -1;
    for (let cursor = from; ; ) {
      const found = appearance(data, cursor, to);
      if (!found) break;
      if (classAt >= 0 && classAt < found.start && !classSeen) {
        counter += 1;
        classSeen = true;
      }
      counter += 1;
      if (found.color) colours.set(counter, found.color);
      stored.push({ start: found.start, end: found.end, index: counter, color: found.color });
      cursor = found.end;
    }

    // A body starting with the next face: its colour stored just before its
    // tag, the tag and face count, then the face's tag.
    const next = k + 1 < spans.length ? spans[k + 1].at : -1;
    const bodyNext =
      next >= 0 &&
      next - 14 > from &&
      (data.readUInt16LE(next - 14) & 0x8000) !== 0 &&
      data.readUInt16LE(next - 12) > 0 &&
      data.readUInt16LE(next - 12) < 0x8000;
    const last = stored[stored.length - 1];
    const bodyColour = bodyNext && last && next - 14 - last.end < 400 ? last : null;
    // After the last face come the list's own closing records, colour among them.
    const mine = bodyColour ? stored.slice(0, -1) : next < 0 ? stored.slice(0, 1) : stored;

    // The face's own colour: one pointer per display state. Stored new here
    // — the last state's wins — or one stored before: in the newer records
    // (one state, `01 00 00 00 FF FF FF FF`) the pointer sits 26 bytes before
    // the next face's tag; in the older ones (`02 00 00 00`, then state 1 and
    // its pointer, state 2 and its) it is the second, else the first.
    if (mine.length > 0) own[k] = mine[mine.length - 1].color;
    else if (counting) {
      let pointer = 0;
      if (to - 34 >= from && data.subarray(to - 34, to - 26).equals(SLOTS[0])) pointer = data.readUInt16LE(to - 26);
      else {
        // Searched within this face's stretch only: past it, every face would scan to the end.
        const stretch = data.subarray(from, Math.max(from, to));
        for (let r = stretch.indexOf(SLOTS[1]); r >= 0 && from + r + 16 <= to; r = stretch.indexOf(SLOTS[1], r + 1)) {
          const s = from + r;
          if (data.readUInt32LE(s + 10) !== 2) continue;
          const second = data.readUInt16LE(s + 14);
          pointer = second !== 0 && second < 0x8000 ? second : data.readUInt16LE(s + 8);
        }
      }
      if (pointer > 0 && pointer < 0x8000) own[k] = colours.get(pointer) ?? null;
    }

    if (bodyNext) {
      if (bodyColour) body = bodyColour.color;
      counter += 1;
    }
  }
  return own.map((color, k) => color ?? bodies[k]);
}

/**
 * The part's display mesh: the display-list entry with the most faces.
 *
 * A part keeps several display lists — per configuration, and small ones for
 * sketches and reference geometry. The body tessellation is the richest.
 */
export function findDisplayMesh(entries: PackageEntry[]): DisplayFace[] {
  let best: DisplayFace[] = [];
  for (const entry of entries) {
    if (!/(^|\/)DisplayLists$/.test(entry.name)) continue;
    const faces = decodeDisplayList(entry.data);
    if (faces.length > best.length) best = faces;
  }
  return best;
}

export interface IndexedMesh {
  /** Millimetres, xyz interleaved — the unit the viewer measures in. */
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Per face, the first and last triangle index, for picking a face. */
  faceRanges: { first: number; last: number }[];
  /** Per face range, its colour (0–255), when the file says. */
  faceColors?: ([number, number, number] | null)[];
  triangles: number;
}

/**
 * Strips to indexed triangles, in millimetres.
 *
 * Strip winding alternates and SolidWorks does not promise which way a strip
 * starts, so each triangle is turned to agree with the normals SolidWorks
 * stored for its corners. Getting this wrong would not show on screen with
 * double-sided rendering, but it would make every volume and section wrong.
 */
export function toIndexedMesh(faces: DisplayFace[]): IndexedMesh {
  let vertexCount = 0;
  let triangleCount = 0;
  for (const face of faces) {
    vertexCount += face.positions.length / 3;
    for (const length of face.strips) triangleCount += Math.max(0, length - 2);
  }

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(triangleCount * 3);
  const faceRanges: { first: number; last: number }[] = [];
  const faceColors: ([number, number, number] | null)[] = [];

  let vertexBase = 0;
  let triangle = 0;
  for (const face of faces) {
    const n = face.positions.length / 3;
    for (let i = 0; i < n * 3; i += 1) {
      positions[vertexBase * 3 + i] = face.positions[i] * 1000;
      normals[vertexBase * 3 + i] = face.normals[i];
    }

    const firstTriangle = triangle;
    let stripStart = 0;
    for (const length of face.strips) {
      for (let k = 0; k + 2 < length; k += 1) {
        const a = stripStart + k;
        let b = a + 1;
        let c = a + 2;
        if (!agreesWithNormals(face, a, b, c)) [b, c] = [c, b];
        indices[triangle * 3] = vertexBase + a;
        indices[triangle * 3 + 1] = vertexBase + b;
        indices[triangle * 3 + 2] = vertexBase + c;
        triangle += 1;
      }
      stripStart += length;
    }
    if (triangle > firstTriangle) {
      faceRanges.push({ first: firstTriangle, last: triangle - 1 });
      faceColors.push(face.color ?? null);
    }
    vertexBase += n;
  }

  const coloured = faceColors.some(Boolean);
  return { positions, normals, indices, faceRanges, ...(coloured ? { faceColors } : {}), triangles: triangle };
}

function agreesWithNormals(face: DisplayFace, a: number, b: number, c: number): boolean {
  const p = face.positions;
  const ux = p[b * 3] - p[a * 3];
  const uy = p[b * 3 + 1] - p[a * 3 + 1];
  const uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3];
  const vy = p[c * 3 + 1] - p[a * 3 + 1];
  const vz = p[c * 3 + 2] - p[a * 3 + 2];
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  const nm = face.normals;
  const nx = nm[a * 3] + nm[b * 3] + nm[c * 3];
  const ny = nm[a * 3 + 1] + nm[b * 3 + 1] + nm[c * 3 + 1];
  const nz = nm[a * 3 + 2] + nm[b * 3 + 2] + nm[c * 3 + 2];
  return cx * nx + cy * ny + cz * nz >= 0;
}

/** Surface area (mm²) and enclosed volume (mm³) — the checks the tests rely on. */
type Rgb = [number, number, number];

/**
 * The part's colour from `ThirdPtyStore/VisualStates`, for a mesh that does
 * not carry its own (the B-rep, triangulated here): its bodies' colour when
 * they all share one, else the part's. Feature and face colours are left
 * out — nothing ties them to the B-rep's faces here.
 */
export function visualStatesColour(entries: PackageEntry[]): Rgb | null {
  const raw = entries.find((entry) => entry.name === 'ThirdPtyStore/VisualStates')?.data;
  const data = raw ? (unwrapCodec(raw) ?? raw) : null;
  if (!data) return null;
  const at = (name: string, from = 0) => data.indexOf(Buffer.from(name, 'latin1'), from);
  const unit = at('moUnitComponent_c');
  if (unit < 0) return null;
  const later = ['moCompSolidBody_c', 'moCompFeature_c', 'moCompFace_c'].map((name) => at(name, unit)).filter((p) => p > 0);
  const colours = (from: number, to: number) => {
    const found: Rgb[] = [];
    for (let cursor = from; ; ) {
      const next = appearance(data, cursor, to);
      if (!next) break;
      if (next.color) found.push(next.color);
      cursor = next.end;
    }
    return found;
  };
  const part = colours(unit, later.length > 0 ? Math.min(...later) : data.length)[0] ?? null;
  const body = at('moCompSolidBody_c', unit);
  if (body > 0) {
    const stops = ['moCompFeature_c', 'moCompFace_c'].map((name) => at(name, body)).filter((p) => p > 0);
    const bodies = colours(body, stops.length > 0 ? Math.min(...stops) : data.length);
    if (bodies.length > 0 && bodies.every((c) => c.join() === bodies[0].join())) return bodies[0];
  }
  return part;
}

/**
 * A mesh's faces as the geometry writer takes them, each with its colour
 * (0–1), and the colour most of its triangles have as the mesh's own. A
 * mesh without colours of its own takes `fallback` (0–255) throughout.
 */
export function colouredFaces(
  mesh: IndexedMesh,
  fallback: Rgb | null = null,
): { color?: Rgb; brep_faces: { first: number; last: number; color: Rgb | null }[] } {
  const colours = mesh.faceColors ?? mesh.faceRanges.map(() => fallback);
  const unit = (c: Rgb | null | undefined): Rgb | null => (c ? [c[0] / 255, c[1] / 255, c[2] / 255] : null);
  const tally = new Map<string, { colour: Rgb; triangles: number }>();
  mesh.faceRanges.forEach((range, k) => {
    const colour = colours[k];
    if (!colour) return;
    const entry = tally.get(colour.join()) ?? { colour, triangles: 0 };
    entry.triangles += range.last - range.first + 1;
    tally.set(colour.join(), entry);
  });
  const main = [...tally.values()].sort((a, b) => b.triangles - a.triangles)[0];
  return {
    ...(main ? { color: unit(main.colour)! } : {}),
    brep_faces: mesh.faceRanges.map((range, k) => ({ ...range, color: unit(colours[k]) })),
  };
}

/** The colour most of a display mesh's faces have, 0–255. */
export function mainColour(faces: DisplayFace[]): Rgb | null {
  const tally = new Map<string, { colour: Rgb; vertices: number }>();
  for (const face of faces) {
    if (!face.color) continue;
    const entry = tally.get(face.color.join()) ?? { colour: face.color, vertices: 0 };
    entry.vertices += face.positions.length;
    tally.set(face.color.join(), entry);
  }
  return [...tally.values()].sort((a, b) => b.vertices - a.vertices)[0]?.colour ?? null;
}

export function measureMesh(mesh: IndexedMesh): { area: number; volume: number; size: [number, number, number] } {
  const p = mesh.positions;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      lo[axis] = Math.min(lo[axis], p[i + axis]);
      hi[axis] = Math.max(hi[axis], p[i + axis]);
    }
  }
  let area = 0;
  let volume = 0;
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    volume +=
      (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
        p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) /
      6;
  }
  return { area, volume, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
}
