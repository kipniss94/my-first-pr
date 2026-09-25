/**
 * Reader for binary Parasolid transmit data (XT), as SolidWorks stores it.
 *
 * A transmit stream is a flat list of nodes. Each node is a record whose field
 * layout the *schema* fixes; pointers between nodes are node indices. The file
 * names the schema it was written with (`SCH_2900195_28101_13006`) and embeds
 * only how that schema differs from the base one (`…_13006`). So a reader needs
 * the base layouts — `BASE_SCHEMA` below — and applies the embedded edits.
 *
 * ## The binary encoding, as found in the files
 *
 *     "PS" <int n> <n chars>        header, ": TRANSMIT FILE … version 2900195"
 *     <int n> <n chars>             schema key, "SCH_2900195_28101_13006"
 *     <short>                       number of node types the writer knows
 *     <int>                         user field size (0)
 *     node…                         until a node of type 1
 *
 * and each node:
 *
 *     <short type>
 *     [first node of its type only: 0xff for "as in the base schema", or
 *      <byte field count> and edit codes up to 'Z']
 *     [variable-length types only: <int element count>]
 *     <short index>
 *     fields…
 *
 * Integers and reals are big-endian; a pointer is a short holding the target's
 * index, where 1 means none. The edit codes are `C` (keep the next base field),
 * `D` (drop it), `I` (insert a new field here) and `A` (append one); a new field
 * is `<byte n><name><short pointer class><short count>` and, for a non-pointer,
 * `<byte n><type letters>`.
 *
 * The layouts were established on SolidWorks' own files: the same parts saved
 * as text XT spell every field out, and each binary layout is accepted only
 * when the node after it starts exactly where it should. Everything is read as
 * data and every read is bounded; a stream that does not parse is rejected, not
 * guessed at.
 */

export type XtValue = number | string | number[] | null;

export interface XtNode {
  type: number;
  index: number;
  /** Field values by name. Pointers are node indices, `0` for none. */
  f: Record<string, XtValue>;
}

export interface XtModel {
  header: string;
  schema: string;
  nodes: Map<number, XtNode>;
  /** Nodes of each type, in file order. */
  byType: Map<number, XtNode[]>;
}

interface Field {
  name: string;
  /** One letter per element kind; see `SIZES`. `p` is a pointer. */
  kind: string;
  /** Elements: 1 for a scalar, n for a fixed array, 0 for the variable tail. */
  count: number;
}

interface NodeLayout {
  name: string;
  fields: Field[];
  variable: boolean;
}

/** Bytes per element in the binary encoding. */
const SIZES: Record<string, number> = {
  d: 4, // int
  p: 2, // pointer (node index)
  f: 8, // real
  c: 1, // char
  l: 1, // logical
  u: 1, // unsigned byte
  n: 2, // short
  w: 2, // UTF-16 code unit
  v: 24, // vector: 3 reals
  i: 16, // interval: 2 reals
  b: 48, // box: 6 reals
  h: 32, // homogeneous vector: 4 reals
};

/** Parasolid's "no value" real. */
const NULL_REAL = -3.14158e13;

/* ------------------------------------------------------------------ schema */

/**
 * Base layouts (schema 13006) of the node types SolidWorks writes, as
 * `name:kind`, `name:kind[n]` for a fixed array and `name:kind[]` for the
 * variable tail. `$G` is the header every curve and surface shares.
 */
const GEOM = 'node_id:d attributes_groups:p owner:p next:p previous:p geometric_owner:p sense:c';

