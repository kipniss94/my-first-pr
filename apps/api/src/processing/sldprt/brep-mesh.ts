/**
 * Triangles from the exact solid, for parts saved without a display mesh.
 *
 * Most SolidWorks parts carry SolidWorks' own triangulation and are drawn from
 * that (`display-list.ts`). Some do not: parts written by an importer or a
 * converter, and parts saved with their display data stripped. What they all
 * still carry is the B-rep itself, as a Parasolid stream (`xt-reader.ts`) — the
 * faces, the loops of edges that bound them, and the exact curves and surfaces
 * underneath. This turns that into a mesh, the way a CAD kernel would:
 *
 *  1. Every edge is sampled once, along its own curve, within a chord tolerance.
 *     Both faces that meet at the edge use those same points, so the mesh is
 *     closed wherever the solid is.
 *  2. Each face's loops are carried into the parameter plane of its surface.
 *     On a periodic surface — cylinder, cone, sphere, torus — a loop that goes
 *     all the way round is cut along a seam, and a loop round a pole is closed
 *     through it.
 *  3. The resulting polygon, holes and all, is triangulated in that plane, and
 *     interior edges are split until the triangles lie on the surface within
 *     the same tolerance.
 *
 * Orientation follows the topology: a triangle's normal is the surface's own
 * normal, turned by the surface's sense and the face's sense, which is how
 * Parasolid defines the outside of a face. Measured against SolidWorks' display
 * meshes of the same parts — volume, area, extent — this is what makes a
 * reconstructed part come out closed and the right way out.
 */

import earcut from 'earcut';
import { unwrapCodec, type PackageEntry } from './container.js';
import type { IndexedMesh } from './display-list.js';
import { isBinaryXt, readXt, type XtModel, type XtNode, type XtValue } from './xt-reader.js';

type V3 = [number, number, number];
type UV = [number, number];

const TAU = Math.PI * 2;

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const mid = (a: V3, b: V3): V3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
function unit(a: V3): V3 {
  const n = norm(a);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : a;
}
const vec = (value: XtValue): V3 => {
  const a = value as number[];
  return [a[0], a[1], a[2]];
};
/** `+` or `-` as Parasolid stores a sense: 43 or 45. */
const senseOf = (value: XtValue | undefined): number => (value === 45 ? -1 : 1);

/** Bring `value` to within half a period of `near`. */
function nearestImage(value: number, near: number, period: number): number {
  return value + Math.round((near - value) / period) * period;
}

/* ------------------------------------------------------------------ NURBS */

interface Nurbs {
  degree: number;
  knots: number[];
  /** Control points, `stride` numbers each; the last is the weight when rational. */
  points: number[];
  stride: number;
  rational: boolean;
  count: number;
  lo: number;
  hi: number;
}

function findSpan(knots: number[], degree: number, count: number, t: number): number {
  const n = count - 1;
  if (t >= knots[n + 1]) return n;
  if (t <= knots[degree]) return degree;
  let low = degree;
  let high = n + 1;
  let span = (low + high) >> 1;
  while (t < knots[span] || t >= knots[span + 1]) {
    if (t < knots[span]) high = span;
    else low = span;
    span = (low + high) >> 1;
  }
  return span;
}

