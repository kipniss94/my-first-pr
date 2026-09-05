/**
 * Reading geometry out of a Parasolid transmit stream.
 *
 * The stream extracted from a `.SLDPRT` is a list of nodes. Each begins with a
 * 16-bit type, then a 16-bit id, then fields whose layout the *schema* fixes —
 * and the schema is the part we do not have. SolidWorks embeds only its own
 * extensions (`mesh`, `lattice`, the `FACE_ID_2001` attribute definitions);
 * the standard types come from `SCH_3501210_35102_13006`, which ships with
 * Parasolid and is not in the file.
 *
 * So this does not pretend to walk the node graph. It reads the one node type
 * whose layout has been pinned down against models of known size — the point —
 * and stops there. That is worth having on its own: the points are the model's
 * vertices, in metres, in model space, and they give a bounding box that can be
 * measured rather than guessed.
 *
 * ## How the layout was established
 *
 * Not by reading a specification, but by the controlled pairs. A 10 mm cube
 * yields corners at (±0.005, ±0.005, {0, 0.01}) and its 20 mm partner yields
 * exactly double at the same node offsets. `sheet-flat-50-100-2` — a part named
 * after its own dimensions — comes out 100 × 50 × 2 mm. Across 65 models with a
 * readable partition, every bounding box this produces lands between 10 mm and
 * 272 mm, with none outside a sane engineering range.
 *
 * ## What it does not do
 *
 * A vertex-less body reads as nothing. A plain cylinder is the clearest case:
 * its circular edges close on themselves and the model has no vertices at all,
 * so it yields zero points and no box. Twenty-nine of the 65 models are like
 * that. This is a floor to build on, not a finished reader — faces, surfaces
 * and a tessellation are what turn these numbers into a picture.
 */

/** The node type whose fields are a point's three coordinates. */
const POINT_NODE = 0x1d;

/**
 * Bytes from the start of a point node to its first coordinate.
 *
 * Type and id are two 16-bit fields, then a 32-bit field, then four 16-bit
 * references to other nodes. The reference count is not constant across every
 * node type, which is why this reader claims only this one.
 */
const POINT_COORDINATES_AT = 2 + 2 + 4 + 8;

/** Bigger than any part, smaller than a rounding artefact — in metres. */
const MAX_COORDINATE = 1e3;
const MIN_COORDINATE = 1e-9;

export interface Vec3 {
  /** Metres, as Parasolid stores them. */
  x: number;
  y: number;
  z: number;
}

export interface ParasolidBounds {
  min: Vec3;
  max: Vec3;
  /** Extent along each axis, in millimetres — what a mechanical drawing shows. */
  sizeMm: Vec3;
}

function plausible(value: number): boolean {
  return value === 0 || (Math.abs(value) > MIN_COORDINATE && Math.abs(value) < MAX_COORDINATE);
}

/**
 * Every distinct vertex position in the stream.
 *
 * The scan steps one byte at a time rather than following the node chain, so a
 * value is only kept when all three coordinates are physically plausible. That
 * filter is doing real work: the same bytes read at a wrong offset produce
 * denormals and astronomically large reals, which is exactly what it rejects.
 *
 * Positions are de-duplicated, because a vertex shared by three faces is
 * written once but referenced many times, and a repeated corner would weight
 * the bounding box without adding information.
 */
export function readPoints(partition: Buffer): Vec3[] {
  const found = new Map<string, Vec3>();
  const last = partition.length - POINT_COORDINATES_AT - 24;

  for (let at = 0; at <= last; at += 1) {
    if (partition.readUInt16BE(at) !== POINT_NODE) continue;

    const coordinates = at + POINT_COORDINATES_AT;
    const x = partition.readDoubleBE(coordinates);
    const y = partition.readDoubleBE(coordinates + 8);
    const z = partition.readDoubleBE(coordinates + 16);
    if (!plausible(x) || !plausible(y) || !plausible(z)) continue;

    found.set(`${x},${y},${z}`, { x, y, z });
  }

  return [...found.values()];
}

/**
 * The model's extent, or `null` when too few vertices were read to mean
 * anything.
 *
 * Two points make a line, not a box. Requiring four is what keeps a part that
 * happens to expose one stray vertex from being reported as a measured object
 * — a wrong dimension shown confidently is worse than no dimension.
 */
export function boundsOf(points: Vec3[]): ParasolidBounds | null {
  if (points.length < 4) return null;

  const axis = (pick: (p: Vec3) => number) => {
    const values = points.map(pick);
    return { min: Math.min(...values), max: Math.max(...values) };
  };
  const x = axis((p) => p.x);
  const y = axis((p) => p.y);
  const z = axis((p) => p.z);

  return {
    min: { x: x.min, y: y.min, z: z.min },
    max: { x: x.max, y: y.max, z: z.max },
    sizeMm: {
      x: (x.max - x.min) * 1000,
      y: (y.max - y.min) * 1000,
      z: (z.max - z.min) * 1000,
    },
  };
}
