import * as THREE from 'three';

/**
 * Geometry maths for the analysis tools.
 *
 * Everything here works on the tessellated triangles the viewer already has —
 * no CAD kernel in the browser. Where that makes a result approximate (an open
 * mesh has no well-defined volume), the caller is told so it can say `≈` rather
 * than pretend.
 */

export interface VolumeResult {
  volume: number;
  /** The mesh had boundary edges, so the value is an estimate. */
  approximate: boolean;
}

/** Signed volume via the divergence theorem over triangles. */
export function computeVolume(geometry: THREE.BufferGeometry): VolumeResult {
  const position = geometry.getAttribute('position');
  if (!position) return { volume: 0, approximate: true };
  const index = geometry.getIndex();
  const triangleCount = index ? index.count / 3 : position.count / 3;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let total = 0;

  for (let t = 0; t < triangleCount; t += 1) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(position, i0);
    b.fromBufferAttribute(position, i1);
    c.fromBufferAttribute(position, i2);
    total += a.dot(b.clone().cross(c)) / 6;
  }

  return { volume: Math.abs(total), approximate: !isClosed(geometry) };
}

export function computeSurfaceArea(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute('position');
  if (!position) return 0;
  const index = geometry.getIndex();
  const triangleCount = index ? index.count / 3 : position.count / 3;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  let area = 0;

  for (let t = 0; t < triangleCount; t += 1) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(position, i0);
    b.fromBufferAttribute(position, i1);
    c.fromBufferAttribute(position, i2);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    area += ab.cross(ac).length() / 2;
  }
  return area;
}

const CLOSED_CACHE = new WeakMap<THREE.BufferGeometry, boolean>();
/** Above this size the manifold check costs more than the answer is worth. */
const CLOSED_CHECK_LIMIT = 600_000;

/**
 * A mesh is closed when every edge is shared by exactly two triangles.
 * Positions are quantised before hashing so that meshes with duplicated
 * vertices (very common in STL) are not reported as full of holes.
 */
export function isClosed(geometry: THREE.BufferGeometry): boolean {
  const cached = CLOSED_CACHE.get(geometry);
  if (cached !== undefined) return cached;

  const position = geometry.getAttribute('position');
  if (!position) return false;
  const index = geometry.getIndex();
  const triangleCount = index ? index.count / 3 : position.count / 3;
  if (triangleCount > CLOSED_CHECK_LIMIT) {
    CLOSED_CACHE.set(geometry, false);
    return false;
  }

  geometry.computeBoundingBox();
  const size = geometry.boundingBox?.getSize(new THREE.Vector3()) ?? new THREE.Vector3(1, 1, 1);
  const scale = Math.max(size.x, size.y, size.z) || 1;
  const quantum = scale * 1e-6;

  const key = (i: number): string => {
    const x = Math.round(position.getX(i) / quantum);
    const y = Math.round(position.getY(i) / quantum);
    const z = Math.round(position.getZ(i) / quantum);
    return `${x},${y},${z}`;
  };

  const counts = new Map<string, number>();
  const bump = (ka: string, kb: string) => {
    const edge = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    counts.set(edge, (counts.get(edge) ?? 0) + 1);
  };

  for (let t = 0; t < triangleCount; t += 1) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const k0 = key(i0);
    const k1 = key(i1);
    const k2 = key(i2);
    bump(k0, k1);
    bump(k1, k2);
    bump(k2, k0);
  }

  let closed = true;
  for (const count of counts.values()) {
    if (count !== 2) {
      closed = false;
      break;
    }
  }
  CLOSED_CACHE.set(geometry, closed);
  return closed;
}

/* --------------------------- feature edge picking -------------------------- */

export interface EdgeSegment {
  start: THREE.Vector3;
  end: THREE.Vector3;
}

interface EdgeIndexEntry {
  a: number;
  b: number;
  /** Normals of the (up to two) triangles sharing this edge. */
  normals: THREE.Vector3[];
}

interface EdgeIndex {
  /** Deduplicated vertex positions. */
  points: THREE.Vector3[];
  edges: EdgeIndexEntry[];
  /** Vertex index → indices into `edges`. */
  byVertex: Map<number, number[]>;
}

const EDGE_CACHE = new WeakMap<THREE.BufferGeometry, EdgeIndex | null>();
const EDGE_INDEX_LIMIT = 300_000;

/**
 * Build (once, lazily) an edge adjacency index so "measure length" can snap to
 * a real model edge instead of an arbitrary triangle side.
 */
