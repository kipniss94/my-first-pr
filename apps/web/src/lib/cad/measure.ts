import * as THREE from 'three';
import type { CadPart } from './types';

/**
 * Smart measurement: what the user points at, and the dimensions an engineer
 * would want between those things.
 *
 * A part arrives as triangles. For B-Rep formats each face's triangles are
 * known; for plain meshes faces are grown from triangles whose normals turn
 * gently. Edges are the seams between two faces, split where they turn a
 * corner or change from straight to curved. Each face is then recognised as
 * a plane, cylinder, cone or sphere by fitting, and each edge as a line,
 * circle or arc — the same vocabulary as a drawing's dimensions.
 */

type V3 = THREE.Vector3;
const v = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/* --------------------------------- shapes ---------------------------------- */

export type Surface =
  | { type: 'plane'; normal: V3; point: V3; area: number }
  | {
      type: 'cylinder';
      axis: V3;
      /** On the axis, halfway along the face. */
      center: V3;
      radius: number;
      length: number;
      /** Normals point at the axis: a bore, not a boss. */
      hole: boolean;
      area: number;
    }
  | { type: 'cone'; axis: V3; center: V3; halfAngle: number; rMin: number; rMax: number; length: number; area: number }
  | { type: 'sphere'; center: V3; radius: number; area: number }
  | { type: 'surface'; area: number };

export type Curve =
  | { type: 'line'; a: V3; b: V3; length: number }
  | { type: 'circle'; center: V3; normal: V3; radius: number; full: boolean; angle: number; length: number; a: V3; b: V3 }
  | { type: 'curve'; length: number; points: V3[] };

export type Entity =
  | { kind: 'face'; part: CadPart; index: number; surface: Surface; points: V3[]; perimeter: number }
  | { kind: 'edge'; part: CadPart; index: number; curve: Curve; points: V3[] }
  | { kind: 'vertex'; part: CadPart; index: number; point: V3 };

export type OptionKind = 'distance' | 'angle' | 'diameter' | 'radius' | 'length' | 'area' | 'coords';

export interface MeasureOption {
  key: string;
  /** English; the interface translates it. */
  label: string;
  kind: OptionKind;
  value: number;
  /** The dimension line, world space. */
  a?: V3;
  b?: V3;
  /** A circle drawn with a diameter or radius. */
  circle?: { center: V3; normal: V3; radius: number };
  /** An angle: drawn as an arc at `center` from direction `from` to `to`. */
  arc?: { center: V3; from: V3; to: V3; radius: number };
  /** Coordinates of a point. */
  point?: V3;
  labelAt: V3;
}

/* -------------------------------- topology --------------------------------- */

interface EdgeChain {
  faces: [number, number];
  /** Welded vertex ids along the edge. */
  vertices: number[];
  closed: boolean;
}

export interface Topology {
  part: CadPart;
  /** Welded vertex positions, local. */
  points: Float32Array;
  triFace: Int32Array;
  faceTriangles: number[][];
  faceVertices: number[][];
  edges: EdgeChain[];
  faceEdges: number[][];
  span: number;
  surfaces: (Surface | null | undefined)[];
  curves: (Curve | null | undefined)[];
}

/** Above this a part is measured point to point only; finding its faces would stall the page. */
export const TOPOLOGY_TRIANGLE_LIMIT = 600_000;

const topologies = new WeakMap<THREE.BufferGeometry, Topology | null>();

export function topologyOf(part: CadPart): Topology | null {
  const geometry = part.mesh.geometry;
  if (topologies.has(geometry)) {
    const cached = topologies.get(geometry) ?? null;
    return cached ? { ...cached, part } : null;
  }
  const built = part.triangles > TOPOLOGY_TRIANGLE_LIMIT ? null : buildTopology(part);
  topologies.set(geometry, built);
  return built;
}

function buildTopology(part: CadPart): Topology | null {
  const geometry = part.mesh.geometry;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!position) return null;
  const indexAttr = geometry.getIndex();
  const index = indexAttr ? (indexAttr.array as ArrayLike<number>) : null;
  const triangleCount = index ? Math.floor(index.length / 3) : Math.floor(position.count / 3);
  if (triangleCount === 0) return null;
  const vertexOf = (t: number, k: number) => (index ? index[t * 3 + k] : t * 3 + k);

  geometry.computeBoundingBox();
  const box = geometry.boundingBox ?? new THREE.Box3();
  const span = box.getSize(v()).length() || 1;

  // Weld coincident vertices: faces carry their own copies along shared edges.
  const tolerance = span * 1e-7;
  const welded = new Int32Array(position.count);
  const weldMap = new Map<string, number>();
  const weldedPoints: number[] = [];
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const key = `${Math.round(x / tolerance)},${Math.round(y / tolerance)},${Math.round(z / tolerance)}`;
    let id = weldMap.get(key);
    if (id === undefined) {
      id = weldedPoints.length / 3;
      weldMap.set(key, id);
      weldedPoints.push(x, y, z);
    }
    welded[i] = id;
  }
  const points = new Float32Array(weldedPoints);
  const vertexCount = points.length / 3;

  // Which face each triangle is on.
  const triFace = new Int32Array(triangleCount).fill(-1);
  let faceCount = 0;
  if (part.faceRanges && part.faceRanges.length > 0) {
    faceCount = part.faceRanges.length / 2;
    for (let f = 0; f < faceCount; f += 1) {
      const first = part.faceRanges[f * 2];
      const last = Math.min(part.faceRanges[f * 2 + 1], triangleCount - 1);
      for (let t = first; t <= last; t += 1) triFace[t] = f;
    }
  }

  // Edge map: welded edge key → the first triangle that used it.
  const edgeKey = (a: number, b: number) => (a < b ? a * vertexCount + b : b * vertexCount + a);
  const firstUse = new Map<number, number>();
  const neighbours: number[][] | null = faceCount === 0 ? Array.from({ length: triangleCount }, () => []) : null;
  for (let t = 0; t < triangleCount; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const a = welded[vertexOf(t, k)];
      const b = welded[vertexOf(t, (k + 1) % 3)];
      if (a === b) continue;
      const key = edgeKey(a, b);
      const other = firstUse.get(key);
      if (other === undefined) firstUse.set(key, t);
      else if (neighbours) {
        neighbours[t].push(other);
        neighbours[other].push(t);
      }
    }
  }

  // Plain meshes: grow faces across gentle turns.
  if (neighbours) {
    const normals = triangleNormals(position, triangleCount, vertexOf);
    const limit = Math.cos(THREE.MathUtils.degToRad(32));
    for (let seed = 0; seed < triangleCount; seed += 1) {
      if (triFace[seed] >= 0) continue;
      const face = faceCount++;
      triFace[seed] = face;
      const stack = [seed];
      while (stack.length > 0) {
        const t = stack.pop() as number;
        for (const n of neighbours[t]) {
          if (triFace[n] >= 0) continue;
          const dot = normals[t * 3] * normals[n * 3] + normals[t * 3 + 1] * normals[n * 3 + 1] + normals[t * 3 + 2] * normals[n * 3 + 2];
          if (dot < limit) continue;
          triFace[n] = face;
          stack.push(n);
        }
      }
    }
  }
  for (let t = 0; t < triangleCount; t += 1) if (triFace[t] < 0) triFace[t] = faceCount++;

  const faceTriangles: number[][] = Array.from({ length: faceCount }, () => []);
  for (let t = 0; t < triangleCount; t += 1) faceTriangles[triFace[t]].push(t);
  const faceVertices: number[][] = faceTriangles.map((tris) => {
    const set = new Set<number>();
    for (const t of tris) for (let k = 0; k < 3; k += 1) set.add(welded[vertexOf(t, k)]);
    return [...set];
  });

  // Seams: welded edges whose two triangles are on different faces (or with one triangle: open).
  const pairUse = new Map<number, number>();
  const seams = new Map<string, [number, number][]>();
  for (let t = 0; t < triangleCount; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const a = welded[vertexOf(t, k)];
      const b = welded[vertexOf(t, (k + 1) % 3)];
      if (a === b) continue;
      const key = edgeKey(a, b);
      const other = pairUse.get(key);
      if (other === undefined) {
        pairUse.set(key, t);
        continue;
      }
      pairUse.delete(key);
      const f1 = triFace[other];
      const f2 = triFace[t];
      if (f1 === f2) continue;
      const faceKey = f1 < f2 ? `${f1}|${f2}` : `${f2}|${f1}`;
      const list = seams.get(faceKey) ?? [];
      list.push([a, b]);
      seams.set(faceKey, list);
    }
  }
  for (const [key, t] of pairUse) {
    // Open boundary: an edge of one face only.
    const a = Math.floor(key / vertexCount);
    const b = key % vertexCount;
    const faceKey = `${triFace[t]}|-1`;
    const list = seams.get(faceKey) ?? [];
    list.push([a, b]);
    seams.set(faceKey, list);
  }

  const point = (id: number) => v(points[id * 3], points[id * 3 + 1], points[id * 3 + 2]);
  const edges: EdgeChain[] = [];
  for (const [faceKey, segments] of seams) {
    const [f1, f2] = faceKey.split('|').map(Number) as [number, number];
    for (const chain of chainSegments(segments)) {
      for (const piece of splitChain(chain.vertices, chain.closed, point)) {
        edges.push({ faces: [f1, f2], vertices: piece.vertices, closed: piece.closed });
      }
    }
  }
  const faceEdges: number[][] = Array.from({ length: faceCount }, () => []);
  edges.forEach((edge, id) => {
    if (edge.faces[0] >= 0) faceEdges[edge.faces[0]].push(id);
    if (edge.faces[1] >= 0) faceEdges[edge.faces[1]].push(id);
  });

  return {
    part,
    points,
    triFace,
    faceTriangles,
    faceVertices,
    edges,
    faceEdges,
    span,
    surfaces: new Array(faceCount),
    curves: new Array(edges.length),
  };
}

