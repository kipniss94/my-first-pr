/**
 * A tiny STEP (ISO 10303-21, AP214) writer for planar B-Rep solids.
 *
 * It exists so the repository can ship deterministic CAD fixtures without
 * downloading sample models of unclear provenance. It is a test helper, not a
 * CAD kernel: only planar faces with straight edges are supported.
 *
 * A face is described by its plane normal and one or more loops of points. The
 * outer loop must run counter-clockwise when looked at from outside the solid
 * (right-hand rule around the normal); inner loops (holes) run the other way.
 */

export class StepBuilder {
  constructor() {
    this.lines = [];
    this.nextId = 1;
    this.points = new Map();
    this.directions = new Map();
    this.vertices = new Map();
    this.edges = new Map();
  }

  entity(text) {
    const id = this.nextId++;
    this.lines.push(`#${id} = ${text};`);
    return id;
  }

  num(value) {
    if (!Number.isFinite(value)) throw new Error(`bad number: ${value}`);
    if (Number.isInteger(value)) return `${value}.`;
    return String(Number(value.toFixed(9)));
  }

  point(p) {
    const key = p.map((v) => v.toFixed(6)).join(',');
    let id = this.points.get(key);
    if (id === undefined) {
      id = this.entity(`CARTESIAN_POINT('',(${p.map((v) => this.num(v)).join(',')}))`);
      this.points.set(key, id);
    }
    return id;
  }

  direction(d) {
    const key = d.map((v) => v.toFixed(6)).join(',');
    let id = this.directions.get(key);
    if (id === undefined) {
      id = this.entity(`DIRECTION('',(${d.map((v) => this.num(v)).join(',')}))`);
      this.directions.set(key, id);
    }
    return id;
  }

  placement(origin, axis, refDir) {
    return this.entity(
      `AXIS2_PLACEMENT_3D('',#${this.point(origin)},#${this.direction(axis)},#${this.direction(refDir)})`,
    );
  }

  vertex(p) {
    const key = p.map((v) => v.toFixed(6)).join(',');
    let id = this.vertices.get(key);
    if (id === undefined) {
      id = this.entity(`VERTEX_POINT('',#${this.point(p)})`);
      this.vertices.set(key, id);
    }
    return id;
  }

  /** Shared, undirected edge between two points. */
  edge(a, b) {
    const ka = a.map((v) => v.toFixed(6)).join(',');
    const kb = b.map((v) => v.toFixed(6)).join(',');
    const forward = ka < kb;
    const key = forward ? `${ka}|${kb}` : `${kb}|${ka}`;
    let record = this.edges.get(key);
    if (!record) {
      const from = forward ? a : b;
      const to = forward ? b : a;
      const delta = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
      const length = Math.hypot(...delta);
      if (length === 0) throw new Error('degenerate edge');
      const unit = delta.map((v) => v / length);
      const vectorId = this.entity(`VECTOR('',#${this.direction(unit)},${this.num(length)})`);
      const lineId = this.entity(`LINE('',#${this.point(from)},#${vectorId})`);
      const edgeId = this.entity(
        `EDGE_CURVE('',#${this.vertex(from)},#${this.vertex(to)},#${lineId},.T.)`,
      );
      record = { id: edgeId, fromKey: forward ? ka : kb };
      this.edges.set(key, record);
    }
    return { id: record.id, sameSense: record.fromKey === ka };
  }

  loop(points) {
    const orientedIds = [];
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const { id, sameSense } = this.edge(a, b);
      orientedIds.push(this.entity(`ORIENTED_EDGE('',*,*,#${id},${sameSense ? '.T.' : '.F.'})`));
    }
    return this.entity(`EDGE_LOOP('',(${orientedIds.map((id) => `#${id}`).join(',')}))`);
  }

  /**
   * @param {{normal: number[], loops: number[][][], name?: string}} face
   */
  face(face) {
    const outer = face.loops[0];
    const origin = outer[0];
    const normal = normalize(face.normal);
    const refDir = normalize(subtract(outer[1], outer[0]));
    const planeId = this.entity(`PLANE('',#${this.placement(origin, normal, refDir)})`);
    const bounds = face.loops.map((loop, index) => {
      const loopId = this.loop(loop);
      return index === 0
        ? this.entity(`FACE_OUTER_BOUND('',#${loopId},.T.)`)
        : this.entity(`FACE_BOUND('',#${loopId},.T.)`);
    });
    return this.entity(
      `ADVANCED_FACE('${face.name ?? ''}',(${bounds.map((id) => `#${id}`).join(',')}),#${planeId},.T.)`,
    );
  }

  /**
   * @param {{name: string, faces: object[]}[]} solids
   */
  build(solids, productName = 'Model') {
    const header = [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('DocuView test fixture'),'2;1');",
      `FILE_NAME('${productName}','${new Date().toISOString().slice(0, 19)}',('DocuView'),('DocuView'),'DocuView StepBuilder','','');`,
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
      'ENDSEC;',
      'DATA;',
    ];