function buildEdgeIndex(geometry: THREE.BufferGeometry): EdgeIndex | null {
  const cached = EDGE_CACHE.get(geometry);
  if (cached !== undefined) return cached;

  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  if (!position) {
    EDGE_CACHE.set(geometry, null);
    return null;
  }
  const triangleCount = index ? index.count / 3 : position.count / 3;
  if (triangleCount > EDGE_INDEX_LIMIT) {
    EDGE_CACHE.set(geometry, null);
    return null;
  }

  geometry.computeBoundingBox();
  const size = geometry.boundingBox?.getSize(new THREE.Vector3()) ?? new THREE.Vector3(1, 1, 1);
  const quantum = (Math.max(size.x, size.y, size.z) || 1) * 1e-6;

  const points: THREE.Vector3[] = [];
  const lookup = new Map<string, number>();
  const vertexId = (i: number): number => {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const key = `${Math.round(x / quantum)},${Math.round(y / quantum)},${Math.round(z / quantum)}`;
    const existing = lookup.get(key);
    if (existing !== undefined) return existing;
    const id = points.length;
    points.push(new THREE.Vector3(x, y, z));
    lookup.set(key, id);
    return id;
  };

  const edgeLookup = new Map<string, number>();
  const edges: EdgeIndexEntry[] = [];
  const byVertex = new Map<number, number[]>();

  const addEdge = (a: number, b: number, normal: THREE.Vector3) => {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    let id = edgeLookup.get(key);
    if (id === undefined) {
      id = edges.length;
      edges.push({ a, b, normals: [] });
      edgeLookup.set(key, id);
      for (const vertex of [a, b]) {
        const list = byVertex.get(vertex);
        if (list) list.push(id);
        else byVertex.set(vertex, [id]);
      }
    }
    edges[id].normals.push(normal);
  };

  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  for (let t = 0; t < triangleCount; t += 1) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    va.fromBufferAttribute(position, i0);
    vb.fromBufferAttribute(position, i1);
    vc.fromBufferAttribute(position, i2);
    const normal = new THREE.Vector3()
      .subVectors(vb, va)
      .cross(new THREE.Vector3().subVectors(vc, va))
      .normalize();
    const a = vertexId(i0);
    const b = vertexId(i1);
    const c = vertexId(i2);
    addEdge(a, b, normal);
    addEdge(b, c, normal);
    addEdge(c, a, normal);
  }

  const result: EdgeIndex = { points, edges, byVertex };
  EDGE_CACHE.set(geometry, result);
  return result;
}

/** An edge is a visible model edge when its two faces meet at an angle. */
function isFeatureEdge(entry: EdgeIndexEntry, cosThreshold: number): boolean {
  if (entry.normals.length < 2) return true; // boundary edge
  return entry.normals[0].dot(entry.normals[1]) < cosThreshold;
}

/**
 * Find the straight model edge nearest to a picked point and return its full
 * length — collinear segments produced by tessellation are chained together, so
 * a 100 mm edge measures 100 mm rather than one 12 mm triangle side.
 */
export function findEdgeAtPoint(
  geometry: THREE.BufferGeometry,
  localPoint: THREE.Vector3,
  featureAngleDegrees = 20,
): EdgeSegment | null {
  const index = buildEdgeIndex(geometry);
  if (!index) return null;
  const cosThreshold = Math.cos(THREE.MathUtils.degToRad(featureAngleDegrees));

  let bestId = -1;
  let bestDistance = Infinity;
  const closest = new THREE.Vector3();
  const line = new THREE.Line3();

  for (let id = 0; id < index.edges.length; id += 1) {
    const entry = index.edges[id];
    if (!isFeatureEdge(entry, cosThreshold)) continue;
    line.set(index.points[entry.a], index.points[entry.b]);
    line.closestPointToPoint(localPoint, true, closest);
    const distance = closest.distanceToSquared(localPoint);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestId = id;
    }
  }
  if (bestId === -1) return null;

  // Walk both ways along collinear feature edges.
  const direction = new THREE.Vector3()
    .subVectors(index.points[index.edges[bestId].b], index.points[index.edges[bestId].a])
    .normalize();

  const visited = new Set<number>([bestId]);
  const extend = (fromVertex: number): number => {
    let current = fromVertex;
    for (let guard = 0; guard < 10_000; guard += 1) {
      const candidates = index.byVertex.get(current) ?? [];
      let next = -1;
      for (const id of candidates) {
        if (visited.has(id)) continue;
        const entry = index.edges[id];
        if (!isFeatureEdge(entry, cosThreshold)) continue;
        const other = entry.a === current ? entry.b : entry.a;
        const candidateDirection = new THREE.Vector3()
          .subVectors(index.points[other], index.points[current])
          .normalize();
        if (Math.abs(candidateDirection.dot(direction)) > 0.9995) {
          next = id;
          break;
        }
      }
      if (next === -1) return current;
      visited.add(next);
      const entry = index.edges[next];
      current = entry.a === current ? entry.b : entry.a;
    }
    return current;
  };

  const startVertex = extend(index.edges[bestId].a);
  const endVertex = extend(index.edges[bestId].b);
  return { start: index.points[startVertex].clone(), end: index.points[endVertex].clone() };
}

/** Nearest triangle vertex to a picked point, for measurement snapping. */
export function snapToVertex(
  geometry: THREE.BufferGeometry,
  face: THREE.Face | null,
  localPoint: THREE.Vector3,
  maxDistance: number,
): THREE.Vector3 | null {
  if (!face) return null;
  const position = geometry.getAttribute('position');
  if (!position) return null;

  let best: THREE.Vector3 | null = null;
  let bestDistance = maxDistance * maxDistance;
  const candidate = new THREE.Vector3();
  for (const i of [face.a, face.b, face.c]) {
    candidate.fromBufferAttribute(position, i);
    const distance = candidate.distanceToSquared(localPoint);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate.clone();
    }
  }
  return best;
}

/** Which B-Rep face a picked triangle belongs to, from the packed ranges. */
export function faceIndexForTriangle(faceRanges: number[] | undefined, triangleIndex: number): number | null {
  if (!faceRanges) return null;
  for (let i = 0; i < faceRanges.length; i += 2) {
    if (triangleIndex >= faceRanges[i] && triangleIndex <= faceRanges[i + 1]) return i / 2;
  }
  return null;
}