function triangleNormals(
  position: THREE.BufferAttribute,
  count: number,
  vertexOf: (t: number, k: number) => number,
): Float32Array {
  const out = new Float32Array(count * 3);
  const a = v();
  const b = v();
  const c = v();
  for (let t = 0; t < count; t += 1) {
    a.fromBufferAttribute(position, vertexOf(t, 0));
    b.fromBufferAttribute(position, vertexOf(t, 1));
    c.fromBufferAttribute(position, vertexOf(t, 2));
    const n = b.sub(a).cross(c.sub(a));
    const length = n.length() || 1;
    out[t * 3] = n.x / length;
    out[t * 3 + 1] = n.y / length;
    out[t * 3 + 2] = n.z / length;
  }
  return out;
}

/** Segments joined into polylines: open ones from their ends, then loops. */
function chainSegments(segments: [number, number][]): { vertices: number[]; closed: boolean }[] {
  const around = new Map<number, number[]>();
  segments.forEach(([a, b], i) => {
    around.set(a, [...(around.get(a) ?? []), i]);
    around.set(b, [...(around.get(b) ?? []), i]);
  });
  const used = new Uint8Array(segments.length);
  const chains: { vertices: number[]; closed: boolean }[] = [];
  const walk = (start: number) => {
    const vertices = [start];
    let at = start;
    for (;;) {
      const next = (around.get(at) ?? []).find((i) => !used[i]);
      if (next === undefined) break;
      used[next] = 1;
      const [a, b] = segments[next];
      at = a === at ? b : a;
      vertices.push(at);
      if (at === start) break;
    }
    return vertices;
  };
  for (const [vertex, list] of around) {
    if (list.length !== 1 || list.every((i) => used[i])) continue;
    const vertices = walk(vertex);
    if (vertices.length > 1) chains.push({ vertices, closed: false });
  }
  for (let i = 0; i < segments.length; i += 1) {
    if (used[i]) continue;
    const vertices = walk(segments[i][0]);
    if (vertices.length > 1) chains.push({ vertices, closed: vertices[0] === vertices[vertices.length - 1] });
  }
  return chains;
}

/**
 * A seam split into pieces a drawing would name separately: at corners, and
 * where it changes from straight to curved (a slot's side and its round end).
 */
function splitChain(
  vertices: number[],
  closed: boolean,
  point: (id: number) => V3,
): { vertices: number[]; closed: boolean }[] {
  const n = vertices.length;
  if (n < 3) return [{ vertices, closed: false }];
  const corner = Math.cos(THREE.MathUtils.degToRad(28));
  const straight = Math.cos(THREE.MathUtils.degToRad(0.4));
  const turn = (i: number): number => {
    const prev = point(vertices[(i - 1 + (closed ? n - 1 : n)) % (closed ? n - 1 : n)]);
    const here = point(vertices[i]);
    const next = point(vertices[(i + 1) % (closed ? n - 1 : n)]);
    const d1 = here.clone().sub(prev).normalize();
    const d2 = next.clone().sub(here).normalize();
    return d1.dot(d2);
  };
  const count = closed ? n - 1 : n;
  const breaks: number[] = [];
  let lastStraight: boolean | null = null;
  for (let i = closed ? 0 : 1; i < (closed ? count : count - 1); i += 1) {
    const dot = turn(i);
    const isStraight = dot > straight;
    if (dot < corner || (lastStraight !== null && isStraight !== lastStraight)) breaks.push(i);
    lastStraight = isStraight;
  }
  if (breaks.length === 0) return [{ vertices, closed }];
  const pieces: { vertices: number[]; closed: boolean }[] = [];
  if (closed) {
    const ring = vertices.slice(0, count);
    for (let k = 0; k < breaks.length; k += 1) {
      const from = breaks[k];
      const to = breaks[(k + 1) % breaks.length];
      const piece: number[] = [];
      for (let i = from; ; i = (i + 1) % count) {
        piece.push(ring[i]);
        if (i === to && piece.length > 1) break;
        if (piece.length > count + 1) break;
      }
      pieces.push({ vertices: piece, closed: false });
    }
  } else {
    let from = 0;
    for (const at of [...breaks, n - 1]) {
      pieces.push({ vertices: vertices.slice(from, at + 1), closed: false });
      from = at;
    }
  }
  return pieces.filter((piece) => piece.vertices.length > 1);
}

/* ------------------------------ recognition -------------------------------- */