    // Application + product structure.
    const appContext = this.entity(
      "APPLICATION_CONTEXT('core data for automotive mechanical design processes')",
    );
    this.entity(
      `APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appContext})`,
    );
    const productContext = this.entity(`PRODUCT_CONTEXT('',#${appContext},'mechanical')`);
    const productDefContext = this.entity(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appContext},'design')`);
    const product = this.entity(`PRODUCT('${productName}','${productName}','',(#${productContext}))`);
    const formation = this.entity(`PRODUCT_DEFINITION_FORMATION('','',#${product})`);
    const productDef = this.entity(
      `PRODUCT_DEFINITION('design','',#${formation},#${productDefContext})`,
    );
    const productDefShape = this.entity(`PRODUCT_DEFINITION_SHAPE('','',#${productDef})`);

    // Units and geometric context.
    const lengthUnit = this.entity('( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )');
    const angleUnit = this.entity('( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )');
    const solidAngleUnit = this.entity('( NAMED_UNIT(*) SOLID_ANGLE_UNIT() SI_UNIT($,.STERADIAN.) )');
    const uncertainty = this.entity(
      `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#${lengthUnit},'distance_accuracy_value','confusion accuracy')`,
    );
    const context = this.entity(
      `( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertainty})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lengthUnit},#${angleUnit},#${solidAngleUnit})) REPRESENTATION_CONTEXT('Context','3D') )`,
    );

    const worldAxis = this.placement([0, 0, 0], [0, 0, 1], [1, 0, 0]);

    const brepIds = [];
    for (const solid of solids) {
      const faceIds = solid.faces.map((face) => this.face(face));
      const shell = this.entity(`CLOSED_SHELL('',(${faceIds.map((id) => `#${id}`).join(',')}))`);
      brepIds.push(this.entity(`MANIFOLD_SOLID_BREP('${solid.name}',#${shell})`));
    }

    const shapeRep = this.entity(
      `ADVANCED_BREP_SHAPE_REPRESENTATION('${productName}',(#${worldAxis},${brepIds
        .map((id) => `#${id}`)
        .join(',')}),#${context})`,
    );
    this.entity(`SHAPE_DEFINITION_REPRESENTATION(#${productDefShape},#${shapeRep})`);

    return [...header, ...this.lines, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
  }
  /**
   * Emit a real STEP assembly: one PRODUCT per component, tied together with
   * NEXT_ASSEMBLY_USAGE_OCCURRENCE. This is what makes component *names* travel
   * with the file — solids sitting loose in one shape representation arrive
   * unnamed no matter what you call the MANIFOLD_SOLID_BREP.
   *
   * @param {{name: string, faces: object[]}[]} components
   */
  buildAssembly(components, assemblyName = 'Assembly') {
    const header = [
      'ISO-10303-21;',
      'HEADER;',
      "FILE_DESCRIPTION(('DocuView test fixture - assembly'),'2;1');",
      `FILE_NAME('${assemblyName}','${new Date().toISOString().slice(0, 19)}',('DocuView'),('DocuView'),'DocuView StepBuilder','','');`,
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
      'ENDSEC;',
      'DATA;',
    ];

    const appContext = this.entity(
      "APPLICATION_CONTEXT('core data for automotive mechanical design processes')",
    );
    this.entity(
      `APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appContext})`,
    );
    const productContext = this.entity(`PRODUCT_CONTEXT('',#${appContext},'mechanical')`);
    const productDefContext = this.entity(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appContext},'design')`);

    const lengthUnit = this.entity('( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )');
    const angleUnit = this.entity('( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )');
    const solidAngleUnit = this.entity('( NAMED_UNIT(*) SOLID_ANGLE_UNIT() SI_UNIT($,.STERADIAN.) )');
    const uncertainty = this.entity(
      `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#${lengthUnit},'distance_accuracy_value','confusion accuracy')`,
    );
    const context = this.entity(
      `( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertainty})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lengthUnit},#${angleUnit},#${solidAngleUnit})) REPRESENTATION_CONTEXT('Context','3D') )`,
    );

    /** One product definition plus its shape representation. */
    const defineProduct = (name, brepIds) => {
      const product = this.entity(`PRODUCT('${name}','${name}','',(#${productContext}))`);
      const formation = this.entity(`PRODUCT_DEFINITION_FORMATION('','',#${product})`);
      const definition = this.entity(`PRODUCT_DEFINITION('design','',#${formation},#${productDefContext})`);
      const definitionShape = this.entity(`PRODUCT_DEFINITION_SHAPE('','',#${definition})`);
      this.entity(`PRODUCT_RELATED_PRODUCT_CATEGORY('part','',(#${product}))`);
      const axis = this.placement([0, 0, 0], [0, 0, 1], [1, 0, 0]);
      const items = [`#${axis}`, ...brepIds.map((id) => `#${id}`)].join(',');
      const shapeRep = this.entity(
        brepIds.length > 0
          ? `ADVANCED_BREP_SHAPE_REPRESENTATION('${name}',(${items}),#${context})`
          : `SHAPE_REPRESENTATION('${name}',(${items}),#${context})`,
      );
      this.entity(`SHAPE_DEFINITION_REPRESENTATION(#${definitionShape},#${shapeRep})`);
      return { definition, shapeRep, axis };
    };

    const assembly = defineProduct(assemblyName, []);

    components.forEach((component, index) => {
      const faceIds = component.faces.map((face) => this.face(face));
      const shell = this.entity(`CLOSED_SHELL('',(${faceIds.map((id) => `#${id}`).join(',')}))`);
      const brep = this.entity(`MANIFOLD_SOLID_BREP('${component.name}',#${shell})`);
      const part = defineProduct(component.name, [brep]);

      // Geometry is already authored in assembly coordinates, so the occurrence
      // transform is the identity — the point of the structure here is naming.
      const occurrence = this.entity(
        `NEXT_ASSEMBLY_USAGE_OCCURRENCE('${index + 1}','${component.name}','',#${assembly.definition},#${part.definition},$)`,
      );
      const occurrenceShape = this.entity(`PRODUCT_DEFINITION_SHAPE('','',#${occurrence})`);
      const transform = this.entity(
        `ITEM_DEFINED_TRANSFORMATION('','',#${assembly.axis},#${part.axis})`,
      );
      const relationship = this.entity(
        `( REPRESENTATION_RELATIONSHIP('','',#${part.shapeRep},#${assembly.shapeRep}) REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#${transform}) SHAPE_REPRESENTATION_RELATIONSHIP() )`,
      );
      this.entity(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#${relationship},#${occurrenceShape})`);
    });

    return [...header, ...this.lines, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');
  }
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function normalize(v) {
  const length = Math.hypot(...v);
  return v.map((component) => component / length);
}

/* ------------------------------- primitives ------------------------------- */

/** Axis-aligned box from `min` to `max`, with outward-facing planar faces. */
export function boxFaces(min, max, prefix = '') {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const p = (x, y, z) => [x, y, z];
  return [
    // -Z (bottom): CCW seen from below.
    { name: `${prefix}bottom`, normal: [0, 0, -1], loops: [[p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), p(x1, y0, z0)]] },
    // +Z (top): CCW seen from above.
    { name: `${prefix}top`, normal: [0, 0, 1], loops: [[p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)]] },
    { name: `${prefix}front`, normal: [0, -1, 0], loops: [[p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)]] },
    { name: `${prefix}back`, normal: [0, 1, 0], loops: [[p(x1, y1, z0), p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1)]] },
    { name: `${prefix}left`, normal: [-1, 0, 0], loops: [[p(x0, y1, z0), p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1)]] },
    { name: `${prefix}right`, normal: [1, 0, 0], loops: [[p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)]] },
  ];
}

