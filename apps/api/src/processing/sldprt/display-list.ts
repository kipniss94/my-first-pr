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

import type { PackageEntry } from './container.js';

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
  const faces: DisplayFace[] = [];
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
    at = normalHeader + 16 + count * 12;
  }

  return faces;
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
    if (triangle > firstTriangle) faceRanges.push({ first: firstTriangle, last: triangle - 1 });
    vertexBase += n;
  }

  return { positions, normals, indices, faceRanges, triangles: triangle };
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