/** Eigen decomposition of a symmetric 3×3 matrix (Jacobi); values ascending. */
function eigen3(m: number[][]): { values: number[]; vectors: V3[] } {
  const a = m.map((row) => [...row]);
  const vecs = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep += 1) {
    let off = 0;
    for (let p = 0; p < 3; p += 1) for (let q = p + 1; q < 3; q += 1) off += a[p][q] * a[p][q];
    if (off < 1e-30) break;
    for (let p = 0; p < 3; p += 1) {
      for (let q = p + 1; q < 3; q += 1) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k += 1) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k += 1) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k += 1) {
          const vkp = vecs[k][p];
          const vkq = vecs[k][q];
          vecs[k][p] = c * vkp - s * vkq;
          vecs[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  return {
    values: order.map((i) => a[i][i]),
    vectors: order.map((i) => v(vecs[0][i], vecs[1][i], vecs[2][i]).normalize()),
  };
}

/** The point nearest to a set of lines (point + direction), weighted. */
function nearestToLines(lines: { point: V3; dir: V3; weight: number }[]): V3 | null {
  const m = new THREE.Matrix3();
  const sum = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const rhs = v();
  for (const { point, dir, weight } of lines) {
    // (I - d dᵀ)
    const e = [1 - dir.x * dir.x, -dir.x * dir.y, -dir.x * dir.z, -dir.y * dir.x, 1 - dir.y * dir.y, -dir.y * dir.z, -dir.z * dir.x, -dir.z * dir.y, 1 - dir.z * dir.z];
    for (let k = 0; k < 9; k += 1) sum[k] += e[k] * weight;
    rhs.x += (e[0] * point.x + e[1] * point.y + e[2] * point.z) * weight;
    rhs.y += (e[3] * point.x + e[4] * point.y + e[5] * point.z) * weight;
    rhs.z += (e[6] * point.x + e[7] * point.y + e[8] * point.z) * weight;
  }
  m.set(sum[0], sum[1], sum[2], sum[3], sum[4], sum[5], sum[6], sum[7], sum[8]);
  if (Math.abs(m.determinant()) < 1e-18) return null;
  return rhs.applyMatrix3(m.invert());
}

/** Circle through 2D points, least squares (Kåsa). */
function fitCircle2(points: [number, number][]): { x: number; y: number; r: number } | null {
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let sxz = 0;
  let syz = 0;
  const n = points.length;
  for (const [x, y] of points) {
    const z = x * x + y * y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sx += x;
    sy += y;
    sz += z;
    sxz += x * z;
    syz += y * z;
  }
  const m = new THREE.Matrix3().set(sxx, sxy, sx, sxy, syy, sy, sx, sy, n);
  if (Math.abs(m.determinant()) < 1e-24) return null;
  const solution = v(-sxz, -syz, -sz).applyMatrix3(m.invert());
  const cx = -solution.x / 2;
  const cy = -solution.y / 2;
  const r2 = cx * cx + cy * cy - solution.z;
  if (!(r2 > 0)) return null;
  return { x: cx, y: cy, r: Math.sqrt(r2) };
}

/** Two unit vectors at right angles to `axis`. */
function basisAround(axis: V3): [V3, V3] {
  const helper = Math.abs(axis.z) < 0.9 ? v(0, 0, 1) : v(1, 0, 0);
  const u = helper.clone().cross(axis).normalize();
  const w = axis.clone().cross(u).normalize();
  return [u, w];
}

export function surfaceOf(topology: Topology, face: number): Surface {
  const cached = topology.surfaces[face];
  if (cached) return cached;
  const surface = recogniseSurface(topology, face);
  topology.surfaces[face] = surface;
  return surface;
}

function recogniseSurface(topology: Topology, face: number): Surface {
  const geometry = topology.part.mesh.geometry;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const index = geometry.getIndex();
  const vertexOf = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);
  const a = v();
  const b = v();
  const c = v();
  const tris: { n: V3; area: number; centroid: V3 }[] = [];
  let area = 0;
  for (const t of topology.faceTriangles[face]) {
    a.fromBufferAttribute(position, vertexOf(t, 0));
    b.fromBufferAttribute(position, vertexOf(t, 1));
    c.fromBufferAttribute(position, vertexOf(t, 2));
    const cross = b.clone().sub(a).cross(c.clone().sub(a));
    const twice = cross.length();
    if (twice < 1e-20) continue;
    tris.push({ n: cross.divideScalar(twice), area: twice / 2, centroid: a.clone().add(b).add(c).divideScalar(3) });
    area += twice / 2;
  }
  if (tris.length === 0) return { type: 'surface', area };
  const pts = topology.faceVertices[face].map((id) => v(topology.points[id * 3], topology.points[id * 3 + 1], topology.points[id * 3 + 2]));

  // Plane: every triangle faces the same way.
  const mean = v();
  const centroid = v();
  for (const tri of tris) {
    mean.addScaledVector(tri.n, tri.area);
    centroid.addScaledVector(tri.centroid, tri.area);
  }
  centroid.divideScalar(area || 1);
  const meanLength = mean.length();
  if (meanLength > 0) {
    mean.divideScalar(meanLength);
    const flat = Math.cos(THREE.MathUtils.degToRad(1));
    if (tris.every((tri) => tri.n.dot(mean) > flat)) return { type: 'plane', normal: mean, point: centroid, area };
  }

  // Cylinder or cone: the normals are all square to one direction (cylinder)
  // or make one angle with it (cone).
  const moment = (centered: boolean) => {
    const m = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const avg = centered ? mean.clone().multiplyScalar(meanLength / (area || 1)) : v();
    for (const tri of tris) {
      const n = tri.n.clone().sub(avg);
      const e = [n.x, n.y, n.z];
      for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) m[i][j] += e[i] * e[j] * tri.area;
    }
    return eigen3(m);
  };
  const revolved = (axis: V3): Surface | null => {
    const lines = tris.map((tri) => {
      const radial = tri.n.clone().addScaledVector(axis, -tri.n.dot(axis));
      return { point: tri.centroid, dir: radial.lengthSq() > 1e-12 ? radial.normalize() : radial, weight: tri.area };
    });
    const onAxis = nearestToLines(lines.filter((line) => line.dir.lengthSq() > 0.5));
    if (!onAxis) return null;
    const radii: number[] = [];
    const along: number[] = [];
    for (const p of pts) {
      const d = p.clone().sub(onAxis);
      const t = d.dot(axis);
      along.push(t);
      radii.push(d.addScaledVector(axis, -t).length());
    }
    const tMin = Math.min(...along);
    const tMax = Math.max(...along);
    const center = onAxis.clone().addScaledVector(axis, (tMin + tMax) / 2);
    const rMean = radii.reduce((s, r) => s + r, 0) / radii.length;
    if (!(rMean > 0)) return null;
    let toward = 0;
    for (const tri of tris) {
      const d = tri.centroid.clone().sub(onAxis);
      d.addScaledVector(axis, -d.dot(axis));
      toward += tri.n.dot(d) * tri.area;
    }
    const spread = Math.max(...radii) - Math.min(...radii);
    if (spread <= Math.max(0.02 * rMean, topology.span * 1e-6)) {
      return { type: 'cylinder', axis, center, radius: rMean, length: tMax - tMin, hole: toward < 0, area };
    }
    // Radius changing evenly along the axis: a cone.
    let st = 0;
    let sr = 0;
    let stt = 0;
    let str = 0;
    for (let k = 0; k < radii.length; k += 1) {
      st += along[k];
      sr += radii[k];
      stt += along[k] * along[k];
      str += along[k] * radii[k];
    }
    const n = radii.length;
    const slope = (n * str - st * sr) / (n * stt - st * st || 1);
    const intercept = (sr - slope * st) / n;
    const worst = Math.max(...radii.map((r, k) => Math.abs(r - (intercept + slope * along[k]))));
    if (worst <= 0.02 * rMean && Math.abs(slope) > 1e-3) {
      return {
        type: 'cone',
        axis,
        center,
        halfAngle: Math.atan(Math.abs(slope)),
        rMin: Math.min(...radii),
        rMax: Math.max(...radii),
        length: tMax - tMin,
        area,
      };
    }
    return null;
  };

  const raw = moment(false);
  if (raw.values[0] / (area || 1) < 2e-3 && raw.values[1] > 3 * raw.values[0]) {
    const found = revolved(raw.vectors[0]);
    if (found) return found;
  }
  const centered = moment(true);
  if (centered.values[0] / (area || 1) < 2e-3 && centered.values[1] > 3 * centered.values[0]) {
    const found = revolved(centered.vectors[0]);
    if (found) return found;
  }

  // Sphere: every normal passes through one point.
  const center = nearestToLines(tris.map((tri) => ({ point: tri.centroid, dir: tri.n, weight: tri.area })));
  if (center) {
    const radii = pts.map((p) => p.distanceTo(center));
    const r = radii.reduce((s, x) => s + x, 0) / radii.length;
    if (r > 0 && Math.max(...radii) - Math.min(...radii) <= 0.02 * r) return { type: 'sphere', center, radius: r, area };
  }
  return { type: 'surface', area };
}