/**
 * Box with a rectangular through-hole along Z.
 *
 * This is the fixture that proves sectioning handles hollow parts: a cut across
 * the hole must show an interrupted cap, not a solid slab.
 */
export function hollowBoxFaces(min, max, hole) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const [hx0, hy0] = hole.min;
  const [hx1, hy1] = hole.max;
  const p = (x, y, z) => [x, y, z];

  const outerBottom = [p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), p(x1, y0, z0)];
  const outerTop = [p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)];
  // Hole loops run opposite to the outer loop of the same face.
  const holeBottom = [p(hx0, hy0, z0), p(hx1, hy0, z0), p(hx1, hy1, z0), p(hx0, hy1, z0)];
  const holeTop = [p(hx0, hy0, z1), p(hx0, hy1, z1), p(hx1, hy1, z1), p(hx1, hy0, z1)];

  return [
    { name: 'bottom', normal: [0, 0, -1], loops: [outerBottom, holeBottom] },
    { name: 'top', normal: [0, 0, 1], loops: [outerTop, holeTop] },
    { name: 'front', normal: [0, -1, 0], loops: [[p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)]] },
    { name: 'back', normal: [0, 1, 0], loops: [[p(x1, y1, z0), p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1)]] },
    { name: 'left', normal: [-1, 0, 0], loops: [[p(x0, y1, z0), p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1)]] },
    { name: 'right', normal: [1, 0, 0], loops: [[p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)]] },
    // Hole walls: normals point into the cavity.
    { name: 'bore-front', normal: [0, 1, 0], loops: [[p(hx1, hy0, z0), p(hx0, hy0, z0), p(hx0, hy0, z1), p(hx1, hy0, z1)]] },
    { name: 'bore-back', normal: [0, -1, 0], loops: [[p(hx0, hy1, z0), p(hx1, hy1, z0), p(hx1, hy1, z1), p(hx0, hy1, z1)]] },
    { name: 'bore-left', normal: [1, 0, 0], loops: [[p(hx0, hy0, z0), p(hx0, hy1, z0), p(hx0, hy1, z1), p(hx0, hy0, z1)]] },
    { name: 'bore-right', normal: [-1, 0, 0], loops: [[p(hx1, hy1, z0), p(hx1, hy0, z0), p(hx1, hy0, z1), p(hx1, hy1, z1)]] },
  ];
}