const BASE_SCHEMA: Record<number, [string, string]> = {
  10: [
    'ASSEMBLY',
    'highest_node_id:d attributes_groups:p attribute_chains:p list:p surface:p curve:p point:p key:p res_size:f res_linear:f ref_instance:p next:p previous:p state:c owner:p type:c sub_instance:p',
  ],
  11: [
    'INSTANCE',
    'node_id:d attributes_groups:p type:c part:p transform:p assembly:p next_in_part:p prev_in_part:p next_of_part:p prev_of_part:p',
  ],
  12: [
    'BODY',
    'highest_node_id:d attributes_groups:p attribute_chains:p surface:p curve:p point:p key:p res_size:f res_linear:f ref_instance:p next:p previous:p state:c owner:p body_type:c nom_geom_state:c shell:p boundary_surface:p boundary_curve:p boundary_point:p region:p edge:p vertex:p',
  ],
  13: ['SHELL', 'node_id:d attributes_groups:p body:p next:p face:p edge:p vertex:p region:p front_face:p'],
  14: [
    'FACE',
    'node_id:d attributes_groups:p tolerance:f next:p previous:p loop:p shell:p surface:p sense:c next_on_surface:p previous_on_surface:p next_front:p previous_front:p front_shell:p',
  ],
  15: ['LOOP', 'node_id:d attributes_groups:p fin:p face:p next:p'],
  16: [
    'EDGE',
    'node_id:d attributes_groups:p tolerance:f fin:p previous:p next:p curve:p next_on_curve:p previous_on_curve:p owner:p',
  ],
  17: ['FIN', 'attributes_groups:p loop:p forward:p backward:p vertex:p other:p edge:p curve:p next_at_vx:p sense:c'],
  18: ['VERTEX', 'node_id:d attributes_groups:p fin:p previous:p next:p point:p tolerance:f owner:p'],
  19: ['REGION', 'node_id:d attributes_groups:p body:p next:p previous:p shell:p type:c'],
  29: ['POINT', 'node_id:d attributes_groups:p owner:p next:p previous:p pvec:v'],
  30: ['LINE', `${GEOM} pvec:v direction:v`],
  31: ['CIRCLE', `${GEOM} centre:v normal:v x_axis:v radius:f`],
  32: ['ELLIPSE', `${GEOM} centre:v normal:v x_axis:v major_radius:f minor_radius:f`],
  38: ['INTERSECTION', `${GEOM} surface:p[2] chart:p start:p end:p`],
  // The chart of an intersection curve: points on it, in order, in model space.
  40: [
    'CHART',
    'base_parameter:f base_scale:f chart_count:d chordal_error:f angular_error:f parameter_error:f[2] hvec:v[]',
  ],
  41: ['LIMIT', 'type:c hvec:v[]'],
  45: ['BSPLINE_VERTICES', 'vertices:f[]'],
  50: ['PLANE', `${GEOM} pvec:v normal:v x_axis:v`],
  51: ['CYLINDER', `${GEOM} pvec:v axis:v radius:f x_axis:v`],
  52: ['CONE', `${GEOM} pvec:v axis:v radius:f sin_half_angle:f cos_half_angle:f x_axis:v`],
  53: ['SPHERE', `${GEOM} centre:v radius:f axis:v x_axis:v`],
  54: ['TORUS', `${GEOM} centre:v axis:v major_radius:f minor_radius:f x_axis:v`],
  56: [
    'BLENDED_EDGE',
    `${GEOM} blend_type:c surface:p[2] spine:p range:f[2] thumb_weight:f[2] boundary:p[2] start:p end:p`,
  ],
  59: ['BLEND_BOUND', `${GEOM} boundary:n blend:p`],
  60: ['OFFSET_SURF', `${GEOM} check:c true_offset:l surface:p offset:f scale:f`],
  67: ['SWEPT_SURF', `${GEOM} section:p sweep:v scale:f`],
  68: [
    'SPUN_SURF',
    `${GEOM} profile:p base:v axis:v start:v end:v start_param:f end_param:f x_axis:v scale:f`,
  ],
  70: ['LIST', 'node_id:d owner:p next:p previous:p deleted_1:d list_length:d block_length:d deleted_2:d list_block:p'],
  74: ['POINTER_LIS_BLOCK', 'n_entries:d next_block:p entries:p[]'],
  79: ['ATT_DEF_ID', 'string:c[]'],
  80: ['ATTRIB_DEF', 'next:p identifier:p type_id:d actions:u[8] unknown_1:p legal_owners:l[14] fields:u[]'],
  81: [
    'ATTRIBUTE',
    'node_id:d definition:p owner:p next:p previous:p next_of_type:p previous_of_type:p fields:p[]',
  ],
  82: ['INT_VALUES', 'values:d[]'],
  83: ['REAL_VALUES', 'values:f[]'],
  84: ['CHAR_VALUES', 'values:c[]'],
  85: ['POINT_VALUES', 'values:v[]'],
  86: ['VECTOR_VALUES', 'values:v[]'],
  87: ['AXIS_VALUES', 'values:v[]'],
  88: ['TAG_VALUES', 'values:d[]'],
  89: ['DIRECTION_VALUES', 'values:v[]'],
  90: ['GROUP', 'node_id:d attributes_groups:p owner:p next:p previous:p type:c first_member:p'],
  91: ['MEMBER_OF_GROUP', 'dummy_node_id:d attributes_groups:p owning_group:p owner:p next:p previous:p'],
  98: ['UNICODE_VALUES', 'values:w[]'],
  // The root of a partition stream.
  101: [
    'WORLD',
    'assembly:p attribute:p body:p transform:p surface:p curve:p point:p alive:l attrib_def:p highest_id:d current_id:d',
  ],
  100: [
    'TRANSFORM',
    'node_id:d owner:p next:p previous:p rotation_matrix:f[9] translation_vector:v scale:f flag:d perspective_vector:v',
  ],
  124: ['B_SURFACE', `${GEOM} nurbs:p data:p`],
  125: [
    'SURFACE_DATA',
    'original_uint:i original_vint:i extended_uint:i extended_vint:i self_int:c original_u_start:c original_u_end:c original_v_start:c original_v_end:c extended_u_start:c extended_u_end:c extended_v_start:c extended_v_end:c analytic_form_type:c swept_form_type:c spun_form_type:c blend_form_type:c analytic_form:p swept_form:p spun_form:p blend_form:p',
  ],
  126: [
    'NURBS_SURF',
    'u_periodic:l v_periodic:l u_degree:n v_degree:n n_u_vertices:d n_v_vertices:d u_knot_type:c v_knot_type:c n_u_knots:d n_v_knots:d rational:l u_closed:l v_closed:l surface_form:c vertex_dim:n bspline_vertices:p u_knot_mult:p v_knot_mult:p u_knots:p v_knots:p',
  ],
  127: ['KNOT_MULT', 'mult:n[]'],
  128: ['KNOT_SET', 'knots:f[]'],
  133: ['TRIMMED_CURVE', `${GEOM} basis_curve:p point_1:v point_2:v parm_1:f parm_2:f`],
  134: ['B_CURVE', `${GEOM} nurbs:p data:p`],
  135: ['CURVE_DATA', 'self_int:c analytic_form:p'],
  136: [
    'NURBS_CURVE',
    'degree:n n_vertices:d vertex_dim:n n_knots:d knot_type:c periodic:l closed:l rational:l curve_form:c bspline_vertices:p knot_mult:p knots:p',
  ],
  137: ['SP_CURVE', `${GEOM} surface:p b_curve:p original:p tolerance_to_original:f`],
  141: ['GEOMETRIC_OWNER', 'owner:p next:p previous:p shared_geometry:p'],
  // The helix a spline surface or curve was made from — kept alongside it.
  163: ['HELIX_SU_FORM', 'axis_pt:v axis_dir:v hand:c turns:i pitch:f gap:f tol:f'],
  184: ['HELIX_CU_FORM', 'axis_pt:v axis_dir:v point:v hand:c turns:i pitch:f tol:f'],
};