export function curveOf(topology: Topology, edge: number): Curve {
  const cached = topology.curves[edge];
  if (cached) return cached;
  const curve = recogniseCurve(edgePoints(topology, edge), topology.edges[edge].closed, topology.span);
  topology.curves[edge] = curve;
  return curve;
}

export function edgePoints(topology: Topology, edge: number): V3[] {
  return topology.edges[edge].vertices.map((id) => v(topology.points[id * 3], topology.points[id * 3 + 1], topology.points[id * 3 + 2]));
}

function recogniseCurve(points: V3[], closed: boolean, span: number): Curve {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) length += points[i].distanceTo(points[i - 1]);
  const first = points[0];
  const last = points[points.length - 1];
  if (!closed) {
    const chord = last.clone().sub(first);
    const chordLength = chord.length();
    if (chordLength > 0) {
      chord.divideScalar(chordLength);
      const deviation = Math.max(...points.map((p) => p.clone().sub(first).cross(chord).length()));
      if (deviation <= Math.max(1e-4 * chordLength, span * 1e-7)) return { type: 'line', a: first, b: last, length: chordLength };
    }
  }
  if (points.length >= 4) {
    const centroid = points.reduce((s, p) => s.add(p), v()).divideScalar(points.length);
    const m = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (const p of points) {
      const d = [p.x - centroid.x, p.y - centroid.y, p.z - centroid.z];
      for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) m[i][j] += d[i] * d[j];
    }
    const { vectors } = eigen3(m);
    const normal = vectors[0];
    const planar = Math.max(...points.map((p) => Math.abs(p.clone().sub(centroid).dot(normal)))) <= Math.max(1e-3 * length, span * 1e-7);
    if (planar) {
      const [u, w] = basisAround(normal);
      const flat = points.map((p) => {
        const d = p.clone().sub(centroid);
        return [d.dot(u), d.dot(w)] as [number, number];
      });
      const circle = fitCircle2(flat);
      if (circle) {
        const worst = Math.max(...flat.map(([x, y]) => Math.abs(Math.hypot(x - circle.x, y - circle.y) - circle.r)));
        if (worst <= 0.01 * circle.r) {
          const center = centroid.clone().addScaledVector(u, circle.x).addScaledVector(w, circle.y);
          // Swept angle: sum of the turns between consecutive points.
          let swept = 0;
          for (let i = 1; i < flat.length; i += 1) {
            const a0 = Math.atan2(flat[i - 1][1] - circle.y, flat[i - 1][0] - circle.x);
            const a1 = Math.atan2(flat[i][1] - circle.y, flat[i][0] - circle.x);
            let d = a1 - a0;
            while (d > Math.PI) d -= 2 * Math.PI;
            while (d < -Math.PI) d += 2 * Math.PI;
            swept += d;
          }
          const angle = Math.min(Math.abs(swept), 2 * Math.PI);
          const full = closed || angle > 2 * Math.PI - 0.02;
          return { type: 'circle', center, normal, radius: circle.r, full, angle: full ? 2 * Math.PI : angle, length, a: first, b: last };
        }
      }
    }
  }
  return { type: 'curve', length, points };
}

/* --------------------------------- picking --------------------------------- */

/**
 * The face, edge or vertex under the cursor: the face hit, unless one of its
 * edges or their ends lies within a few pixels of the pointer.
 */
export function entityAt(
  part: CadPart,
  triangle: number,
  pointer: { x: number; y: number },
  toScreen: (world: V3) => { x: number; y: number },
): Entity | null {
  const topology = topologyOf(part);
  if (!topology) return null;
  const face = topology.triFace[triangle];
  if (face === undefined || face < 0) return null;
  const matrix = part.mesh.matrixWorld;

  let bestVertex: { id: number; distance: number } | null = null;
  let bestEdge: { id: number; distance: number } | null = null;
  for (const id of topology.faceEdges[face]) {
    const edge = topology.edges[id];
    const screen = edge.vertices.map((vertex) =>
      toScreen(v(topology.points[vertex * 3], topology.points[vertex * 3 + 1], topology.points[vertex * 3 + 2]).applyMatrix4(matrix)),
    );
    for (let i = 1; i < screen.length; i += 1) {
      const d = distanceToSegment(pointer, screen[i - 1], screen[i]);
      if (!bestEdge || d < bestEdge.distance) bestEdge = { id, distance: d };
    }
    if (!edge.closed) {
      for (const end of [0, edge.vertices.length - 1]) {
        const d = Math.hypot(screen[end].x - pointer.x, screen[end].y - pointer.y);
        if (!bestVertex || d < bestVertex.distance) bestVertex = { id: edge.vertices[end], distance: d };
      }
    }
  }
  if (bestVertex && bestVertex.distance < 7) {
    const id = bestVertex.id;
    return {
      kind: 'vertex',
      part,
      index: id,
      point: v(topology.points[id * 3], topology.points[id * 3 + 1], topology.points[id * 3 + 2]).applyMatrix4(matrix),
    };
  }
  if (bestEdge && bestEdge.distance < 6) return edgeEntity(topology, bestEdge.id);
  return faceEntity(topology, face);
}

function distanceToSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t = length2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Uniform scale of a world matrix (placements are rigid; this is 1 almost always). */
function scaleOf(matrix: THREE.Matrix4): number {
  return new THREE.Vector3().setFromMatrixScale(matrix).x || 1;
}