function basis(knots: number[], degree: number, span: number, t: number, out: number[]): void {
  const left = new Array<number>(degree + 1);
  const right = new Array<number>(degree + 1);
  out[0] = 1;
  for (let j = 1; j <= degree; j += 1) {
    left[j] = t - knots[span + 1 - j];
    right[j] = knots[span + j] - t;
    let saved = 0;
    for (let r = 0; r < j; r += 1) {
      const denominator = right[r + 1] + left[j - r];
      const temp = denominator === 0 ? 0 : out[r] / denominator;
      out[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    out[j] = saved;
  }
}

/** Knots, control points and flags of a NURBS_CURVE or NURBS_SURF node. */
function nurbsParts(
  model: XtModel,
  vertices: XtValue,
  mult: XtValue,
  knotSet: XtValue,
): { points: number[]; knots: number[] } | null {
  const v = model.nodes.get(vertices as number)?.f.vertices as number[] | undefined;
  const m = model.nodes.get(mult as number)?.f.mult as number[] | undefined;
  const k = model.nodes.get(knotSet as number)?.f.knots as number[] | undefined;
  if (!v || !m || !k || m.length !== k.length) return null;
  const knots: number[] = [];
  for (let i = 0; i < k.length; i += 1) for (let j = 0; j < m[i]; j += 1) knots.push(k[i]);
  return { points: v, knots };
}

function nurbsCurve(model: XtModel, node: XtNode): Nurbs | null {
  const f = node.f;
  const parts = nurbsParts(model, f.bspline_vertices, f.knot_mult, f.knots);
  if (!parts) return null;
  const degree = f.degree as number;
  const stride = f.vertex_dim as number;
  const count = parts.points.length / stride;
  if (!Number.isInteger(count) || parts.knots.length !== count + degree + 1) return null;
  return {
    degree,
    knots: parts.knots,
    points: parts.points,
    stride,
    rational: f.rational === 1,
    count,
    lo: parts.knots[degree],
    hi: parts.knots[count],
  };
}

/** A point of a NURBS curve, in its own dimension (2 for a curve in a surface's parameters). */
function nurbsAt(curve: Nurbs, t: number, dimension: number): number[] {
  const u = Math.min(Math.max(t, curve.lo), curve.hi);
  const span = findSpan(curve.knots, curve.degree, curve.count, u);
  const n = new Array<number>(curve.degree + 1);
  basis(curve.knots, curve.degree, span, u, n);
  const sum = new Array<number>(dimension + 1).fill(0);
  for (let j = 0; j <= curve.degree; j += 1) {
    const base = (span - curve.degree + j) * curve.stride;
    const w = curve.rational ? curve.points[base + dimension] : 1;
    // Parasolid stores rational vertices in homogeneous form: (wx, wy, wz, w).
    for (let d = 0; d < dimension; d += 1) sum[d] += n[j] * curve.points[base + d];
    sum[dimension] += n[j] * w;
  }
  if (curve.rational) for (let d = 0; d < dimension; d += 1) sum[d] /= sum[dimension];
  return sum.slice(0, dimension);
}

/* ------------------------------------------------------------------ curves */

interface Curve {
  at(t: number): V3;
  /** Parameter of the curve point nearest `p`. */
  param(p: V3): number;
  /** Period of a closed curve's parameter, or null. */
  period: number | null;
  /** Parameter range. */
  range: [number, number];
  /** Parameters from t0 to t1 inclusive, close enough together for `tol`. */
  samples(t0: number, t1: number, tol: number): number[];
}

/** Largest angle a chord may span on a circle of radius r and stay within tol. */
function arcStep(radius: number, tol: number): number {
  const byTolerance = radius > tol ? 2 * Math.acos(1 - tol / radius) : Math.PI / 2;
  return Math.max(Math.min(byTolerance, Math.PI / 16), Math.PI / 180);
}

function evenSamples(t0: number, t1: number, step: number): number[] {
  const n = Math.max(1, Math.ceil(Math.abs(t1 - t0) / step - 1e-9));
  const out: number[] = [];
  for (let i = 0; i <= n; i += 1) out.push(t0 + ((t1 - t0) * i) / n);
  return out;
}

/** Split [t0, t1] until every piece's midpoint is within tol of its chord. */
function adaptiveSamples(at: (t: number) => V3, t0: number, t1: number, tol: number, minPieces = 4): number[] {
  const out: number[] = [t0];
  const refine = (a: number, pa: V3, b: number, pb: V3, depth: number): void => {
    const m = (a + b) / 2;
    const pm = at(m);
    const q1 = at((a + m) / 2);
    const deviation = Math.max(dist(pm, mid(pa, pb)), dist(q1, mid(pa, pm)));
    if (depth < 14 && deviation > tol) {
      refine(a, pa, m, pm, depth + 1);
      refine(m, pm, b, pb, depth + 1);
    } else {
      out.push(b);
    }
  };
  let a = t0;
  let pa = at(t0);
  for (let i = 1; i <= minPieces; i += 1) {
    const b = t0 + ((t1 - t0) * i) / minPieces;
    const pb = at(b);
    refine(a, pa, b, pb, 0);
    a = b;
    pa = pb;
  }
  return out;
}

/** Nearest parameter by sampling, then golden-section refinement. */
function searchParam(at: (t: number) => V3, lo: number, hi: number, p: V3, samples = 256): number {
  let best = lo;
  let bestDistance = Infinity;
  for (let i = 0; i <= samples; i += 1) {
    const t = lo + ((hi - lo) * i) / samples;
    const d = dist(at(t), p);
    if (d < bestDistance) {
      bestDistance = d;
      best = t;
    }
  }
  let a = Math.max(lo, best - (hi - lo) / samples);
  let b = Math.min(hi, best + (hi - lo) / samples);
  const g = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 60 && b - a > 1e-15 * (1 + Math.abs(a)); i += 1) {
    const c = b - g * (b - a);
    const d = a + g * (b - a);
    if (dist(at(c), p) < dist(at(d), p)) b = d;
    else a = c;
  }
  return (a + b) / 2;
}

function lineCurve(f: XtNode['f']): Curve {
  const p = vec(f.pvec);
  const d = unit(vec(f.direction));
  return {
    at: (t) => add(p, mul(d, t)),
    param: (q) => dot(sub(q, p), d),
    period: null,
    range: [-1e3, 1e3],
    samples: (t0, t1) => [t0, t1],
  };
}

function conicCurve(centre: V3, normal: V3, xAxis: V3, a: number, b: number): Curve {
  const x = unit(xAxis);
  const y = unit(cross(normal, x));
  return {
    at: (t) => add(centre, add(mul(x, a * Math.cos(t)), mul(y, b * Math.sin(t)))),
    param: (q) => {
      const d = sub(q, centre);
      return Math.atan2(dot(d, y) / b, dot(d, x) / a);
    },
    period: TAU,
    range: [0, TAU],
    samples: (t0, t1, tol) => evenSamples(t0, t1, arcStep(Math.max(a, b), tol)),
  };
}

/** A curve given as points in order — the chart of an intersection curve. */
function polylineCurve(chart: V3[], loop: boolean): Curve {
  // A closed chart may stop just short of where it began; close it exactly, or
  // an edge ending at the join could be sent the long way round.
  const points = loop && dist(chart[0], chart[chart.length - 1]) > 0 ? [...chart, chart[0]] : chart;
  const n = points.length;
  const closed = n > 2 && (loop || dist(points[0], points[n - 1]) < 1e-9);
  const last = n - 1;
  const at = (t: number): V3 => {
    let s = t;
    if (closed) s = ((s % last) + last) % last;
    s = Math.min(Math.max(s, 0), last);
    const i = Math.min(Math.floor(s), last - 1);
    const f = s - i;
    const a = points[i];
    const b = points[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  };
  return {
    at,
    param: (q) => {
      let best = 0;
      let bestDistance = Infinity;
      for (let i = 0; i < last; i += 1) {
        const a = points[i];
        const ab = sub(points[i + 1], a);
        const l2 = dot(ab, ab);
        const f = l2 > 0 ? Math.min(Math.max(dot(sub(q, a), ab) / l2, 0), 1) : 0;
        const d = dist(add(a, mul(ab, f)), q);
        if (d < bestDistance) {
          bestDistance = d;
          best = i + f;
        }
      }
      return best;
    },
    period: closed ? last : null,
    range: [0, last],
    samples: (t0, t1) => {
      const out = [t0];
      if (t1 > t0) for (let i = Math.floor(t0) + 1; i < t1; i += 1) out.push(i);
      else for (let i = Math.ceil(t0) - 1; i > t1; i -= 1) out.push(i);
      out.push(t1);
      return out;
    },
  };
}

/* ---------------------------------------------------------------- surfaces */

interface Surface {
  at(u: number, v: number): V3;
  /** The surface's own unit normal, `∂u × ∂v`. */
  normal(u: number, v: number): V3;
  /** Parameters of `p`; `near` helps iterative surfaces. u is NaN at a pole. */
  uv(p: V3, near: UV | null): UV;
  /** The nearest point of the surface, when `at(uv(p))` is not already that. */
  closest?(p: V3): V3;
  periodU: number | null;
  periodV: number | null;
  /** v of the rows where u degenerates to a single point, if any. */
  poleLow: number | null;
  poleHigh: number | null;
  /** u of the columns where v degenerates — a spun profile ending on its axis. */
  poleLowU?: number | null;
  poleHighU?: number | null;
  planar: boolean;
  /** Metres per unit of u and v, roughly: the plane the polygon is triangulated in. */
  su: number;
  sv: number;
  domain: [number, number, number, number];
}

function frame(axis: V3, xAxis: V3): { a: V3; x: V3; y: V3 } {
  const a = unit(axis);
  const x = unit(xAxis);
  return { a, x, y: unit(cross(a, x)) };
}

function planeSurface(f: XtNode['f']): Surface {
  const p = vec(f.pvec);
  const { a: n, x, y } = frame(vec(f.normal), vec(f.x_axis));
  return {
    at: (u, v) => add(p, add(mul(x, u), mul(y, v))),
    normal: () => n,
    uv: (q) => [dot(sub(q, p), x), dot(sub(q, p), y)],
    periodU: null,
    periodV: null,
    poleLow: null,
    poleHigh: null,
    planar: true,
    su: 1,
    sv: 1,
    domain: [-1e3, 1e3, -1e3, 1e3],
  };
}

/** Cylinder and cone: a radius that changes linearly along the axis. */
function coneSurface(p: V3, axis: V3, xAxis: V3, radius: number, slope: number): Surface {
  const { a, x, y } = frame(axis, xAxis);
  const rho = (v: number) => radius + slope * v;
  const apex = slope !== 0 ? -radius / slope : null;
  return {
    at: (u, v) => add(add(p, mul(a, v)), mul(add(mul(x, Math.cos(u)), mul(y, Math.sin(u))), rho(v))),
    normal: (u, v) => {
      const radial = add(mul(x, Math.cos(u)), mul(y, Math.sin(u)));
      const n = unit(sub(radial, mul(a, slope)));
      return rho(v) < 0 ? mul(n, -1) : n;
    },
    uv: (q) => {
      const d = sub(q, p);
      const v = dot(d, a);
      const px = dot(d, x);
      const py = dot(d, y);
      const r = Math.hypot(px, py);
      return [r < 1e-12 + 1e-9 * Math.abs(radius) ? Number.NaN : Math.atan2(py, px), v];
    },
    // uv() keeps the height along the axis, which on a cone is not the
    // nearest point: that is square to the slanted line of the cone.
    closest: (q) => {
      const d = sub(q, p);
      const h = dot(d, a);
      const radial = sub(d, mul(a, h));
      const r = norm(radial);
      const s = ((r - radius) * slope + h) / (1 + slope * slope);
      const out = r > 0 ? mul(radial, 1 / r) : x;
      return add(add(p, mul(a, s)), mul(out, radius + slope * s));
    },
    periodU: TAU,
    periodV: null,
    poleLow: apex !== null && slope > 0 ? apex : null,
    poleHigh: apex !== null && slope < 0 ? apex : null,
    planar: false,
    su: Math.max(Math.abs(radius), 1e-6),
    sv: Math.sqrt(1 + slope * slope),
    domain: [0, TAU, -1e3, 1e3],
  };
}

function sphereSurface(f: XtNode['f']): Surface {
  const c = vec(f.centre);
  const r = f.radius as number;
  const { a, x, y } = frame(vec(f.axis), vec(f.x_axis));
  const dir = (u: number, v: number): V3 =>
    add(mul(add(mul(x, Math.cos(u)), mul(y, Math.sin(u))), Math.cos(v)), mul(a, Math.sin(v)));
  return {
    at: (u, v) => add(c, mul(dir(u, v), r)),
    normal: (u, v) => dir(u, v),
    uv: (q) => {
      const d = sub(q, c);
      const h = dot(d, a);
      const px = dot(d, x);
      const py = dot(d, y);
      const v = Math.atan2(h, Math.hypot(px, py));
      const atPole = Math.hypot(px, py) < 1e-9 * Math.abs(r);
      return [atPole ? Number.NaN : Math.atan2(py, px), v];
    },
    periodU: TAU,
    periodV: null,
    poleLow: -Math.PI / 2,
    poleHigh: Math.PI / 2,
    planar: false,
    su: Math.abs(r),
    sv: Math.abs(r),
    domain: [0, TAU, -Math.PI / 2, Math.PI / 2],
  };
}

function torusSurface(f: XtNode['f']): Surface {
  const c = vec(f.centre);
  const major = f.major_radius as number;
  const minor = f.minor_radius as number;
  const { a, x, y } = frame(vec(f.axis), vec(f.x_axis));
  const radial = (u: number): V3 => add(mul(x, Math.cos(u)), mul(y, Math.sin(u)));
  return {
    at: (u, v) => add(add(c, mul(radial(u), major + minor * Math.cos(v))), mul(a, minor * Math.sin(v))),
    normal: (u, v) => {
      const n = add(mul(radial(u), Math.cos(v)), mul(a, Math.sin(v)));
      return minor < 0 ? mul(n, -1) : n;
    },
    uv: (q) => {
      const d = sub(q, c);
      const h = dot(d, a);
      const px = dot(d, x);
      const py = dot(d, y);
      return [Math.atan2(py, px), Math.atan2(h / minor, (Math.hypot(px, py) - major) / minor)];
    },
    periodU: TAU,
    periodV: TAU,
    poleLow: null,
    poleHigh: null,
    planar: false,
    su: Math.max(Math.abs(major) + Math.abs(minor), 1e-6),
    sv: Math.max(Math.abs(minor), 1e-6),
    domain: [0, TAU, 0, TAU],
  };
}

/** Normal and inverse by finite differences and Newton's method — for any surface with `at`. */
function numericSurface(
  at: (u: number, v: number) => V3,
  domain: [number, number, number, number],
  periodU: number | null,
  periodV: number | null,
  seed?: (p: V3) => UV | null,
): Surface {
  const [u0, u1, v0, v1] = domain;
  const hu = Math.min(u1 - u0, 1) * 1e-6;
  const hv = Math.min(v1 - v0, 1) * 1e-6;
  const clampU = (u: number) => (periodU ? u : Math.min(Math.max(u, u0), u1));
  const clampV = (v: number) => (periodV ? v : Math.min(Math.max(v, v0), v1));
  const partials = (u: number, v: number): [V3, V3] => {
    const ua = clampU(u - hu);
    const ub = clampU(u + hu);
    const va = clampV(v - hv);
    const vb = clampV(v + hv);
    return [mul(sub(at(ub, v), at(ua, v)), 1 / (ub - ua)), mul(sub(at(u, vb), at(u, va)), 1 / (vb - va))];
  };
  const grid: { uv: UV; p: V3 }[] = [];
  const N = 24;
  for (let i = 0; i <= N; i += 1)
    for (let j = 0; j <= N; j += 1) {
      const uv: UV = [u0 + ((u1 - u0) * i) / N, v0 + ((v1 - v0) * j) / N];
      grid.push({ uv, p: at(uv[0], uv[1]) });
    }
  const newton = (p: V3, start: UV): { uv: UV; error: number } => {
    let [u, v] = start;
    for (let i = 0; i < 30; i += 1) {
      const s = at(u, v);
      const [su, sv] = partials(u, v);
      const r = sub(p, s);
      const a11 = dot(su, su);
      const a12 = dot(su, sv);
      const a22 = dot(sv, sv);
      const b1 = dot(su, r);
      const b2 = dot(sv, r);
      const det = a11 * a22 - a12 * a12;
      if (!(Math.abs(det) > 1e-30)) break;
      const du = (b1 * a22 - b2 * a12) / det;
      const dv = (a11 * b2 - a12 * b1) / det;
      u = clampU(u + du);
      v = clampV(v + dv);
      if (Math.abs(du) < 1e-12 * (1 + Math.abs(u1 - u0)) && Math.abs(dv) < 1e-12 * (1 + Math.abs(v1 - v0))) break;
    }
    return { uv: [u, v], error: dist(at(u, v), p) };
  };
  let su = 0;
  let sv = 0;
  for (let i = 0; i < N; i += 1) {
    su += dist(grid[i * (N + 1) + N / 2].p, grid[(i + 1) * (N + 1) + N / 2].p);
    sv += dist(grid[(N / 2) * (N + 1) + i].p, grid[(N / 2) * (N + 1) + i + 1].p);
  }
  return {
    at,
    normal: (u, v) => {
      const [a, b] = partials(u, v);
      return unit(cross(a, b));
    },
    uv: (p, near) => {
      const seeded = seed?.(p);
      const first = newton(p, seeded ?? near ?? grid[0].uv);
      // Points handed in lie on the surface; anything short of that is a
      // wrong basin, so look again from the nearest sample.
      if (first.error < 1e-8) return first.uv;
      let best = grid[0];
      let bestDistance = Infinity;
      for (const g of grid) {
        const d = dist(g.p, p);
        if (d < bestDistance) {
          bestDistance = d;
          best = g;
        }
      }
      const second = newton(p, best.uv);
      return second.error < first.error ? second.uv : first.uv;
    },
    periodU,
    periodV,
    poleLow: null,
    poleHigh: null,
    planar: false,
    su: Math.max(su / (u1 - u0 || 1), 1e-9),
    sv: Math.max(sv / (v1 - v0 || 1), 1e-9),
    domain,
  };
}

/* ------------------------------------------------------------- the builder */

export interface BrepMeshStats {
  faces: number;
  /** Faces drawn on their exact surface. */
  exact: number;
  /** Faces on a surface type this does not evaluate, drawn flat through their edges. */
  approximated: number;
  /** Faces that could not be triangulated at all. */
  skipped: number;
  /** Surface types met, by name, for the log. */
  surfaces: Record<string, number>;
  /** Why faces were drawn flat, by surface and reason, for the log. */
  reasons: Record<string, number>;
}

export interface BrepMesh {
  mesh: IndexedMesh;
  stats: BrepMeshStats;
}

const SURFACE_NAMES: Record<number, string> = {
  50: 'plane',
  51: 'cylinder',
  52: 'cone',
  53: 'sphere',
  54: 'torus',
  56: 'blend',
  59: 'blend bound',
  60: 'offset',
  67: 'swept',
  68: 'spun',
  124: 'b-surface',
};

class BrepMesher {
  private readonly curves = new Map<number, Curve | null>();
  private readonly surfaces = new Map<number, Surface | null>();
  private readonly edges = new Map<number, V3[]>();
  readonly tol: number;
  readonly stats: BrepMeshStats = { faces: 0, exact: 0, approximated: 0, skipped: 0, surfaces: {}, reasons: {} };
  /** Why the last face could not be laid out on its surface. */
  private why = '';

  private fail(reason: string): null {
    this.why = reason;
    return null;
  }

  constructor(
    private readonly model: XtModel,
    private readonly trace?: (message: string) => void,
  ) {
    this.tol = this.tolerance();
  }

  private node(index: XtValue | undefined): XtNode | undefined {
    return index ? this.model.nodes.get(index as number) : undefined;
  }

  /** A chord tolerance in proportion to the part: fine on a washer, sane on a frame. */
  private tolerance(): number {
    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    const take = (p: V3, r = 0) => {
      for (let i = 0; i < 3; i += 1) {
        lo[i] = Math.min(lo[i], p[i] - r);
        hi[i] = Math.max(hi[i], p[i] + r);
      }
    };
    // A ball or a ring has no vertices at all, so its surfaces count too.
    for (const point of this.model.byType.get(29) ?? []) take(vec(point.f.pvec));
    for (const circle of this.model.byType.get(31) ?? []) take(vec(circle.f.centre), Math.abs(circle.f.radius as number));
    for (const sphere of this.model.byType.get(53) ?? []) take(vec(sphere.f.centre), Math.abs(sphere.f.radius as number));
    for (const torus of this.model.byType.get(54) ?? [])
      take(vec(torus.f.centre), Math.abs(torus.f.major_radius as number) + Math.abs(torus.f.minor_radius as number));
    for (const chart of this.model.byType.get(40) ?? []) {
      const flat = chart.f.hvec as number[];
      for (let i = 0; i + 2 < flat.length; i += 3) take([flat[i], flat[i + 1], flat[i + 2]]);
    }
    const diagonal = Number.isFinite(lo[0]) ? dist(lo, hi) : 0.1;
    return Math.min(Math.max(diagonal * 5e-4, 2e-6), 2e-4);
  }

  /* ---------------------------------------------------------------- curves */

  curve(index: XtValue): Curve | null {
    const key = index as number;
    if (this.curves.has(key)) return this.curves.get(key) ?? null;
    this.curves.set(key, null);
    const built = this.buildCurve(this.node(index));
    this.curves.set(key, built);
    return built;
  }

  private buildCurve(node: XtNode | undefined): Curve | null {
    if (!node) return null;
    const f = node.f;
    switch (node.type) {
      case 30:
        return lineCurve(f);
      case 31: {
        const r = f.radius as number;
        return conicCurve(vec(f.centre), vec(f.normal), vec(f.x_axis), r, r);
      }
      case 32:
        return conicCurve(vec(f.centre), vec(f.normal), vec(f.x_axis), f.major_radius as number, f.minor_radius as number);
      case 38: {
        const chart = this.node(f.chart);
        const flat = chart?.f.hvec as number[] | undefined;
        if (!flat || flat.length < 6) return null;
        const points: V3[] = [];
        for (let i = 0; i + 2 < flat.length; i += 3) points.push([flat[i], flat[i + 1], flat[i + 2]]);
        // A closed intersection starts and ends at the same limit point.
        const limit = (index: XtValue) => {
          const hvec = this.node(index)?.f.hvec as number[] | undefined;
          return hvec && hvec.length >= 3 ? ([hvec[0], hvec[1], hvec[2]] as V3) : null;
        };
        const start = limit(f.start);
        const end = limit(f.end);
        const span = dist(points[0], points[points.length - 1]);
        const loop = points.length > 3 && ((start !== null && end !== null && dist(start, end) < 1e-9) || span < 1e-7);
        return polylineCurve(points, loop);
      }
      case 133: {
        const basisCurve = this.curve(f.basis_curve);
        if (!basisCurve) return null;
        // The trimmed curve runs from parm_1 to parm_2, which may be downhill:
        // (0, −2π) is a full turn the other way round its basis circle.
        const p1 = f.parm_1 as number;
        const p2 = f.parm_2 as number;
        const lo = Math.min(p1, p2);
        const hi = Math.max(p1, p2);
        return {
          at: basisCurve.at,
          param: (q) => {
            const t = basisCurve.param(q);
            if (!basisCurve.period) return Math.min(Math.max(t, lo), hi);
            const image = nearestImage(t, (lo + hi) / 2, basisCurve.period);
            return Math.min(Math.max(image, lo), hi);
          },
          period: null,
          range: [p1, p2],
          samples: basisCurve.samples,
        };
      }
      case 134: {
        const nurbs = this.node(f.nurbs);
        const data = nurbs ? nurbsCurve(this.model, nurbs) : null;
        if (!data || (data.stride !== 3 && data.stride !== 4)) return null;
        const at = (t: number): V3 => nurbsAt(data, t, 3) as V3;
        const periodic = nurbs?.f.periodic === 1;
        return {
          at,
          param: (q) => searchParam(at, data.lo, data.hi, q),
          period: periodic ? data.hi - data.lo : null,
          range: [data.lo, data.hi],
          samples: (t0, t1, tol) => adaptiveSamples(at, t0, t1, tol, Math.max(4, data.count - data.degree)),
        };
      }
      case 137: {
        const surface = this.surface(f.surface);
        const bCurve = this.node(f.b_curve);
        const nurbs = bCurve ? this.node(bCurve.f.nurbs) : undefined;
        const data = nurbs ? nurbsCurve(this.model, nurbs) : null;
        if (!surface || !data || (data.stride !== 2 && data.stride !== 3)) return null;
        const at = (t: number): V3 => {
          const [u, v] = nurbsAt(data, t, 2);
          return surface.at(u, v);
        };
        // Round a periodic surface a few chord checks can miss whole turns, so
        // it also gets a point at least every 1/32 of a period it travels.
        const turns = (t0: number, t1: number) => {
          let travel = 0;
          let previous = nurbsAt(data, t0, 2);
          for (let i = 1; i <= 64; i += 1) {
            const next = nurbsAt(data, t0 + ((t1 - t0) * i) / 64, 2);
            travel = Math.max(
              travel,
              travel + (surface.periodU ? Math.abs(next[0] - previous[0]) / surface.periodU : 0),
              travel + (surface.periodV ? Math.abs(next[1] - previous[1]) / surface.periodV : 0),
            );
            previous = next;
          }
          return travel;
        };
        return {
          at,
          param: (q) => searchParam(at, data.lo, data.hi, q),
          period: null,
          range: [data.lo, data.hi],
          samples: (t0, t1, tol) =>
            adaptiveSamples(at, t0, t1, tol, Math.max(4, data.count - data.degree, Math.ceil(turns(t0, t1) * 32))),
        };
      }
      default:
        return null;
    }
  }

  /* -------------------------------------------------------------- surfaces */

  surface(index: XtValue): Surface | null {
    const key = index as number;
    if (this.surfaces.has(key)) return this.surfaces.get(key) ?? null;
    this.surfaces.set(key, null);
    const built = this.buildSurface(this.node(index));
    this.surfaces.set(key, built);
    return built;
  }

  private buildSurface(node: XtNode | undefined): Surface | null {
    if (!node) return null;
    const f = node.f;
    switch (node.type) {
      case 50:
        return planeSurface(f);
      case 51:
        return coneSurface(vec(f.pvec), vec(f.axis), vec(f.x_axis), f.radius as number, 0);
      case 52:
        return coneSurface(
          vec(f.pvec),
          vec(f.axis),
          vec(f.x_axis),
          f.radius as number,
          (f.sin_half_angle as number) / (f.cos_half_angle as number),
        );
      case 53:
        return sphereSurface(f);
      case 54:
        return torusSurface(f);
      case 67:
        return this.sweptSurface(f);
      case 68:
        return this.spunSurface(f);
      case 60:
        return this.offsetSurface(f);
      case 124:
        return this.bSurface(f);
      default:
        return null;
    }
  }

  /** A section curve moved along a straight direction. */
  private sweptSurface(f: XtNode['f']): Surface | null {
    const section = this.curve(f.section);
    if (!section) return null;
    const w = unit(vec(f.sweep));
    const at = (u: number, v: number): V3 => add(section.at(u), mul(w, v));
    const [t0, t1] = section.period ? [0, section.period] : section.range;
    // Along the sweep the surface is straight, so only the section needs
    // searching: flatten both onto the plane square to the sweep.
    const flatten = (p: V3): V3 => sub(p, mul(w, dot(p, w)));
    const flatAt = (t: number) => flatten(section.at(t));
    const surface = numericSurface(at, [t0, t1, -1e3, 1e3], section.period, null, (p) => {
      const u = searchParam(flatAt, t0, t1, flatten(p));
      return [u, dot(sub(p, section.at(u)), w)];
    });
    surface.sv = 1;
    return surface;
  }

  /** A profile curve spun about an axis. */
  private spunSurface(f: XtNode['f']): Surface | null {
    const profile = this.curve(f.profile);
    if (!profile) return null;
    const base = vec(f.base);
    const { a, x, y } = frame(vec(f.axis), vec(f.x_axis));
    const rotate = (p: V3, angle: number): V3 => {
      const d = sub(p, base);
      const h = dot(d, a);
      const px = dot(d, x);
      const py = dot(d, y);
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      return add(base, add(mul(a, h), add(mul(x, px * c - py * s), mul(y, px * s + py * c))));
    };
    const angleOf = (p: V3) => Math.atan2(dot(sub(p, base), y), dot(sub(p, base), x));
    // The part of the profile that is spun: from where it leaves the axis to
    // where it returns, when it does. A whole circle spun about its diameter
    // would cover the sphere twice, and each point would have two answers.
    const p0 = f.start_param as number;
    const p1 = f.end_param as number;
    const trimmed = Number.isFinite(p0) && Number.isFinite(p1) && p0 !== p1;
    const [t0, t1] = trimmed ? [Math.min(p0, p1), Math.max(p0, p1)] : profile.period ? [0, profile.period] : profile.range;
    const periodU = trimmed ? null : profile.period;
    const reference = angleOf(profile.at((t0 + t1) / 2));
    const at = (u: number, v: number): V3 => rotate(profile.at(u), v);
    const surface = numericSurface(at, [t0, t1, 0, TAU], periodU, TAU, (p) => {
      const v = angleOf(p) - reference;
      let u = profile.param(rotate(p, -v));
      if (trimmed && profile.period) u = Math.min(Math.max(nearestImage(u, (t0 + t1) / 2, profile.period), t0), t1);
      return [u, v];
    });
    // Where the profile ends on the axis, the whole turn is one point.
    const offAxis = (p: V3) => {
      const d = sub(p, base);
      return norm(sub(d, mul(a, dot(d, a))));
    };
    const onAxis = (t: number) => offAxis(profile.at(t)) < 1e-7;
    const uvOf = surface.uv;
    surface.uv = (p, near) => {
      const uv = uvOf(p, near);
      return offAxis(p) < 1e-9 ? [uv[0], Number.NaN] : uv;
    };
    if (!periodU) {
      surface.poleLowU = onAxis(t0) ? t0 : null;
      surface.poleHighU = onAxis(t1) ? t1 : null;
    }
    return surface;
  }

  private offsetSurface(f: XtNode['f']): Surface | null {
    const baseSurface = this.surface(f.surface);
    if (!baseSurface) return null;
    const distance = f.offset as number;
    const at = (u: number, v: number): V3 => add(baseSurface.at(u, v), mul(baseSurface.normal(u, v), distance));
    return numericSurface(at, baseSurface.domain, baseSurface.periodU, baseSurface.periodV, (p) => baseSurface.uv(p, null));
  }

  private bSurface(f: XtNode['f']): Surface | null {
    const nurbs = this.node(f.nurbs);
    if (!nurbs) return null;
    const g = nurbs.f;
    const uParts = nurbsParts(this.model, g.bspline_vertices, g.u_knot_mult, g.u_knots);
    const vParts = nurbsParts(this.model, g.bspline_vertices, g.v_knot_mult, g.v_knots);
    if (!uParts || !vParts) return null;
    const pu = g.u_degree as number;
    const pv = g.v_degree as number;
    const nu = g.n_u_vertices as number;
    const nv = g.n_v_vertices as number;
    const stride = g.vertex_dim as number;
    const rational = g.rational === 1;
    const points = uParts.points;
    if (points.length !== nu * nv * stride || uParts.knots.length !== nu + pu + 1 || vParts.knots.length !== nv + pv + 1) return null;
    const ku = uParts.knots;
    const kv = vParts.knots;
    const domain: [number, number, number, number] = [ku[pu], ku[nu], kv[pv], kv[nv]];
    const periodU = g.u_periodic === 1 ? domain[1] - domain[0] : null;
    const periodV = g.v_periodic === 1 ? domain[3] - domain[2] : null;
    const wrap = (t: number, lo: number, hi: number, period: number | null) =>
      period ? lo + ((((t - lo) % period) + period) % period) : Math.min(Math.max(t, lo), hi);
    const bu = new Array<number>(pu + 1);
    const bv = new Array<number>(pv + 1);
    const at = (u: number, v: number): V3 => {
      const uu = wrap(u, domain[0], domain[1], periodU);
      const vv = wrap(v, domain[2], domain[3], periodV);
      const su = findSpan(ku, pu, nu, uu);
      const sv = findSpan(kv, pv, nv, vv);
      basis(ku, pu, su, uu, bu);
      basis(kv, pv, sv, vv, bv);
      let x = 0;
      let y = 0;
      let z = 0;
      let w = 0;
      for (let i = 0; i <= pu; i += 1) {
        for (let j = 0; j <= pv; j += 1) {
          // Vertices run with v fastest: row by row in u.
          const base = ((su - pu + i) * nv + (sv - pv + j)) * stride;
          const n = bu[i] * bv[j];
          x += n * points[base];
          y += n * points[base + 1];
          z += n * points[base + 2];
          w += n * (rational ? points[base + 3] : 1);
        }
      }
      return rational ? [x / w, y / w, z / w] : [x, y, z];
    };
    return numericSurface(at, domain, periodU, periodV);
  }

  /* ----------------------------------------------------------------- edges */

  /** Start of a fin: the end of the fin before it. */
  private finStart(fin: XtNode): XtNode | undefined {
    return this.node(this.node(fin.f.backward)?.f.vertex);
  }

  private point(vertex: XtNode | undefined): V3 | null {
    const point = this.node(vertex?.f.point);
    return point ? vec(point.f.pvec) : null;
  }

  /** The edge's points from its start vertex to its end vertex. */
  edgePoints(edge: XtNode): V3[] | null {
    const cached = this.edges.get(edge.index);
    if (cached) return cached;
    const fin = this.node(edge.f.fin);
    if (!fin) return null;
    // A fin's vertex is the one at its end; a fin with sense + runs with the edge.
    const finEnd = this.node(fin.f.vertex);
    const finBegin = this.finStart(fin);
    const [startVertex, endVertex] = senseOf(fin.f.sense) > 0 ? [finBegin, finEnd] : [finEnd, finBegin];
    const start = this.point(startVertex);
    const end = this.point(endVertex);
    const curveNode = this.node(edge.f.curve) ?? this.node(fin.f.curve) ?? this.node(this.node(fin.f.other)?.f.curve);
    const curve = curveNode ? this.curve(curveNode.index) : null;

    let points: V3[];
    if (!curve) {
      if (!start || !end) return null;
      points = [start, end];
    } else {
      const direction = senseOf(curveNode?.f.sense);
      const closed = !start || !end || startVertex === endVertex;
      let t0: number;
      let t1: number;
      if (!start || !end) {
        t0 = curve.period ? 0 : direction > 0 ? curve.range[0] : curve.range[1];
        t1 = curve.period ? direction * curve.period : direction > 0 ? curve.range[1] : curve.range[0];
      } else {
        t0 = curve.param(start);
        t1 = curve.param(end);
        if (curve.period) {
          const p = curve.period;
          if (closed) t1 = t0 + direction * p;
          else if (direction > 0) while (t1 <= t0 + 1e-12) t1 += p;
          else while (t1 >= t0 - 1e-12) t1 -= p;
          if (Math.abs(t1 - t0) > p + 1e-9) t1 -= Math.sign(t1 - t0) * p;
        } else if (closed) {
          [t0, t1] = direction > 0 ? curve.range : [curve.range[1], curve.range[0]];
        }
      }
      points = curve.samples(t0, t1, this.tol).map((t) => curve.at(t));
      if (start) points[0] = start;
      if (end) points[points.length - 1] = end;
      if (closed && !start) points[points.length - 1] = points[0];
      const intersection = this.intersectionOf(curveNode);
      if (intersection) points = this.onBoth(points, intersection);
    }
    this.edges.set(edge.index, points);
    return points;
  }

  /** The two surfaces of an intersection curve, directly or under a trim. */
  private intersectionOf(node: XtNode | undefined): Surface[] | null {
    const curve = node?.type === 133 ? this.node(node.f.basis_curve) : node;
    if (curve?.type !== 38) return null;
    const pair = (curve.f.surface as number[]).map((index) => this.surface(index));
    return pair.every(Boolean) ? (pair as Surface[]) : null;
  }

  /**
   * An intersection curve's chart is only a few points on it — sometimes three
   * for a whole hyperbola — and the curve itself is where its two surfaces
   * meet. So each chord is split where it strays: its midpoint is carried onto
   * both surfaces in turn, held in the plane square to the chord, until it lies
   * on the two at once.
   */
  private onBoth(points: V3[], surfaces: Surface[]): V3[] {
    const nearest = (surface: Surface, q: V3): V3 | null => {
      if (surface.closest) return surface.closest(q);
      const [u, v] = surface.uv(q, null);
      return Number.isFinite(u) && Number.isFinite(v) ? surface.at(u, v) : null;
    };
    const settle = (p: V3, a: V3, b: V3): V3 | null => {
      const d = unit(sub(b, a));
      let q: V3 | null = p;
      for (let i = 0; i < 80 && q; i += 1) {
        const before: V3 = q;
        for (const surface of surfaces) q = q && nearest(surface, q);
        if (!q) return null;
        q = sub(q, mul(d, dot(sub(q, p), d)));
        if (dist(q, before) < this.tol * 1e-3) break;
      }
      if (!q) return null;
      for (const surface of surfaces) {
        const on = nearest(surface, q);
        if (!on || !(dist(on, q) < this.tol)) return null;
      }
      return q;
    };
    const out: V3[] = [points[0]];
    const refine = (a: V3, b: V3, depth: number): void => {
      const m = mid(a, b);
      const q = depth < 12 && dist(a, b) > this.tol ? settle(m, a, b) : null;
      if (q && dist(q, m) > this.tol) {
        refine(a, q, depth + 1);
        refine(q, b, depth + 1);
      } else {
        out.push(b);
      }
    };
    for (let i = 1; i < points.length; i += 1) refine(points[i - 1], points[i], 0);
    return out;
  }

  /* ----------------------------------------------------------------- faces */

  /** The face's loops as closed 3D polylines, each point once. */
  private loops(face: XtNode): V3[][] | null {
    const loops: V3[][] = [];
    const seenLoops = new Set<number>();
    for (let loop = this.node(face.f.loop); loop && !seenLoops.has(loop.index); loop = this.node(loop.f.next)) {
      seenLoops.add(loop.index);
      const points: V3[] = [];
      const first = this.node(loop.f.fin);
      let fin = first;
      let guard = 0;
      do {
        if (!fin || guard++ > 100_000) return null;
        const edge = this.node(fin.f.edge);
        if (edge) {
          const along = this.edgePoints(edge);
          if (!along) return null;
          const run = senseOf(fin.f.sense) > 0 ? along : [...along].reverse();
          for (let i = 0; i < run.length - 1; i += 1) points.push(run[i]);
        } else {
          // A fin without an edge: the loop is a single vertex, at a pole.
          const p = this.point(this.node(fin.f.vertex));
          if (p) points.push(p);
        }
        fin = this.node(fin.f.forward);
      } while (fin && fin !== first);
      if (points.length > 0) loops.push(points);
    }
    return loops;
  }

  meshFace(face: XtNode, out: MeshBuilder): void {
    this.stats.faces += 1;
    const surfaceNode = this.node(face.f.surface);
    const name = surfaceNode ? (SURFACE_NAMES[surfaceNode.type] ?? `type ${surfaceNode.type}`) : 'none';
    this.stats.surfaces[name] = (this.stats.surfaces[name] ?? 0) + 1;
    const loops = this.loops(face);
    if (!loops || loops.every((loop) => loop.length < 3)) {
      if (!loops || loops.length === 0) this.fullSurface(face, out);
      else this.stats.skipped += 1;
      return;
    }
    const surface = surfaceNode ? this.surface(surfaceNode.index) : null;
    const outward = senseOf(surfaceNode?.f.sense) * senseOf(face.f.sense);
    this.why = surface ? '' : 'surface not evaluated';
    const domain = surface ? this.domainOf(surface, loops, outward) : null;
    if (surface && domain) {
      this.stats.exact += 1;
      triangulate(surface, domain, outward, this.tol, out);
    } else {
      const reason = `${name}: ${this.why || 'unknown'}`;
      // Drawn flat, a face that winds round a surface would be a sheet cut
      // straight through the part; a narrow gap is the lesser wrong.
      if (this.why === WINDS_ROUND) this.stats.skipped += 1;
      else this.stats.approximated += 1;
      this.stats.reasons[reason] = (this.stats.reasons[reason] ?? 0) + 1;
      if (this.trace && surface) {
        const describe = (loop: V3[]) => {
          const r = unwrap(surface, loop);
          return r ? `wind ${r.windU}/${r.windV}: ${r.uv.map((p) => p.map((x) => x.toFixed(3)).join(',')).join(' ')}` : 'no parameters';
        };
        const edges: string[] = [];
        for (let loop = this.node(face.f.loop); loop; loop = this.node(loop.f.next)) {
          const first = this.node(loop.f.fin);
          let fin = first;
          do {
            const edge = this.node(fin?.f.edge);
            const curve = this.node(edge?.f.curve);
            const run = edge ? this.edgePoints(edge) : null;
            const ends = run ? [run[0], run[run.length - 1]].map((p) => surface.uv(p, null).map((x) => x.toFixed(3)).join(',')) : [];
            edges.push(`loop #${loop.index} fin #${fin?.index} ${String.fromCharCode(fin?.f.sense as number)} edge #${edge?.index} curve ${curve?.type} ${run?.length ?? 0} pts ${ends.join(' -> ')}`);
            fin = this.node(fin?.f.forward);
          } while (fin && fin !== first);
          if (edges.length > 200) break;
        }
        this.trace(`face #${face.index} ${reason}\n  ${loops.map(describe).join('\n  ')}\n  ${edges.join('\n  ')}`);
      }
      if (this.why !== WINDS_ROUND) flatFace(loops, out);
    }
  }

  /** A face with no loops covers its whole surface: a full sphere or torus. */
  private fullSurface(face: XtNode, out: MeshBuilder): void {
    const surfaceNode = this.node(face.f.surface);
    const surface = surfaceNode ? this.surface(surfaceNode.index) : null;
    if (!surface?.periodU || (surface.periodV === null && (surface.poleLow === null || surface.poleHigh === null))) {
      this.stats.skipped += 1;
      return;
    }
    const outward = senseOf(surfaceNode?.f.sense) * senseOf(face.f.sense);
    const v0 = surface.periodV ? 0 : (surface.poleLow as number);
    const v1 = surface.periodV ? surface.periodV : (surface.poleHigh as number);
    const ring = new Ring(surface);
    ring.line([0, v0], [surface.periodU, v0], this.tol);
    ring.line([surface.periodU, v0], [surface.periodU, v1], this.tol);
    ring.line([surface.periodU, v1], [0, v1], this.tol);
    ring.line([0, v1], [0, v0], this.tol);
    this.stats.exact += 1;
    triangulate(surface, { outer: ring, holes: [] }, outward, this.tol, out);
  }

  /**
   * The face's region in the parameter plane: an outer ring and holes.
   *
   * On a periodic surface a loop can wind once round the period instead of
   * enclosing anything — the two rims of a cylindrical band, the rim of a
   * spherical cap. Those are cut along a seam and joined (band) or closed
   * through the pole (cap), which gives an ordinary polygon.
   */
  private domainOf(surface: Surface, allLoops: V3[][], outward: number): Domain | null {
    // A loop of a single vertex marks a pole — a cone's apex, the tip of a
    // spun profile — and bounds nothing; where it is closes a cap below.
    // So does a loop that has shrunk to a point: an edge of zero length.
    const isPoint = (loop: V3[]) => loop.length < 3 || loop.every((p) => dist(p, loop[0]) < this.tol);
    const loops = allLoops.filter((loop) => !isPoint(loop));
    if (loops.length === 0) return this.fail('no loop of three points');
    const poles = allLoops.filter((loop) => loop.length > 0 && isPoint(loop)).map((loop) => surface.uv(loop[0], null));
    const rings = loops.map((loop) => unwrap(surface, loop));
    if (rings.some((ring) => !ring)) return this.fail('a loop has no parameters on its surface');
    const unwrapped = rings as Unwrapped[];
    // A thread's crest: one loop following the helix round several turns.
    if (unwrapped.some((r) => Math.abs(r.windU) > 1 || Math.abs(r.windV) > 1)) return this.fail(WINDS_ROUND);

    const wrapping = unwrapped.filter((r) => r.windU !== 0 || r.windV !== 0);
    const plain = unwrapped.filter((r) => r.windU === 0 && r.windV === 0);

    if (wrapping.length === 0) {
      const sorted = [...plain].sort((a, b) => Math.abs(area(b.uv)) - Math.abs(area(a.uv)));
      const outer = Ring.from(surface, sorted[0]);
      const holes = sorted.slice(1).map((r) => Ring.from(surface, alignTo(r, sorted[0], surface)));
      return { outer, holes };
    }

    const inU = wrapping.every((r) => r.windU !== 0 && r.windV === 0);
    const inV = wrapping.every((r) => r.windV !== 0 && r.windU === 0);
    if (!inU && !inV) return this.fail('loops wind round both periods');
    const axis = inU ? 0 : 1;
    const period = (axis === 0 ? surface.periodU : surface.periodV) as number;

    if (wrapping.length > 2) return this.fail(`${wrapping.length} loops wind round the period`);

    // The seam runs from a point of one rim to the nearest point of the other,
    // so it adds no point to either: the faces next door, which share those
    // rims, still meet this one point for point. It must not cut a hole: moved
    // into [seam, seam + period), a hole has to end before the period does.
    const holesSpan = plain.map((r) => {
      const values = r.uv.map((p) => p[axis]);
      return [Math.min(...values), Math.max(...values)];
    });
    const clear = (value: number) =>
      !holesSpan.some(([lo, hi]) => lo - Math.floor((lo - value) / period) * period + (hi - lo) >= value + period);
    const [first, second] = wrapping;
    let best: { i: number; j: number; gap: number } | null = null;
    for (let i = 0; i < first.uv.length && best?.gap !== 0; i += 1) {
      const value = first.uv[i][axis];
      if (!clear(value)) continue;
      let j = -1;
      let gap = 0;
      if (second) {
        gap = Infinity;
        for (let k = 0; k < second.uv.length; k += 1) {
          const d = Math.abs(nearestImage(second.uv[k][axis], value, period) - value);
          if (d < gap) {
            gap = d;
            j = k;
          }
        }
      }
      if (!best || gap < best.gap) best = { i, j, gap };
    }
    if (!best) return this.fail('no seam clear of the holes');
    const seam = first.uv[best.i][axis];
    const chains = [openAt(first, best.i, axis, period, seam)];
    if (second) chains.push(openAt(second, best.j, axis, period, seam));
    const ring = new Ring(surface);
    const other = 1 - axis;
    const corner = (along: number, across: number): UV => (axis === 0 ? [along, across] : [across, along]);

    if (chains.length === 2) {
      const forward = chains.find((c) => c.wind > 0);
      const backward = chains.find((c) => c.wind < 0);
      if (!forward || !backward) return this.fail('both rims run the same way');
      let back = shiftChain(backward, axis, period);
      // Across a second period — a torus — two rims bound two bands, the face
      // and the rest of the tube. The face is the one on the left of its
      // loops seen from outside: along +u that is +v in (u, v), along +v it is
      // −u, and the other way round when the outside is against the normal.
      const acrossPeriod = axis === 0 ? surface.periodV : surface.periodU;
      if (acrossPeriod) {
        const mean = (c: Chain) => c.uv.reduce((sum, p) => sum + p[other], 0) / c.uv.length;
        const side = (axis === 0 ? 1 : -1) * (outward > 0 ? 1 : -1);
        const gap = side * (mean(back) - mean(forward));
        const wanted = ((gap % acrossPeriod) + acrossPeriod) % acrossPeriod;
        back = shiftAcross(back, other, side * (wanted - gap));
      }
      ring.chain(forward);
      ring.line(forward.uv[forward.uv.length - 1], back.uv[0], this.tol);
      ring.chain(back);
      ring.line(back.uv[back.uv.length - 1], forward.uv[0], this.tol);
    } else if (chains.length === 1) {
      // A cap: the rim closed through its pole. A vertex at the pole says
      // where it is. Without one, the side the face is on does: the face lies
      // to the left of its loops seen from outside, and ∂u × ∂v is the
      // surface's own normal, so in (u, v) it is to the left when the outside
      // is that normal, and to the right when it is the other one.
      const chain = chains[0];
      const marked = poles.find((p) => Number.isFinite(p[other]));
      let pole: number | null = marked ? marked[other] : null;
      // Along +u the left is +v; along +v it is −u.
      if (pole === null && axis === 0) pole = chain.wind > 0 === outward > 0 ? surface.poleHigh : surface.poleLow;
      if (pole === null && axis === 1) pole = (chain.wind > 0 === outward > 0 ? surface.poleLowU : surface.poleHighU) ?? null;
      if (pole === null) return this.fail('one rim and no pole to close it');
      const start = chain.uv[0];
      const end = chain.uv[chain.uv.length - 1];
      ring.chain(chain);
      ring.line(end, corner(end[axis], pole), this.tol);
      ring.line(corner(end[axis], pole), corner(start[axis], pole), this.tol);
      ring.line(corner(start[axis], pole), start, this.tol);
    } else {
      return this.fail('rims that do not pair up');
    }

    // Holes: into the strip along the seam, and next to the rims across it.
    const otherPeriod = axis === 0 ? surface.periodV : surface.periodU;
    const acrossValues = ring.uv.map((p) => p[other]);
    const across = (Math.min(...acrossValues) + Math.max(...acrossValues)) / 2;
    const holes = plain.map((r) => {
      const values = r.uv.map((p) => p[axis]);
      const shift = Math.floor((Math.min(...values) - seam) / period) * period;
      const centre = r.uv.reduce((sum, p) => sum + p[other], 0) / r.uv.length;
      const lift = otherPeriod ? nearestImage(centre, across, otherPeriod) - centre : 0;
      return Ring.from(surface, {
        ...r,
        uv: r.uv.map((p) => (axis === 0 ? [p[0] - shift, p[1] + lift] : [p[0] + lift, p[1] - shift]) as UV),
      });
    });
    return { outer: ring, holes };
  }
}

/* ------------------------------------------------------ parameter polygons */

interface Unwrapped {
  uv: UV[];
  xyz: V3[];
  windU: number;
  windV: number;
}

interface Chain {
  uv: UV[];
  xyz: V3[];
  wind: number;
}

interface Domain {
  outer: Ring;
  holes: Ring[];
}

/** A closed polygon in (u, v), with the model-space point of each corner. */
class Ring {
  readonly uv: UV[] = [];
  readonly xyz: V3[] = [];
  constructor(private readonly surface: Surface) {}

  static from(surface: Surface, loop: { uv: UV[]; xyz: V3[] }): Ring {
    const ring = new Ring(surface);
    ring.chain(loop);
    return ring;
  }

  push(uv: UV, xyz: V3): void {
    const last = this.uv[this.uv.length - 1];
    if (last && Math.abs(last[0] - uv[0]) < 1e-12 && Math.abs(last[1] - uv[1]) < 1e-12) return;
    this.uv.push(uv);
    this.xyz.push(xyz);
  }

  chain(chain: { uv: UV[]; xyz: V3[] }): void {
    for (let i = 0; i < chain.uv.length; i += 1) this.push(chain.uv[i], chain.xyz[i]);
  }

  /**
   * A straight run in (u, v) — a seam or a pole — split finely enough to bend
   * with the surface. A run along a pole is a single point in space, but it is
   * still split round the period, or the triangles fanning out from it could
   * never be made small enough to follow the surface.
   */
  line(from: UV, to: UV, tol: number): void {
    const at = (t: number): V3 => this.surface.at(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t);
    const turn = (delta: number, period: number | null) => (period ? Math.ceil((Math.abs(delta) / period) * 32) : 1);
    const pieces = Math.max(2, turn(to[0] - from[0], this.surface.periodU), turn(to[1] - from[1], this.surface.periodV));
    const ts = adaptiveSamples(at, 0, 1, tol, pieces);
    for (const t of ts.slice(0, -1)) {
      const uv: UV = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
      this.push(uv, this.surface.at(uv[0], uv[1]));
    }
  }

  close(): void {
    while (this.uv.length > 1) {
      const a = this.uv[0];
      const b = this.uv[this.uv.length - 1];
      if (Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12) {
        this.uv.pop();
        this.xyz.pop();
      } else break;
    }
  }
}

function area(uv: UV[]): number {
  let sum = 0;
  for (let i = 0, j = uv.length - 1; i < uv.length; j = i++) sum += (uv[j][0] - uv[i][0]) * (uv[j][1] + uv[i][1]);
  return sum / 2;
}

/**
 * Continuous (u, v) along a loop, with poles opened into a run along the pole.
 *
 * At a pole one parameter is free — u at a sphere's pole or a cone's apex, v
 * on the axis of a spun profile — and the surface says so with NaN. The loop
 * then runs along the pole, from the free parameter's value at the point
 * before to its value at the point after.
 */
function unwrap(surface: Surface, loop: V3[]): Unwrapped | null {
  const raw: UV[] = [];
  let near: UV | null = null;
  for (const p of loop) {
    const uv = surface.uv(p, near);
    if (!Number.isFinite(uv[0]) && !Number.isFinite(uv[1])) return null;
    raw.push(uv);
    if (Number.isFinite(uv[0]) && Number.isFinite(uv[1])) near = uv;
  }
  const free: (0 | 1 | null)[] = raw.map((uv) => (!Number.isFinite(uv[0]) ? 0 : !Number.isFinite(uv[1]) ? 1 : null));
  if (free.every((k) => k !== null)) return null;

  // Make each parameter continuous across its period, skipping where it is free.
  const periods = [surface.periodU, surface.periodV];
  for (const k of [0, 1]) {
    const period = periods[k];
    let previous: number | null = null;
    for (const uv of raw) {
      if (!Number.isFinite(uv[k])) continue;
      if (previous !== null && period) uv[k] = nearestImage(uv[k], previous, period);
      previous = uv[k];
    }
  }

  const uv: UV[] = [];
  const xyz: V3[] = [];
  const n = raw.length;
  for (let i = 0; i < n; i += 1) {
    const k = free[i];
    if (k === null) {
      uv.push(raw[i]);
      xyz.push(loop[i]);
      continue;
    }
    let before = (i - 1 + n) % n;
    while (!Number.isFinite(raw[before][k]) && before !== i) before = (before - 1 + n) % n;
    let after = (i + 1) % n;
    while (!Number.isFinite(raw[after][k]) && after !== i) after = (after + 1) % n;
    const from = raw[before][k];
    let to = raw[after][k];
    const period = periods[k];
    if (period) to = nearestImage(to, from, period);
    const at = (value: number): UV => (k === 0 ? [value, raw[i][1]] : [raw[i][0], value]);
    uv.push(at(from));
    xyz.push(loop[i]);
    if (Math.abs(to - from) > 1e-9) {
      uv.push(at(to));
      xyz.push(loop[i]);
    }
  }

  // Closing the loop from its last point back to its first: a loop that goes
  // round the period arrives one period away from where it started.
  const first = uv[0];
  const last = uv[uv.length - 1];
  const windU = surface.periodU ? Math.round((nearestImage(first[0], last[0], surface.periodU) - first[0]) / surface.periodU) : 0;
  const windV = surface.periodV ? Math.round((nearestImage(first[1], last[1], surface.periodV) - first[1]) / surface.periodV) : 0;
  return { uv, xyz, windU, windV };
}
/** Move a closed loop by whole periods so it sits next to `anchor`. */
function alignTo(loop: Unwrapped, anchor: Unwrapped, surface: Surface): Unwrapped {
  const cu = (l: Unwrapped) => l.uv.reduce((s, p) => s + p[0], 0) / l.uv.length;
  const cv = (l: Unwrapped) => l.uv.reduce((s, p) => s + p[1], 0) / l.uv.length;
  const du = surface.periodU ? nearestImage(cu(loop), cu(anchor), surface.periodU) - cu(loop) : 0;
  const dv = surface.periodV ? nearestImage(cv(loop), cv(anchor), surface.periodV) - cv(loop) : 0;
  return { ...loop, uv: loop.uv.map((p) => [p[0] + du, p[1] + dv] as UV) };
}

/**
 * Open a loop that winds once round the period at its point `start`: a run
 * from that point to the same point one period on, placed next to `near`.
 */
function openAt(loop: Unwrapped, start: number, axis: number, period: number, near: number): Chain {
  const wind = axis === 0 ? loop.windU : loop.windV;
  const n = loop.uv.length;
  const shift = wind * period;
  const uv: UV[] = [];
  const xyz: V3[] = [];
  for (let i = 0; i <= n; i += 1) {
    const k = start + i;
    const p = loop.uv[k % n];
    // Past the loop's last point the run carries on one period further.
    const lift = k >= n ? shift : 0;
    uv.push(axis === 0 ? [p[0] + lift, p[1]] : [p[0], p[1] + lift]);
    xyz.push(loop.xyz[k % n]);
  }
  const offset = nearestImage(uv[0][axis], near, period) - uv[0][axis];
  return { uv: uv.map((p) => (axis === 0 ? [p[0] + offset, p[1]] : [p[0], p[1] + offset]) as UV), xyz, wind };
}
function shiftAcross(chain: Chain, axis: number, by: number): Chain {
  return { ...chain, uv: chain.uv.map((p) => (axis === 0 ? [p[0] + by, p[1]] : [p[0], p[1] + by]) as UV) };
}

function shiftChain(chain: Chain, axis: number, period: number): Chain {
  return { ...chain, uv: chain.uv.map((p) => (axis === 0 ? [p[0] + period, p[1]] : [p[0], p[1] + period]) as UV) };
}

/* ------------------------------------------------------------ triangulation */

class MeshBuilder {
  positions: number[] = [];
  normals: number[] = [];
  indices: number[] = [];
  faceRanges: { first: number; last: number }[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  vertex(p: V3, n: V3): number {
    this.positions.push(p[0] * 1000, p[1] * 1000, p[2] * 1000);
    this.normals.push(n[0], n[1], n[2]);
    return this.vertexCount - 1;
  }

  /** Close a face: remember which triangles it owns, for picking. */
  endFace(firstTriangle: number): void {
    const last = this.indices.length / 3 - 1;
    if (last >= firstTriangle) this.faceRanges.push({ first: firstTriangle, last });
  }
}

const MAX_VERTICES_PER_FACE = 200_000;

const WINDS_ROUND = 'a loop winds round more than once';

/**
 * Lawson's flips: turn every interior edge whose opposite corner falls inside
 * the other triangle's circumcircle, until none does. Boundary edges — the
 * face's own edges, seams and poles — are never touched. Works in place, on
 * triangles of any winding; leaves them counter-clockwise in `chart`.
 */
function delaunay(triangles: number[], chart: (i: number) => UV, boundary: Set<string>): void {
  const orient = (a: number, b: number, c: number): number => {
    const [ax, ay] = chart(a);
    const [bx, by] = chart(b);
    const [cx, cy] = chart(c);
    return (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  };
  const inCircle = (a: number, b: number, c: number, d: number): number => {
    const [dx, dy] = chart(d);
    const rows = [a, b, c].map((i) => {
      const [x, y] = chart(i);
      return [x - dx, y - dy, (x - dx) ** 2 + (y - dy) ** 2];
    });
    const [[a0, a1, a2], [b0, b1, b2], [c0, c1, c2]] = rows;
    return a0 * (b1 * c2 - b2 * c1) - a1 * (b0 * c2 - b2 * c0) + a2 * (b0 * c1 - b1 * c0);
  };
  const count = triangles.length / 3;
  for (let t = 0; t < count; t += 1) {
    if (orient(triangles[3 * t], triangles[3 * t + 1], triangles[3 * t + 2]) < 0) {
      [triangles[3 * t + 1], triangles[3 * t + 2]] = [triangles[3 * t + 2], triangles[3 * t + 1]];
    }
  }
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const owners = new Map<string, number[]>();
  const attach = (t: number) => {
    for (let e = 0; e < 3; e += 1) {
      const k = key(triangles[3 * t + e], triangles[3 * t + ((e + 1) % 3)]);
      const list = owners.get(k);
      if (list) list.push(t);
      else owners.set(k, [t]);
    }
  };
  const detach = (t: number) => {
    for (let e = 0; e < 3; e += 1) {
      const k = key(triangles[3 * t + e], triangles[3 * t + ((e + 1) % 3)]);
      const list = owners.get(k);
      if (list) owners.set(k, list.filter((x) => x !== t));
    }
  };
  for (let t = 0; t < count; t += 1) attach(t);

  const queue = [...owners.keys()];
  let budget = queue.length * 30 + 1000;
  while (queue.length > 0 && budget-- > 0) {
    const k = queue.pop() as string;
    if (boundary.has(k)) continue;
    const pair = owners.get(k);
    if (!pair || pair.length !== 2) continue;
    const [t1, t2] = pair;
    // t1 = (a, b, c) with the edge as a→b; t2 then runs b→a and holds d.
    let a = -1;
    let b = -1;
    let c = -1;
    for (let e = 0; e < 3; e += 1) {
      const p = triangles[3 * t1 + e];
      const q = triangles[3 * t1 + ((e + 1) % 3)];
      if (key(p, q) === k) {
        a = p;
        b = q;
        c = triangles[3 * t1 + ((e + 2) % 3)];
      }
    }
    let d = -1;
    for (let e = 0; e < 3; e += 1) {
      const v = triangles[3 * t2 + e];
      if (v !== a && v !== b) d = v;
    }
    if (a < 0 || d < 0 || c === d) continue;
    const scale = Math.abs(orient(a, b, c)) + Math.abs(orient(b, a, d));
    if (!(inCircle(a, b, c, d) > 1e-9 * scale * scale)) continue;
    // Only a convex pair can be flipped.
    if (orient(a, d, c) <= 0 || orient(b, c, d) <= 0) continue;
    detach(t1);
    detach(t2);
    triangles[3 * t1] = a;
    triangles[3 * t1 + 1] = d;
    triangles[3 * t1 + 2] = c;
    triangles[3 * t2] = b;
    triangles[3 * t2 + 1] = c;
    triangles[3 * t2 + 2] = d;
    attach(t1);
    attach(t2);
    queue.push(key(a, d), key(d, b), key(b, c), key(c, a));
  }
}

function triangulate(surface: Surface, domain: Domain, outward: number, tol: number, out: MeshBuilder): void {
  domain.outer.close();
  for (const hole of domain.holes) hole.close();
  const rings = [domain.outer, ...domain.holes].filter((ring) => ring.uv.length >= 3);
  if (rings.length === 0 || rings[0] !== domain.outer) return;

  const uv: UV[] = [];
  const xyz: V3[] = [];
  const flat: number[] = [];
  const holeIndices: number[] = [];
  const boundary = new Set<string>();
  const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (const ring of rings) {
    if (ring !== domain.outer) holeIndices.push(uv.length);
    const start = uv.length;
    for (let i = 0; i < ring.uv.length; i += 1) {
      uv.push(ring.uv[i]);
      xyz.push(ring.xyz[i]);
      flat.push(ring.uv[i][0] * surface.su, ring.uv[i][1] * surface.sv);
      boundary.add(key(start + i, start + ((i + 1) % ring.uv.length)));
    }
  }

  let triangles = earcut(flat, holeIndices, 2);
  if (triangles.length === 0) return;

  if (!surface.planar) {
    // Ear clipping fans long slivers across the face. Flipped to Delaunay in
    // the (nearly length-true) parameter plane, the two rims of a band join
    // neighbour to neighbour and little is left to split.
    const chart = (i: number): UV => [uv[i][0] * surface.su, uv[i][1] * surface.sv];
    delaunay(triangles, chart, boundary);
    for (let pass = 0; pass < 10 && uv.length < MAX_VERTICES_PER_FACE; pass += 1) {
      const split = new Map<string, number>();
      for (let t = 0; t < triangles.length; t += 3) {
        for (let e = 0; e < 3; e += 1) {
          const a = triangles[t + e];
          const b = triangles[t + ((e + 1) % 3)];
          const k = key(a, b);
          if (boundary.has(k) || split.has(k)) continue;
          const m: UV = [(uv[a][0] + uv[b][0]) / 2, (uv[a][1] + uv[b][1]) / 2];
          const pm = surface.at(m[0], m[1]);
          // Interior edges get half as much again as the boundary: the rims of a
          // band are sampled to tol, and the diagonals between them sag by as much.
          if (dist(pm, mid(xyz[a], xyz[b])) > 1.5 * tol) {
            split.set(k, uv.length);
            uv.push(m);
            xyz.push(pm);
          } else {
            split.set(k, -1);
          }
        }
      }
      let any = false;
      const next: number[] = [];
      for (let t = 0; t < triangles.length; t += 3) {
        const a = triangles[t];
        const b = triangles[t + 1];
        const c = triangles[t + 2];
        const ab = split.get(key(a, b)) ?? -1;
        const bc = split.get(key(b, c)) ?? -1;
        const ca = split.get(key(c, a)) ?? -1;
        const count = (ab >= 0 ? 1 : 0) + (bc >= 0 ? 1 : 0) + (ca >= 0 ? 1 : 0);
        if (count > 0) any = true;
        if (count === 0) next.push(a, b, c);
        else if (count === 3) next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
        else if (count === 1) {
          if (ab >= 0) next.push(a, ab, c, ab, b, c);
          else if (bc >= 0) next.push(a, b, bc, a, bc, c);
          else next.push(a, b, ca, ca, b, c);
        } else if (ab >= 0 && bc >= 0) next.push(ab, b, bc, a, ab, bc, a, bc, c);
        else if (bc >= 0 && ca >= 0) next.push(bc, c, ca, b, bc, ca, b, ca, a);
        else next.push(ca, a, ab, c, ca, ab, c, ab, b);
      }
      triangles = next;
      if (!any) break;
      delaunay(triangles, chart, boundary);
    }
  }

  // Wind every triangle counter-clockwise in (u, v): that makes its normal
  // ∂u × ∂v, the surface's own; then turn the face out by its senses.
  const base = out.vertexCount;
  const firstTriangle = out.indices.length / 3;
  for (let i = 0; i < uv.length; i += 1) {
    const n = surface.normal(uv[i][0], uv[i][1]);
    out.vertex(xyz[i], mul(n, outward));
  }
  for (let t = 0; t < triangles.length; t += 3) {
    let a = triangles[t];
    let b = triangles[t + 1];
    const c = triangles[t + 2];
    const signed =
      (uv[b][0] - uv[a][0]) * surface.su * (uv[c][1] - uv[a][1]) * surface.sv -
      (uv[c][0] - uv[a][0]) * surface.su * (uv[b][1] - uv[a][1]) * surface.sv;
    if (signed === 0) continue;
    if (signed < 0 !== outward < 0) [a, b] = [b, a];
    out.indices.push(base + a, base + b, base + c);
  }
  out.endFace(firstTriangle);
}

/** A face on a surface this cannot evaluate: triangulated flat through its own edges. */
function flatFace(loops: V3[][], out: MeshBuilder): void {
  const outerLoop = loops[0];
  // Newell's normal follows the loop's direction: the face is on its left.
  let normal: V3 = [0, 0, 0];
  for (let i = 0; i < outerLoop.length; i += 1) {
    const a = outerLoop[i];
    const b = outerLoop[(i + 1) % outerLoop.length];
    normal = add(normal, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]);
  }
  const n = unit(normal);
  if (norm(n) === 0) return;
  const helper: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const x = unit(cross(helper, n));
  const y = cross(n, x);
  const flat: number[] = [];
  const points: V3[] = [];
  const holes: number[] = [];
  for (const loop of loops) {
    if (loop !== outerLoop) holes.push(points.length);
    for (const p of loop) {
      points.push(p);
      flat.push(dot(p, x), dot(p, y));
    }
  }
  const triangles = earcut(flat, holes, 2);
  const base = out.vertexCount;
  const firstTriangle = out.indices.length / 3;
  for (const p of points) out.vertex(p, n);
  for (let t = 0; t < triangles.length; t += 3) {
    let a = triangles[t];
    let b = triangles[t + 1];
    const c = triangles[t + 2];
    // Counter-clockwise in (x, y), whose normal is n.
    const signed = (flat[2 * b] - flat[2 * a]) * (flat[2 * c + 1] - flat[2 * a + 1]) - (flat[2 * c] - flat[2 * a]) * (flat[2 * b + 1] - flat[2 * a + 1]);
    if (signed < 0) [a, b] = [b, a];
    out.indices.push(base + a, base + b, base + c);
  }
  out.endFace(firstTriangle);
}

/* --------------------------------------------------------------- the entry */

export interface BrepSource {
  /** The entry it came from, e.g. `Contents/Config-0-Partition`. */
  name: string;
  /** The transmit stream itself — a valid `.x_t` on its own. */
  data: Buffer;
  model: XtModel;
  faces: number;
}

/**
 * The stream that holds the part's solid, and how many streams could be read.
 *
 * The model partition of the first configuration when it has faces; otherwise
 * the partition with the most. A part made by importing a body keeps it in the
 * import feature's `LocalBodies` and may save only a stub partition, so that
 * is the last resort. Ghost partitions are SolidWorks' previews of edits, not
 * the part.
 */
export function findBrepSource(entries: PackageEntry[]): { source: BrepSource | null; readable: number } {
  const sources: BrepSource[] = [];
  let readable = 0;
  for (const entry of entries) {
    if (!/(^|\/)(Config-\d+-Partition|LocalBodies)$/.test(entry.name)) continue;
    const data = unwrapCodec(entry.data);
    if (!data || !isBinaryXt(data)) continue;
    try {
      const model = readXt(data);
      readable += 1;
      sources.push({ name: entry.name, data, model, faces: model.byType.get(14)?.length ?? 0 });
    } catch {
      // A stream this reader cannot follow: another may still hold the part.
    }
  }
  const withFaces = sources.filter((source) => source.faces > 0);
  const partitions = withFaces.filter((source) => /Partition$/.test(source.name));
  const source =
    partitions.find((source) => /(^|\/)Config-0-Partition$/.test(source.name)) ??
    partitions.sort((a, b) => b.faces - a.faces)[0] ??
    withFaces.sort((a, b) => b.faces - a.faces)[0] ??
    null;
  return { source, readable };
}

/**
 * A mesh of every face in a transmit stream, in millimetres, or null when the
 * stream has no faces — a stub, or a part with no solid in it.
 */
export function meshFromBrep(model: XtModel, trace?: (message: string) => void): BrepMesh | null {
  const faces = model.byType.get(14) ?? [];
  if (faces.length === 0) return null;
  const mesher = new BrepMesher(model, trace);
  const out = new MeshBuilder();
  for (const face of faces) mesher.meshFace(face, out);
  const triangles = out.indices.length / 3;
  if (triangles === 0) return null;
  return {
    mesh: {
      positions: Float32Array.from(out.positions),
      normals: Float32Array.from(out.normals),
      indices: Uint32Array.from(out.indices),
      faceRanges: out.faceRanges,
      triangles,
    },
    stats: mesher.stats,
  };
}