function parseLayout(spec: string): Field[] {
  return spec
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const match = /^(\w+):(\w)(?:\[(\d*)\])?$/.exec(token);
      if (!match) throw new Error(`bad schema token ${token}`);
      const [, name, kind, count] = match;
      return { name, kind, count: count === undefined ? 1 : count === '' ? 0 : Number(count) };
    });
}

const BASE: Map<number, NodeLayout> = new Map(
  Object.entries(BASE_SCHEMA).map(([type, [name, spec]]) => {
    const fields = parseLayout(spec);
    return [Number(type), { name, fields, variable: fields.some((field) => field.count === 0) }];
  }),
);

/* ------------------------------------------------------------------ reader */

export class XtParseError extends Error {
  constructor(
    message: string,
    readonly offset: number,
    readonly lastNodes: string[],
  ) {
    super(`${message} at byte ${offset}`);
  }
}

const MAX_NODES = 2_000_000;

class Cursor {
  at = 0;
  constructor(readonly data: Buffer) {}
  need(bytes: number): void {
    if (this.at + bytes > this.data.length) throw new RangeError('unexpected end of data');
  }
  u8(): number {
    this.need(1);
    return this.data[this.at++];
  }
  i16(): number {
    this.need(2);
    const value = this.data.readInt16BE(this.at);
    this.at += 2;
    return value;
  }
  u16(): number {
    this.need(2);
    const value = this.data.readUInt16BE(this.at);
    this.at += 2;
    return value;
  }
  i32(): number {
    this.need(4);
    const value = this.data.readInt32BE(this.at);
    this.at += 4;
    return value;
  }
  f64(): number {
    this.need(8);
    const value = this.data.readDoubleBE(this.at);
    this.at += 8;
    return value;
  }
  text(length: number): string {
    this.need(length);
    const value = this.data.subarray(this.at, this.at + length).toString('latin1');
    this.at += length;
    return value;
  }
}