function faceEntity(topology: Topology, face: number): Entity {
  const matrix = topology.part.mesh.matrixWorld;
  const scale = scaleOf(matrix);
  const local = surfaceOf(topology, face);
  const point = (p: V3) => p.clone().applyMatrix4(matrix);
  const dir = (d: V3) => d.clone().transformDirection(matrix);
  const surface: Surface =
    local.type === 'plane'
      ? { ...local, normal: dir(local.normal), point: point(local.point), area: local.area * scale * scale }
      : local.type === 'cylinder'
        ? { ...local, axis: dir(local.axis), center: point(local.center), radius: local.radius * scale, length: local.length * scale, area: local.area * scale * scale }
        : local.type === 'cone'
          ? { ...local, axis: dir(local.axis), center: point(local.center), rMin: local.rMin * scale, rMax: local.rMax * scale, length: local.length * scale, area: local.area * scale * scale }
          : local.type === 'sphere'
            ? { ...local, center: point(local.center), radius: local.radius * scale, area: local.area * scale * scale }
            : { ...local, area: local.area * scale * scale };
  const ids = topology.faceVertices[face];
  const stride = Math.max(1, Math.ceil(ids.length / 1500));
  const points: V3[] = [];
  for (let i = 0; i < ids.length; i += stride) {
    const id = ids[i];
    points.push(v(topology.points[id * 3], topology.points[id * 3 + 1], topology.points[id * 3 + 2]).applyMatrix4(matrix));
  }
  let perimeter = 0;
  for (const edge of topology.faceEdges[face]) perimeter += curveOf(topology, edge).length * scale;
  return { kind: 'face', part: topology.part, index: face, surface, points, perimeter };
}

function edgeEntity(topology: Topology, edge: number): Entity {
  const matrix = topology.part.mesh.matrixWorld;
  const scale = scaleOf(matrix);
  const local = curveOf(topology, edge);
  const point = (p: V3) => p.clone().applyMatrix4(matrix);
  const curve: Curve =
    local.type === 'line'
      ? { type: 'line', a: point(local.a), b: point(local.b), length: local.length * scale }
      : local.type === 'circle'
        ? {
            ...local,
            center: point(local.center),
            normal: local.normal.clone().transformDirection(matrix),
            radius: local.radius * scale,
            length: local.length * scale,
            a: point(local.a),
            b: point(local.b),
          }
        : { type: 'curve', length: local.length * scale, points: local.points.map(point) };
  return { kind: 'edge', part: topology.part, index: edge, curve, points: edgePoints(topology, edge).map(point) };
}

/** A face or edge as an entity, without picking (for checks). */
export function entityOf(part: CadPart, kind: 'face' | 'edge', index: number): Entity | null {
  const topology = topologyOf(part);
  if (!topology) return null;
  return kind === 'face' ? faceEntity(topology, index) : edgeEntity(topology, index);
}

/** Local polyline of an edge, for highlighting it on its mesh. */
export function edgeLocalPoints(part: CadPart, edge: number): V3[] {
  const topology = topologyOf(part);
  return topology ? edgePoints(topology, edge) : [];
}

/** Triangles of a face, for highlighting it on its mesh. */
export function faceTriangleList(part: CadPart, face: number): number[] {
  return topologyOf(part)?.faceTriangles[face] ?? [];
}

export function sameEntity(a: Entity, b: Entity): boolean {
  return a.kind === b.kind && a.part.id === b.part.id && a.index === b.index;
}

/** What the selection chip calls an entity, and the size that names it. */
export function describe(entity: Entity): { type: string; size: number | null; sizeKind: 'diameter' | 'length' | null } {
  if (entity.kind === 'vertex') return { type: 'Vertex', size: null, sizeKind: null };
  if (entity.kind === 'edge') {
    const curve = entity.curve;
    if (curve.type === 'line') return { type: 'Straight edge', size: curve.length, sizeKind: 'length' };
    if (curve.type === 'circle') return { type: curve.full ? 'Circular edge' : 'Arc', size: curve.radius * 2, sizeKind: 'diameter' };
    return { type: 'Curved edge', size: curve.length, sizeKind: 'length' };
  }
  const surface = entity.surface;
  if (surface.type === 'plane') return { type: 'Plane', size: null, sizeKind: null };
  if (surface.type === 'cylinder') return { type: surface.hole ? 'Hole' : 'Cylinder', size: surface.radius * 2, sizeKind: 'diameter' };
  if (surface.type === 'cone') return { type: 'Cone', size: null, sizeKind: null };
  if (surface.type === 'sphere') return { type: 'Sphere', size: surface.radius * 2, sizeKind: 'diameter' };
  return { type: 'Curved surface', size: null, sizeKind: null };
}

/* ------------------------------- dimensions -------------------------------- */

interface Round {
  center: V3;
  /** Null for a sphere. */
  axis: V3 | null;
  radius: number;
  /** Half its length along the axis (0 for a circle). */
  half: number;
}

function roundOf(entity: Entity): Round | null {
  if (entity.kind === 'face') {
    const s = entity.surface;
    if (s.type === 'cylinder') return { center: s.center, axis: s.axis, radius: s.radius, half: s.length / 2 };
    if (s.type === 'sphere') return { center: s.center, axis: null, radius: s.radius, half: 0 };
  }
  if (entity.kind === 'edge' && entity.curve.type === 'circle') {
    return { center: entity.curve.center, axis: entity.curve.normal, radius: entity.curve.radius, half: 0 };
  }
  return null;
}

function flatOf(entity: Entity): { point: V3; normal: V3 } | null {
  if (entity.kind === 'face' && entity.surface.type === 'plane') return { point: entity.surface.point, normal: entity.surface.normal };
  return null;
}

function lineOf(entity: Entity): { a: V3; b: V3; dir: V3 } | null {
  if (entity.kind === 'edge' && entity.curve.type === 'line') {
    const dir = entity.curve.b.clone().sub(entity.curve.a).normalize();
    return { a: entity.curve.a, b: entity.curve.b, dir };
  }
  return null;
}

function pointsOf(entity: Entity): V3[] {
  return entity.kind === 'vertex' ? [entity.point] : entity.points;
}

function centreOf(entity: Entity): V3 {
  const round = roundOf(entity);
  if (round) return round.center;
  if (entity.kind === 'vertex') return entity.point;
  if (entity.kind === 'face' && entity.surface.type === 'plane') return entity.surface.point;
  const pts = pointsOf(entity);
  return pts.reduce((s, p) => s.add(p), v()).divideScalar(pts.length || 1);
}

const PARALLEL = Math.cos(THREE.MathUtils.degToRad(0.5));
const mid = (a: V3, b: V3) => a.clone().add(b).multiplyScalar(0.5);

function distanceOption(key: string, label: string, a: V3, b: V3): MeasureOption {
  return { key, label, kind: 'distance', value: a.distanceTo(b), a: a.clone(), b: b.clone(), labelAt: mid(a, b) };
}

/** Closest pair between two point sets (sampled geometry). */
function closestPair(first: V3[], second: V3[]): [V3, V3] {
  let best = Infinity;
  let pair: [V3, V3] = [first[0], second[0]];
  for (const p of first) {
    for (const q of second) {
      const d = p.distanceToSquared(q);
      if (d < best) {
        best = d;
        pair = [p, q];
      }
    }
  }
  return pair;
}

/** A direction square to `axis`, as square to the view as possible, for drawing diameters. */
function across(axis: V3 | null, view: V3): V3 {
  if (!axis) return basisAround(view)[0];
  const w = axis.clone().cross(view);
  if (w.lengthSq() < 1e-8) return basisAround(axis)[0];
  return w.normalize();
}

/** Dimensions of a single entity. */
function singleOptions(entity: Entity, view: V3): MeasureOption[] {
  if (entity.kind === 'vertex') {
    return [{ key: 'coords', label: 'Coordinates', kind: 'coords', value: 0, point: entity.point.clone(), labelAt: entity.point.clone() }];
  }
  if (entity.kind === 'edge') {
    const curve = entity.curve;
    if (curve.type === 'line') return [distanceOption('length', 'Length', curve.a, curve.b)].map((o) => ({ ...o, kind: 'length' as const }));
    if (curve.type === 'circle') {
      const w = across(curve.normal, view);
      const a = curve.center.clone().addScaledVector(w, -curve.radius);
      const b = curve.center.clone().addScaledVector(w, curve.radius);
      const circle = { center: curve.center, normal: curve.normal, radius: curve.radius };
      const options: MeasureOption[] = [
        { key: 'diameter', label: 'Diameter', kind: 'diameter', value: curve.radius * 2, a, b, circle, labelAt: b.clone() },
        { key: 'radius', label: 'Radius', kind: 'radius', value: curve.radius, a: curve.center.clone(), b, circle, labelAt: mid(curve.center, b) },
      ];
      if (!curve.full) {
        options.push(
          { key: 'arc-length', label: 'Arc length', kind: 'length', value: curve.length, circle, labelAt: mid(curve.a, curve.b) },
          {
            key: 'arc-angle',
            label: 'Arc angle',
            kind: 'angle',
            value: THREE.MathUtils.radToDeg(curve.angle),
            arc: {
              center: curve.center.clone(),
              from: curve.a.clone().sub(curve.center).normalize(),
              to: curve.b.clone().sub(curve.center).normalize(),
              radius: curve.radius * 0.6,
            },
            labelAt: curve.center.clone(),
          },
          distanceOption('chord', 'Chord', curve.a, curve.b),
        );
      }
      return options;
    }
    const pts = curve.points;
    return [{ key: 'length', label: 'Length', kind: 'length', value: curve.length, labelAt: pts[Math.floor(pts.length / 2)].clone() }];
  }
  const s = entity.surface;
  const area: MeasureOption = { key: 'area', label: 'Face area', kind: 'area', value: s.area, labelAt: centreOf(entity).clone() };
  if (s.type === 'cylinder') {
    const w = across(s.axis, view);
    const a = s.center.clone().addScaledVector(w, -s.radius);
    const b = s.center.clone().addScaledVector(w, s.radius);
    const circle = { center: s.center, normal: s.axis, radius: s.radius };
    const end1 = s.center.clone().addScaledVector(s.axis, -s.length / 2).addScaledVector(w, s.radius);
    const end2 = s.center.clone().addScaledVector(s.axis, s.length / 2).addScaledVector(w, s.radius);
    return [
      { key: 'diameter', label: 'Diameter', kind: 'diameter', value: s.radius * 2, a, b, circle, labelAt: b.clone() },
      { key: 'radius', label: 'Radius', kind: 'radius', value: s.radius, a: s.center.clone(), b, circle, labelAt: mid(s.center, b) },
      { ...distanceOption('length', 'Length along the axis', end1, end2), kind: 'length' },
      area,
    ];
  }
  if (s.type === 'cone') {
    const w = across(s.axis, view);
    const end1 = s.center.clone().addScaledVector(s.axis, -s.length / 2);
    const end2 = s.center.clone().addScaledVector(s.axis, s.length / 2);
    return [
      {
        key: 'cone-angle',
        label: 'Cone angle',
        kind: 'angle',
        value: THREE.MathUtils.radToDeg(2 * s.halfAngle),
        arc: { center: s.center.clone(), from: w.clone(), to: w.clone().applyAxisAngle(s.axis.clone().cross(w).normalize(), 2 * s.halfAngle), radius: s.rMax },
        labelAt: s.center.clone(),
      },
      { key: 'large-diameter', label: 'Large diameter', kind: 'diameter', value: s.rMax * 2, labelAt: s.center.clone() },
      { key: 'small-diameter', label: 'Small diameter', kind: 'diameter', value: s.rMin * 2, labelAt: s.center.clone() },
      { ...distanceOption('length', 'Length along the axis', end1, end2), kind: 'length' },
      area,
    ];
  }
  if (s.type === 'sphere') {
    const w = across(null, view);
    const a = s.center.clone().addScaledVector(w, -s.radius);
    const b = s.center.clone().addScaledVector(w, s.radius);
    const circle = { center: s.center, normal: view.clone(), radius: s.radius };
    return [
      { key: 'diameter', label: 'Diameter', kind: 'diameter', value: s.radius * 2, a, b, circle, labelAt: b.clone() },
      { key: 'radius', label: 'Radius', kind: 'radius', value: s.radius, a: s.center.clone(), b, circle, labelAt: mid(s.center, b) },
      area,
    ];
  }
  const options = [area];
  if (entity.perimeter > 0) options.push({ key: 'perimeter', label: 'Perimeter', kind: 'length', value: entity.perimeter, labelAt: area.labelAt });
  return options;
}

/** Foot of a point on a plane. */
function onPlane(p: V3, plane: { point: V3; normal: V3 }): V3 {
  return p.clone().addScaledVector(plane.normal, -p.clone().sub(plane.point).dot(plane.normal));
}

/** Foot of a point on an infinite line. */
function onLine(p: V3, point: V3, dir: V3): V3 {
  return point.clone().addScaledVector(dir, p.clone().sub(point).dot(dir));
}

function angleOption(key: string, label: string, degrees: number, center: V3, from: V3, to: V3, radius: number): MeasureOption {
  return { key, label, kind: 'angle', value: degrees, arc: { center: center.clone(), from: from.clone().normalize(), to: to.clone().normalize(), radius }, labelAt: center.clone() };
}