/**
 * A pointer: a short, or — past 32767 — two shorts, the first with its top bit
 * set and holding the low 15 bits. Stored one higher than the index, so 1 is
 * "none".
 */
function readPointer(cursor: Cursor): number {
  const first = cursor.u16();
  const value = first & 0x8000 ? cursor.u16() * 0x8000 + (first & 0x7fff) : first;
  return value <= 1 ? 0 : value - 1;
}

function readElement(cursor: Cursor, kind: string): number | number[] {
  switch (kind) {
    case 'd':
      return cursor.i32();
    case 'p':
      return readPointer(cursor);
    case 'f': {
      const value = cursor.f64();
      return value === NULL_REAL ? Number.NaN : value;
    }
    case 'c':
    case 'l':
    case 'u':
      return cursor.u8();
    case 'n':
      return cursor.i16();
    case 'w':
      return cursor.u16();
    case 'v':
      return [cursor.f64(), cursor.f64(), cursor.f64()];
    case 'i':
      return [cursor.f64(), cursor.f64()];
    case 'b':
      return [cursor.f64(), cursor.f64(), cursor.f64(), cursor.f64(), cursor.f64(), cursor.f64()];
    case 'h':
      return [cursor.f64(), cursor.f64(), cursor.f64(), cursor.f64()];
    default:
      throw new Error(`unknown field kind ${kind}`);
  }
}

function readFieldDefinition(cursor: Cursor, type: number): Field {
  const name = cursor.text(cursor.u8());
  const pointerClass = cursor.u16();
  // One more than the text form spells out: 1 is a scalar, 2 the
  // variable-length tail, n + 1 a fixed array of n.
  const elements = cursor.u16();
  const kind = pointerClass === 0 ? cursor.text(cursor.u8()) : 'p';
  if (kind.length !== 1 || !(kind in SIZES)) throw new Error(`unknown field kind ${kind} for ${name}`);
  if (elements < 1) throw new Error(`field ${name} of type ${type} has no elements`);
  return { name, kind, count: elements === 1 ? 1 : elements === 2 ? 0 : elements - 1 };
}

/**
 * A node type the base schema does not have at all, defined in full where it
 * is first used: name, description, each field, then one flag byte.
 */
function readNewType(cursor: Cursor, type: number, count: number): NodeLayout {
  const name = cursor.text(cursor.u8());
  cursor.text(cursor.u8()); // description, e.g. "Intersection data"
  const fields: Field[] = [];
  for (let i = 0; i < count; i += 1) fields.push(readFieldDefinition(cursor, type));
  cursor.u8();
  return { name, fields, variable: fields.some((field) => field.count === 0) };
}