/** Dimensions between two entities, the most likely first. */
function pairOptions(first: Entity, second: Entity, view: V3, span: number): MeasureOption[] {
  const options: MeasureOption[] = [];
  const r1 = roundOf(first);
  const r2 = roundOf(second);
  const f1 = flatOf(first);
  const f2 = flatOf(second);
  const l1 = lineOf(first);
  const l2 = lineOf(second);
  const p1 = first.kind === 'vertex' ? first.point : null;
  const p2 = second.kind === 'vertex' ? second.point : null;
  const tiny = span * 1e-6;

  /* round and round: holes, bosses, circles, spheres */
  if (r1 && r2) {
    if (r1.axis && r2.axis && Math.abs(r1.axis.dot(r2.axis)) > PARALLEL) {
      const axis = r1.axis;
      const c1 = r1.center;
      // Second axis at the first one's station along the axis.
      const c2 = r2.center.clone().addScaledVector(axis, c1.clone().sub(r2.center).dot(axis));
      const offset = c2.clone().sub(c1);
      const d = offset.length();
      if (d < Math.max(tiny, 1e-3 * Math.min(r1.radius, r2.radius))) {
        // Coaxial.
        if (Math.abs(r1.radius - r2.radius) > tiny) {
          const w = across(axis, view);
          options.push(
            distanceOption('radial-gap', 'Radial gap (wall)', c1.clone().addScaledVector(w, r1.radius), c1.clone().addScaledVector(w, r2.radius)),
          );
        }
        const axial = r2.center.clone().sub(r1.center).dot(axis);
        if (Math.abs(axial) > tiny) {
          options.push(distanceOption('axial', 'Distance along the axis', r1.center, r1.center.clone().addScaledVector(axis, axial)));
        }
      } else {
        const u = offset.clone().divideScalar(d);
        const near1 = c1.clone().addScaledVector(u, r1.radius);
        const far1 = c1.clone().addScaledVector(u, -r1.radius);
        const near2 = c2.clone().addScaledVector(u, -r2.radius);
        const far2 = c2.clone().addScaledVector(u, r2.radius);
        options.push(distanceOption('center-center', 'Centre to centre', c1, c2));
        if (d - r1.radius - r2.radius > tiny) options.push(distanceOption('near-near', 'Minimum (near sides)', near1, near2));
        options.push(distanceOption('far-far', 'Maximum (far sides)', far1, far2));
        if (d - r1.radius > tiny) options.push(distanceOption('near-center', 'Near side of the first ↔ centre of the second', near1, c2));
        if (d - r2.radius > tiny) options.push(distanceOption('center-near', 'Centre of the first ↔ near side of the second', c1, near2));
      }
      return options;
    }
    // Spheres, or axes at an angle.
    const c1 = r1.center;
    const c2 = r2.center;
    const d = c1.distanceTo(c2);
    options.push(distanceOption('center-center', 'Centre to centre', c1, c2));
    if (!r1.axis && !r2.axis && d > 0) {
      const u = c2.clone().sub(c1).divideScalar(d);
      if (d - r1.radius - r2.radius > tiny) {
        options.push(distanceOption('near-near', 'Minimum (near sides)', c1.clone().addScaledVector(u, r1.radius), c2.clone().addScaledVector(u, -r2.radius)));
      }
      options.push(distanceOption('far-far', 'Maximum (far sides)', c1.clone().addScaledVector(u, -r1.radius), c2.clone().addScaledVector(u, r2.radius)));
    }
    if (r1.axis && r2.axis) {
      const angle = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(r1.axis.dot(r2.axis)))));
      options.push(angleOption('axes-angle', 'Angle between axes', angle, c1, r1.axis, r1.axis.dot(r2.axis) < 0 ? r2.axis.clone().negate() : r2.axis, Math.max(r1.radius, r2.radius) * 1.5));
    }
    return options;
  }

  /* round and plane */
  if ((r1 && f2) || (r2 && f1)) {
    const round = (r1 ?? r2) as Round;
    const plane = (f1 ?? f2) as { point: V3; normal: V3 };
    const signed = round.center.clone().sub(plane.point).dot(plane.normal);
    const toward = plane.normal.clone().multiplyScalar(-Math.sign(signed) || -1);
    const tilt = round.axis ? Math.abs(round.axis.dot(plane.normal)) : 0;
    const extent = round.axis ? round.radius * Math.sqrt(Math.max(0, 1 - tilt * tilt)) + round.half * tilt : round.radius;
    const centreFoot = onPlane(round.center, plane);
    if (round.axis && round.half > 0 && tilt > PARALLEL) {
      // A shaft or hole standing on the plane: its ends, not its sides.
      const toPlane = round.axis.clone().multiplyScalar(Math.sign(round.axis.dot(toward)) || 1);
      const nearEnd = round.center.clone().addScaledVector(toPlane, round.half);
      const farEnd = round.center.clone().addScaledVector(toPlane, -round.half);
      if (Math.abs(signed) - round.half > tiny) options.push(distanceOption('near-end-plane', 'Near end to plane', nearEnd, onPlane(nearEnd, plane)));
      options.push(distanceOption('far-end-plane', 'Far end to plane', farEnd, onPlane(farEnd, plane)));
      options.push(distanceOption('center-plane', 'Middle to plane', round.center, centreFoot));
      return options;
    }
    if (!round.axis || tilt < 0.02 || round.half === 0) {
      options.push(distanceOption('center-plane', 'Centre to plane', round.center, centreFoot));
    }
    if (Math.abs(signed) - extent > tiny) {
      const near = round.center.clone().addScaledVector(toward, extent);
      options.push(distanceOption('near-plane', 'Near side to plane (tangent)', near, onPlane(near, plane)));
    }
    const far = round.center.clone().addScaledVector(toward, -extent);
    options.push(distanceOption('far-plane', 'Far side to plane (tangent)', far, onPlane(far, plane)));
    if (round.axis && tilt > 0.02 && tilt < PARALLEL) {
      const angle = 90 - THREE.MathUtils.radToDeg(Math.acos(Math.min(1, tilt)));
      options.push(angleOption('axis-plane-angle', 'Angle between axis and plane', angle, centreFoot, onPlane(round.center.clone().add(round.axis), plane).sub(centreFoot), round.axis, round.radius * 2));
    }
    return options;
  }

  /* round and straight edge */
  if ((r1 && l2) || (r2 && l1)) {
    const round = (r1 ?? r2) as Round;
    const line = (l1 ?? l2) as { a: V3; b: V3; dir: V3 };
    const foot = onLine(round.center, line.a, line.dir);
    const d = round.center.distanceTo(foot);
    if (round.axis && Math.abs(round.axis.dot(line.dir)) > PARALLEL && d > tiny) {
      const u = foot.clone().sub(round.center).divideScalar(d);
      options.push(distanceOption('center-line', 'Centre to edge', round.center, foot));
      if (d - round.radius > tiny) options.push(distanceOption('near-line', 'Near side to edge (tangent)', round.center.clone().addScaledVector(u, round.radius), foot));
      options.push(distanceOption('far-line', 'Far side to edge (tangent)', round.center.clone().addScaledVector(u, -round.radius), foot));
      return options;
    }
    options.push(distanceOption('center-line', 'Centre to edge', round.center, foot));
  }

  /* round and point */
  if ((r1 && p2) || (r2 && p1)) {
    const round = (r1 ?? r2) as Round;
    const point = (p1 ?? p2) as V3;
    const centre = round.axis ? onLine(point, round.center, round.axis) : round.center;
    const d = centre.distanceTo(point);
    options.push(distanceOption('center-point', round.axis ? 'Axis to point' : 'Centre to point', centre, point));
    if (d > tiny) {
      const u = point.clone().sub(centre).divideScalar(d);
      if (d - round.radius > tiny) options.push(distanceOption('near-point', 'Near side to point', centre.clone().addScaledVector(u, round.radius), point));
      options.push(distanceOption('far-point', 'Far side to point', centre.clone().addScaledVector(u, -round.radius), point));
    }
    return options;
  }

  /* plane and plane */
  if (f1 && f2) {
    const dot = f1.normal.dot(f2.normal);
    if (Math.abs(dot) > PARALLEL) {
      const foot = onPlane(f1.point, f2);
      options.push(distanceOption('plane-plane', 'Distance between planes', f1.point, foot));
    } else {
      const angle = THREE.MathUtils.radToDeg(Math.acos(Math.max(-1, Math.min(1, dot))));
      const centre = mid(f1.point, f2.point);
      // Between the faces as solids meet: 180° minus the angle of their normals.
      options.push(angleOption('angle', 'Angle', 180 - angle, centre, f1.normal.clone().negate(), f2.normal.clone().negate(), span * 0.08));
      options.push(angleOption('angle-normals', 'Angle between normals', angle, centre, f1.normal, f2.normal, span * 0.08));
    }
  }

  /* plane and straight edge */
  if ((f1 && l2) || (f2 && l1)) {
    const plane = (f1 ?? f2) as { point: V3; normal: V3 };
    const line = (l1 ?? l2) as { a: V3; b: V3; dir: V3 };
    const tilt = Math.abs(line.dir.dot(plane.normal));
    const middle = mid(line.a, line.b);
    if (tilt < 1 - PARALLEL + 0.0087) options.push(distanceOption('line-plane', 'Edge to plane', middle, onPlane(middle, plane)));
    else {
      const angle = THREE.MathUtils.radToDeg(Math.asin(Math.min(1, tilt)));
      const foot = onPlane(middle, plane);
      options.push(angleOption('line-plane-angle', 'Angle between edge and plane', angle, foot, onPlane(middle.clone().add(line.dir), plane).sub(foot), line.dir, line.a.distanceTo(line.b) / 2));
      options.push(distanceOption('ends-plane', 'Nearer end to plane', ...nearerEnd(line, plane)));
    }
  }

  /* plane and point */
  if ((f1 && p2) || (f2 && p1)) {
    const plane = (f1 ?? f2) as { point: V3; normal: V3 };
    const point = (p1 ?? p2) as V3;
    options.push(distanceOption('point-plane', 'Point to plane', point, onPlane(point, plane)));
  }

  /* straight edges */
  if (l1 && l2) {
    const dot = l1.dir.dot(l2.dir);
    if (Math.abs(dot) > PARALLEL) {
      const middle = mid(l1.a, l1.b);
      options.push(distanceOption('line-line', 'Distance between edges', middle, onLine(middle, l2.a, l2.dir)));
    } else {
      const angle = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(dot))));
      const [pa, pb] = closestOnLines(l1, l2);
      options.push(angleOption('angle', 'Angle', angle, pa, l1.dir, dot < 0 ? l2.dir.clone().negate() : l2.dir, Math.min(l1.a.distanceTo(l1.b), l2.a.distanceTo(l2.b)) / 2));
      if (pa.distanceTo(pb) > tiny) options.push(distanceOption('skew', 'Shortest distance between the lines', pa, pb));
    }
  }

  /* straight edge and point */
  if ((l1 && p2) || (l2 && p1)) {
    const line = (l1 ?? l2) as { a: V3; b: V3; dir: V3 };
    const point = (p1 ?? p2) as V3;
    options.push(distanceOption('point-line', 'Point to edge (square to it)', point, onLine(point, line.a, line.dir)));
  }

  /* two points */
  if (p1 && p2) {
    options.push(distanceOption('point-point', 'Distance', p1, p2));
    const axes: [string, V3][] = [
      ['ΔX', v(1, 0, 0)],
      ['ΔY', v(0, 1, 0)],
      ['ΔZ', v(0, 0, 1)],
    ];
    for (const [name, axis] of axes) {
      const delta = p2.clone().sub(p1).dot(axis);
      if (Math.abs(delta) > tiny) options.push({ ...distanceOption(name, name, p1, p1.clone().addScaledVector(axis, delta)) });
    }
  }

  /* a curved surface and a plane: the points where it touches planes parallel to it */
  for (const [curved, other] of [
    [first, second],
    [second, first],
  ] as const) {
    if (curved.kind !== 'face' || curved.surface.type !== 'surface' && curved.surface.type !== 'cone') continue;
    const plane = flatOf(other);
    if (plane) {
      let nearest = curved.points[0];
      let farthest = curved.points[0];
      let low = Infinity;
      let high = -Infinity;
      for (const p of curved.points) {
        const d = Math.abs(p.clone().sub(plane.point).dot(plane.normal));
        if (d < low) {
          low = d;
          nearest = p;
        }
        if (d > high) {
          high = d;
          farthest = p;
        }
      }
      options.push(distanceOption('tangent-near', 'Nearest point to plane (tangent)', nearest, onPlane(nearest, plane)));
      options.push(distanceOption('tangent-far', 'Farthest point to plane (tangent)', farthest, onPlane(farthest, plane)));
    }
    const point = other.kind === 'vertex' ? other.point : null;
    if (point) {
      const [near] = closestPair(curved.points, [point]);
      options.push(distanceOption('surface-point', 'Point to nearest point of the surface', near, point));
    }
  }

  // Always available: the shortest distance between the two, and between their centres.
  const [pa, pb] = closestPair(pointsOf(first), pointsOf(second));
  if (pa.distanceTo(pb) > tiny && !options.some((o) => o.kind === 'distance' && Math.abs(o.value - pa.distanceTo(pb)) < tiny * 10)) {
    options.push(distanceOption('minimum', 'Minimum distance', pa, pb));
  }
  const ca = centreOf(first);
  const cb = centreOf(second);
  const repeats = (value: number) => options.some((o) => o.kind === 'distance' && Math.abs(o.value - value) < Math.max(tiny * 10, value * 1e-6));
  if (ca.distanceTo(cb) > tiny && !options.some((o) => o.key === 'center-center') && !repeats(ca.distanceTo(cb))) {
    options.push(distanceOption('center-center', 'Centre to centre', ca, cb));
  }
  return options;
}

function nearerEnd(line: { a: V3; b: V3 }, plane: { point: V3; normal: V3 }): [V3, V3] {
  const da = Math.abs(line.a.clone().sub(plane.point).dot(plane.normal));
  const db = Math.abs(line.b.clone().sub(plane.point).dot(plane.normal));
  const end = da <= db ? line.a : line.b;
  return [end, onPlane(end, plane)];
}

/** Closest points of two infinite lines. */
function closestOnLines(l1: { a: V3; dir: V3 }, l2: { a: V3; dir: V3 }): [V3, V3] {
  const w = l1.a.clone().sub(l2.a);
  const b = l1.dir.dot(l2.dir);
  const d = l1.dir.dot(w);
  const e = l2.dir.dot(w);
  const denominator = 1 - b * b;
  if (Math.abs(denominator) < 1e-12) return [l1.a.clone(), onLine(l1.a, l2.a, l2.dir)];
  const s = (b * e - d) / denominator;
  const t = (e - b * d) / denominator;
  return [l1.a.clone().addScaledVector(l1.dir, s), l2.a.clone().addScaledVector(l2.dir, t)];
}

/**
 * Every dimension the selection offers, the most likely first. `view` is the
 * camera's looking direction, so diameters are drawn across the screen.
 */
export function measureOptions(selection: Entity[], view: V3, span: number): MeasureOption[] {
  const options =
    selection.length === 1 ? singleOptions(selection[0], view) : selection.length === 2 ? pairOptions(selection[0], selection[1], view, span) : [];
  // The same line twice under two names (a circle parallel to a plane has no near or far side) is one dimension.
  const tolerance = span * 1e-6;
  const same = (p: V3 | undefined, q: V3 | undefined) => (p && q ? p.distanceTo(q) <= tolerance : p === q);
  return options.filter(
    (option, k) =>
      !option.a ||
      !option.b ||
      !options
        .slice(0, k)
        .some((earlier) => earlier.kind === option.kind && ((same(earlier.a, option.a) && same(earlier.b, option.b)) || (same(earlier.a, option.b) && same(earlier.b, option.a)))),
  );
}