/** Apply the embedded edits for one node type to its base layout. */
function readSchemaEdits(cursor: Cursor, type: number, count: number): NodeLayout {
  const base = BASE.get(type);
  const fields: Field[] = [];
  let next = 0;
  const baseField = (): Field => {
    if (!base || next >= base.fields.length) throw new Error(`schema edit past the base layout of type ${type}`);
    return base.fields[next++];
  };
  for (;;) {
    const op = String.fromCharCode(cursor.u8());
    if (op === 'Z') break;
    if (op === 'C') fields.push(baseField());
    else if (op === 'D') baseField();
    else if (op === 'I' || op === 'A') fields.push(readFieldDefinition(cursor, type));
    else {
      throw new Error(`unknown schema edit ${JSON.stringify(op)} for type ${type}`);
    }
  }
  // Anything the edits did not mention is kept.
  while (base && next < base.fields.length) fields.push(base.fields[next++]);
  if (fields.length !== count) throw new Error(`type ${type}: edits give ${fields.length} fields, header says ${count}`);
  return { name: base?.name ?? `TYPE_${type}`, fields, variable: fields.some((field) => field.count === 0) };
}

export function isBinaryXt(data: Buffer): boolean {
  return data.length > 64 && data[0] === 0x50 && data[1] === 0x53 && data.subarray(0, 128).includes('TRANSMIT FILE');
}

export function readXt(data: Buffer): XtModel {
  const cursor = new Cursor(data);
  const trail: string[] = [];
  try {
    if (cursor.text(2) !== 'PS') throw new Error('not a binary transmit stream');
    const header = cursor.text(cursor.i32());
    const schema = cursor.text(cursor.i32());
    cursor.u16(); // node types known to the writer
    const userFieldSize = cursor.i32();
    if (userFieldSize !== 0) throw new Error(`user fields (${userFieldSize}) are not supported`);

    const layouts = new Map<number, NodeLayout>();
    const nodes = new Map<number, XtNode>();
    const byType = new Map<number, XtNode[]>();

    while (nodes.size < MAX_NODES) {
      const start = cursor.at;
      const type = cursor.u16();
      if (type === 1) break;

      let layout = layouts.get(type);
      if (!layout) {
        const marker = cursor.u8();
        if (marker === 0xff) {
          layout = BASE.get(type);
          if (!layout) throw new Error(`node type ${type} is not in the base schema`);
        } else {
          layout = BASE.has(type) ? readSchemaEdits(cursor, type, marker) : readNewType(cursor, type, marker);
        }
        layouts.set(type, layout);
      }

      const length = layout.variable ? cursor.i32() : 0;
      if (length < 0 || length > data.length) throw new Error(`implausible length ${length} for ${layout.name}`);
      const index = readPointer(cursor);
      const f: Record<string, XtValue> = {};
      for (const field of layout.fields) {
        const count = field.count === 0 ? length : field.count;
        if (field.kind === 'c' && field.count === 0) {
          f[field.name] = cursor.text(count);
        } else if (count === 1) {
          const value = readElement(cursor, field.kind);
          f[field.name] = value;
        } else {
          const values: number[] = [];
          for (let i = 0; i < count; i += 1) {
            const value = readElement(cursor, field.kind);
            if (Array.isArray(value)) values.push(...value);
            else values.push(value);
          }
          f[field.name] = values;
        }
      }

      const node: XtNode = { type, index, f };
      nodes.set(index, node);
      const list = byType.get(type);
      if (list) list.push(node);
      else byType.set(type, [node]);
      trail.push(`${layout.name}#${index}@${start}`);
      if (trail.length > 6) trail.shift();
    }
    return { header, schema, nodes, byType };
  } catch (err) {
    if (err instanceof XtParseError) throw err;
    throw new XtParseError(err instanceof Error ? err.message : String(err), cursor.at, trail);
  }
}
