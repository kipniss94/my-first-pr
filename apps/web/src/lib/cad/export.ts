import * as THREE from 'three';
import { Zip, ZipDeflate, strToU8 } from 'three/examples/jsm/libs/fflate.module.js';
import type { CadModel, CadPart } from './types';

/**
 * Saving the model on screen in other formats: for 3D printing (STL, 3MF),
 * for other CAD systems (STEP), and for everything else (OBJ, PLY, glTF).
 *
 * Everything is written from the triangles the viewer shows, so a STEP made
 * here is faceted — flat faces where the original had curved ones. Where the
 * exact solid is known (a Parasolid stream read from a SOLIDWORKS file) the
 * viewer offers that as well.
 */

export type ExportFormat = 'step' | 'stl' | '3mf' | 'obj' | 'ply' | 'glb';

export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  step: 'step',
  stl: 'stl',
  '3mf': '3mf',
  obj: 'obj',
  ply: 'ply',
  glb: 'glb',
};

const MIME: Record<ExportFormat, string> = {
  step: 'model/step',
  stl: 'model/stl',
  '3mf': 'model/3mf',
  obj: 'model/obj',
  ply: 'application/octet-stream',
  glb: 'model/gltf-binary',
};

/** One part, its vertices shared between the triangles that meet there. */
export interface ExportMesh {
  name: string;
  /** x, y, z per vertex, in millimetres, in the model's own coordinates. */
  positions: Float64Array;
  /** Three vertex indices per triangle, counter-clockwise seen from outside. */
  triangles: Uint32Array;
  /** The part's colour, 0..1. */
  color: [number, number, number];
  /** r, g, b (0..255) per triangle when the faces are coloured one by one. */
  triangleColors: Uint8Array | null;
  /** The CAD face each triangle was tessellated from, when known. */
  faceIds: Int32Array | null;
}

/** Millimetres per model unit. */
function millimetres(units: string): number {
  switch (units.trim().toLowerCase()) {
    case 'm':
      return 1000;
    case 'cm':
      return 10;
    case 'in':
    case 'inch':
      return 25.4;
    case 'ft':
      return 304.8;
    case 'um':
    case 'µm':
      return 0.001;
    default:
      return 1;
  }
}

/**
 * The triangles of `parts` in model coordinates and millimetres. Vertices
 * that coincide are joined, so a closed solid comes out closed — what slicers
 * and CAD importers look for — and triangles that collapse are dropped.
 */
export function collectMeshes(model: CadModel, parts: CadPart[], colorOf: (part: CadPart) => THREE.Color): ExportMesh[] {
  model.root.updateMatrixWorld(true);
  const toModel = model.root.matrixWorld.clone().invert();
  const scale = millimetres(model.units);
  const meshes: ExportMesh[] = [];
  const point = new THREE.Vector3();

  for (const part of parts) {
    const geometry = part.mesh.geometry;
    const position = geometry.getAttribute('position');
    if (!position || position.count === 0) continue;
    const index = geometry.getIndex();
    const colours = geometry.getAttribute('color');
    const matrix = new THREE.Matrix4().multiplyMatrices(toModel, part.mesh.matrixWorld);
    // A mirrored placement turns the triangles inside out unless they are reversed.
    const mirrored = matrix.determinant() < 0;

    geometry.computeBoundingBox();
    const size = geometry.boundingBox!.getSize(new THREE.Vector3()).length() * scale;
    // Points closer than this are one point: far below any print or CAD tolerance.
    const step = Math.max(size * 1e-9, 1e-7);

    const welded = new Map<string, number>();
    const remap = new Int32Array(position.count);
    const coords: number[] = [];
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      point.fromBufferAttribute(position, vertex).applyMatrix4(matrix).multiplyScalar(scale);
      const key = `${Math.round(point.x / step)},${Math.round(point.y / step)},${Math.round(point.z / step)}`;
      let id = welded.get(key);
      if (id === undefined) {
        id = coords.length / 3;
        coords.push(point.x, point.y, point.z);
        welded.set(key, id);
      }
      remap[vertex] = id;
    }

    const faceOf = faceIndexOf(part.faceRanges);
    const count = index ? index.count / 3 : position.count / 3;
    const triangles: number[] = [];
    const triangleColors: number[] = [];
    const faceIds: number[] = [];
    for (let triangle = 0; triangle < count; triangle += 1) {
      const a = index ? index.getX(triangle * 3) : triangle * 3;
      const b = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1;
      const c = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2;
      const wa = remap[a];
      const wb = remap[mirrored ? c : b];
      const wc = remap[mirrored ? b : c];
      if (wa === wb || wb === wc || wa === wc) continue;
      triangles.push(wa, wb, wc);
      if (colours) {
        triangleColors.push(byte(colours.getX(a)), byte(colours.getY(a)), byte(colours.getZ(a)));
      }
      if (faceOf) faceIds.push(faceOf(triangle));
    }
    if (triangles.length === 0) continue;

    const color = colorOf(part);
    meshes.push({
      name: part.name || part.id,
      positions: new Float64Array(coords),
      triangles: new Uint32Array(triangles),
      color: [color.r, color.g, color.b],
      triangleColors: colours ? new Uint8Array(triangleColors) : null,
      faceIds: faceOf ? new Int32Array(faceIds) : null,
    });
  }
  return meshes;
}

function byte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

function faceIndexOf(ranges: number[] | undefined): ((triangle: number) => number) | null {
  if (!ranges || ranges.length < 2) return null;
  const lookup = new Map<number, number>();
  for (let face = 0; face * 2 + 1 < ranges.length; face += 1) {
    for (let triangle = ranges[face * 2]; triangle <= ranges[face * 2 + 1]; triangle += 1) lookup.set(triangle, face);
  }
  return (triangle) => lookup.get(triangle) ?? -1;
}

export interface ExportResult {
  blob: Blob;
  /** Set when a STEP was written from fewer triangles than the model has. */
  simplified: { from: number; to: number; tolerance: number } | null;
}

/** Build the file. Large models take a moment; the caller shows that. */
export async function exportMeshes(meshes: ExportMesh[], format: ExportFormat, name: string): Promise<ExportResult> {
  const type = MIME[format];
  switch (format) {
    case 'stl':
      return { blob: new Blob([writeStl(meshes, name)], { type }), simplified: null };
    case '3mf':
      return { blob: new Blob(await write3mf(meshes, name), { type }), simplified: null };
    case 'obj':
      return { blob: new Blob(writeObj(meshes, name), { type }), simplified: null };
    case 'ply':
      return { blob: new Blob(writePly(meshes, name), { type }), simplified: null };
    case 'glb':
      return { blob: new Blob([await writeGlb(meshes)], { type }), simplified: null };
    case 'step': {
      const { meshes: lighter, simplified } = await forStep(meshes);
      return { blob: new Blob(writeStep(lighter, name), { type }), simplified };
    }
  }
}

/* ---------------------------------- STL ---------------------------------- */

/** Binary STL: what every slicer reads. No units in the format; millimetres by custom. */
function writeStl(meshes: ExportMesh[], name: string): ArrayBuffer {
  const total = meshes.reduce((sum, mesh) => sum + mesh.triangles.length / 3, 0);
  const buffer = new ArrayBuffer(84 + total * 50);
  const view = new DataView(buffer);
  const header = `DocuView export: ${ascii(name)}`.slice(0, 80);
  for (let i = 0; i < header.length; i += 1) view.setUint8(i, header.charCodeAt(i));
  view.setUint32(80, total, true);
  let offset = 84;
  const normal = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (const mesh of meshes) {
    const { positions, triangles } = mesh;
    for (let t = 0; t < triangles.length; t += 3) {
      a.fromArray(positions, triangles[t] * 3);
      b.fromArray(positions, triangles[t + 1] * 3);
      c.fromArray(positions, triangles[t + 2] * 3);
      normal.subVectors(c, b).cross(a.clone().sub(b)).normalize();
      for (const value of [normal.x, normal.y, normal.z, a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z]) {
        view.setFloat32(offset, value, true);
        offset += 4;
      }
      view.setUint16(offset, 0, true);
      offset += 2;
    }
  }
  return buffer;
}

/* ---------------------------------- 3MF ---------------------------------- */

/**
 * 3MF: the 3D printing format with units, colours and separate objects. Each
 * part is an object of its own, coloured from the model.
 */
async function write3mf(meshes: ExportMesh[], name: string): Promise<Uint8Array<ArrayBuffer>[]> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let failure: Error | null = null;
  const zip = new Zip((error, data) => {
    if (error) failure = error;
    // Zip hands out fresh buffers of its own.
    else chunks.push(data as Uint8Array<ArrayBuffer>);
  });
  const add = (path: string, parts: Iterable<string>) => {
    const file = new ZipDeflate(path, { level: 6 });
    zip.add(file);
    let pending = '';
    for (const part of parts) {
      pending += part;
      if (pending.length > 1 << 20) {
        file.push(strToU8(pending), false);
        pending = '';
      }
    }
    file.push(strToU8(pending), true);
  };

  add('[Content_Types].xml', [
    '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
      '</Types>',
  ]);
  add('_rels/.rels', [
    '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
      '</Relationships>',
  ]);
  add('3D/3dmodel.model', model3mf(meshes, name));
  zip.end();
  if (failure) throw failure;
  return chunks;
}

function* model3mf(meshes: ExportMesh[], name: string): Generator<string> {
  // One palette: every part's colour, then each face colour in use.
  const palette = new Map<string, number>();
  const swatch = (r: number, g: number, b: number) => {
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    let index = palette.get(hex);
    if (index === undefined) {
      index = palette.size;
      palette.set(hex, index);
    }
    return index;
  };
  const partSwatch = meshes.map((mesh) => swatch(byte(mesh.color[0]), byte(mesh.color[1]), byte(mesh.color[2])));
  const faceSwatch = meshes.map((mesh) => {
    if (!mesh.triangleColors) return null;
    const colours = mesh.triangleColors;
    const result = new Int32Array(colours.length / 3);
    for (let t = 0; t < result.length; t += 1) result[t] = swatch(colours[t * 3], colours[t * 3 + 1], colours[t * 3 + 2]);
    return result;
  });

  yield '<?xml version="1.0" encoding="UTF-8"?>\n';
  yield '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n';
  yield ` <metadata name="Title">${xml(name)}</metadata>\n <metadata name="Application">DocuView</metadata>\n`;
  yield ' <resources>\n  <basematerials id="1">\n';
  for (const [hex, index] of palette) yield `   <base name="Colour ${index + 1}" displaycolor="${hex}"/>\n`;
  yield '  </basematerials>\n';
  for (let m = 0; m < meshes.length; m += 1) {
    const mesh = meshes[m];
    yield `  <object id="${m + 2}" type="model" name="${xml(mesh.name)}" pid="1" pindex="${partSwatch[m]}">\n   <mesh>\n    <vertices>\n`;
    const { positions, triangles } = mesh;
    let lines: string[] = [];
    for (let v = 0; v < positions.length; v += 3) {
      lines.push(`     <vertex x="${fixed(positions[v])}" y="${fixed(positions[v + 1])}" z="${fixed(positions[v + 2])}"/>\n`);
      if (lines.length >= 4096) {
        yield lines.join('');
        lines = [];
      }
    }
    yield lines.join('');
    yield '    </vertices>\n    <triangles>\n';
    lines = [];
    const faces = faceSwatch[m];
    for (let t = 0; t < triangles.length; t += 3) {
      const colour = faces && faces[t / 3] !== partSwatch[m] ? ` pid="1" p1="${faces[t / 3]}"` : '';
      lines.push(`     <triangle v1="${triangles[t]}" v2="${triangles[t + 1]}" v3="${triangles[t + 2]}"${colour}/>\n`);
      if (lines.length >= 4096) {
        yield lines.join('');
        lines = [];
      }
    }
    yield lines.join('');
    yield '    </triangles>\n   </mesh>\n  </object>\n';
  }
  yield ' </resources>\n <build>\n';
  for (let m = 0; m < meshes.length; m += 1) yield `  <item objectid="${m + 2}"/>\n`;
  yield ' </build>\n</model>\n';
}

/* ---------------------------------- OBJ ---------------------------------- */

/** Wavefront OBJ, one object per part, colours as the common `v x y z r g b`. */
function writeObj(meshes: ExportMesh[], name: string): string[] {
  const out: string[] = [`# ${ascii(name)}\n# Exported by DocuView, millimetres\n`];
  let base = 1;
  for (const mesh of meshes) {
    const { positions, triangles } = mesh;
    const colours = vertexColours(mesh);
    let lines: string[] = [`o ${mesh.name.replace(/\s+/g, '_')}\n`];
    for (let v = 0; v < positions.length / 3; v += 1) {
      lines.push(
        `v ${fixed(positions[v * 3])} ${fixed(positions[v * 3 + 1])} ${fixed(positions[v * 3 + 2])} ` +
          `${(colours[v * 3] / 255).toFixed(3)} ${(colours[v * 3 + 1] / 255).toFixed(3)} ${(colours[v * 3 + 2] / 255).toFixed(3)}\n`,
      );
      if (lines.length >= 4096) {
        out.push(lines.join(''));
        lines = [];
      }
    }
    for (let t = 0; t < triangles.length; t += 3) {
      lines.push(`f ${triangles[t] + base} ${triangles[t + 1] + base} ${triangles[t + 2] + base}\n`);
      if (lines.length >= 4096) {
        out.push(lines.join(''));
        lines = [];
      }
    }
    out.push(lines.join(''));
    base += positions.length / 3;
  }
  return out;
}

/** A colour per vertex: the part's, or the last face colour to touch it. */
function vertexColours(mesh: ExportMesh): Uint8Array {
  const count = mesh.positions.length / 3;
  const colours = new Uint8Array(count * 3);
  const [r, g, b] = mesh.color.map(byte);
  for (let v = 0; v < count; v += 1) colours.set([r, g, b], v * 3);
  if (mesh.triangleColors) {
    for (let t = 0; t < mesh.triangles.length; t += 1) {
      const face = Math.floor(t / 3);
      colours.set(mesh.triangleColors.subarray(face * 3, face * 3 + 3), mesh.triangles[t] * 3);
    }
  }
  return colours;
}

/* ---------------------------------- PLY ---------------------------------- */

/** Binary PLY with vertex colours, all parts in one mesh. */
function writePly(meshes: ExportMesh[], name: string): BlobPart[] {
  const vertices = meshes.reduce((sum, mesh) => sum + mesh.positions.length / 3, 0);
  const faces = meshes.reduce((sum, mesh) => sum + mesh.triangles.length / 3, 0);
  const header =
    'ply\nformat binary_little_endian 1.0\n' +
    `comment ${ascii(name)}\ncomment Exported by DocuView, millimetres\n` +
    `element vertex ${vertices}\nproperty float x\nproperty float y\nproperty float z\n` +
    'property uchar red\nproperty uchar green\nproperty uchar blue\n' +
    `element face ${faces}\nproperty list uchar int vertex_indices\nend_header\n`;
  const vertexData = new DataView(new ArrayBuffer(vertices * 15));
  const faceData = new DataView(new ArrayBuffer(faces * 13));
  let vo = 0;
  let fo = 0;
  let base = 0;
  for (const mesh of meshes) {
    const colours = vertexColours(mesh);
    const count = mesh.positions.length / 3;
    for (let v = 0; v < count; v += 1) {
      vertexData.setFloat32(vo, mesh.positions[v * 3], true);
      vertexData.setFloat32(vo + 4, mesh.positions[v * 3 + 1], true);
      vertexData.setFloat32(vo + 8, mesh.positions[v * 3 + 2], true);
      vertexData.setUint8(vo + 12, colours[v * 3]);
      vertexData.setUint8(vo + 13, colours[v * 3 + 1]);
      vertexData.setUint8(vo + 14, colours[v * 3 + 2]);
      vo += 15;
    }
    for (let t = 0; t < mesh.triangles.length; t += 3) {
      faceData.setUint8(fo, 3);
      faceData.setInt32(fo + 1, mesh.triangles[t] + base, true);
      faceData.setInt32(fo + 5, mesh.triangles[t + 1] + base, true);
      faceData.setInt32(fo + 9, mesh.triangles[t + 2] + base, true);
      fo += 13;
    }
    base += count;
  }
  return [header, vertexData.buffer, faceData.buffer];
}

/* ---------------------------------- glTF --------------------------------- */

/** Binary glTF: metres and Y up, as the format asks; one node per part. */
async function writeGlb(meshes: ExportMesh[]): Promise<ArrayBuffer> {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const root = new THREE.Group();
  root.name = 'Model';
  // Millimetres to metres, and the CAD Z up turned to glTF's Y up.
  root.scale.setScalar(0.001);
  root.rotation.x = -Math.PI / 2;
  const disposables: Array<{ dispose(): void }> = [];
  for (const mesh of meshes) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mesh.positions), 3));
    geometry.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
    if (mesh.triangleColors) {
      const colours = vertexColours(mesh);
      geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(Array.from(colours, (v) => v / 255)), 3));
    }
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(...mesh.color),
      vertexColors: Boolean(mesh.triangleColors),
      metalness: 0.1,
      roughness: 0.6,
    });
    const node = new THREE.Mesh(geometry, material);
    node.name = mesh.name;
    root.add(node);
    disposables.push(geometry, material);
  }
  try {
    const result = await new GLTFExporter().parseAsync(root, { binary: true });
    return result as ArrayBuffer;
  } finally {
    disposables.forEach((item) => item.dispose());
  }
}

/* ---------------------------------- STEP --------------------------------- */

/**
 * A STEP face costs most of a kilobyte, so a finely tessellated part (a
 * million triangles is common) would make a file of a gigabyte. Above
 * STEP_TRIANGLES the mesh is simplified first: never moving the surface by
 * more than the first tolerance that brings it near the budget.
 */
const STEP_TRIANGLES = 250_000;
const STEP_TOLERANCES = [0.01, 0.02, 0.05]; // mm

async function forStep(meshes: ExportMesh[]): Promise<{ meshes: ExportMesh[]; simplified: ExportResult['simplified'] }> {
  const total = meshes.reduce((sum, mesh) => sum + mesh.triangles.length / 3, 0);
  if (total <= STEP_TRIANGLES) return { meshes, simplified: null };
  const { MeshoptSimplifier } = await import('three/examples/jsm/libs/meshopt_simplifier.module.js');
  await MeshoptSimplifier.ready;
  const share = STEP_TRIANGLES / total;
  const inputs = meshes.map((mesh) => ({ indices: new Uint32Array(mesh.triangles), positions: new Float32Array(mesh.positions) }));
  let result: ExportMesh[] = meshes;
  let after = total;
  let tolerance = 0;
  for (const step of STEP_TOLERANCES) {
    tolerance = step;
    after = 0;
    result = meshes.map((mesh, index) => {
      const count = mesh.triangles.length / 3;
      if (count < 64) {
        after += count;
        return mesh;
      }
      const target = Math.max(12, Math.round(count * share)) * 3;
      const [triangles] = MeshoptSimplifier.simplify(inputs[index].indices, inputs[index].positions, 3, target, step, [
        'ErrorAbsolute',
        'LockBorder',
      ]);
      after += triangles.length / 3;
      // Which CAD face a triangle came from does not survive the collapses.
      return { ...mesh, triangles, triangleColors: null, faceIds: null };
    });
    if (after <= STEP_TRIANGLES * 1.25) break;
  }
  return { meshes: result, simplified: { from: total, to: after, tolerance } };
}

/**
 * STEP AP214 with each part as a solid of flat faces. Neighbouring triangles
 * in one plane (and one CAD face) become one face, holes and all, so a box
 * comes out as six faces rather than twelve triangles. A closed part is a
 * solid (MANIFOLD_SOLID_BREP); one with gaps is a surface model. Several
 * parts make an assembly, each part named and coloured.
 */
function writeStep(meshes: ExportMesh[], name: string): string[] {
  const writer = new StepWriter();
  const { context, productContext, definitionContext } = writer.contexts();

  const defineProduct = (productName: string) => {
    const label = writer.text(productName);
    const product = writer.add(`PRODUCT(${label},${label},'',(#${productContext}))`);
    writer.add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part','',(#${product}))`);
    const formation = writer.add(`PRODUCT_DEFINITION_FORMATION('','',#${product})`);
    const definition = writer.add(`PRODUCT_DEFINITION('design','',#${formation},#${definitionContext})`);
    const shape = writer.add(`PRODUCT_DEFINITION_SHAPE('','',#${definition})`);
    const axis = writer.placement([0, 0, 0], [0, 0, 1], [1, 0, 0]);
    return { definition, shape, axis };
  };

  const styled: number[] = [];
  const parts = meshes.map((mesh) => {
    const product = defineProduct(mesh.name);
    const { item, closed } = writer.body(mesh);
    const representation = writer.add(
      closed
        ? `ADVANCED_BREP_SHAPE_REPRESENTATION(${writer.text(mesh.name)},(#${product.axis},#${item}),#${context})`
        : `MANIFOLD_SURFACE_SHAPE_REPRESENTATION(${writer.text(mesh.name)},(#${product.axis},#${item}),#${context})`,
    );
    writer.add(`SHAPE_DEFINITION_REPRESENTATION(#${product.shape},#${representation})`);
    styled.push(writer.style(item, mesh.color));
    return { product, representation };
  });

  if (parts.length > 1) {
    const assembly = defineProduct(name);
    const representation = writer.add(`SHAPE_REPRESENTATION(${writer.text(name)},(#${assembly.axis}),#${context})`);
    writer.add(`SHAPE_DEFINITION_REPRESENTATION(#${assembly.shape},#${representation})`);
    parts.forEach((part, index) => {
      // The parts are written where they sit, so each occurrence is the identity.
      const occurrence = writer.add(
        `NEXT_ASSEMBLY_USAGE_OCCURRENCE('${index + 1}',${writer.text(meshes[index].name)},'',#${assembly.definition},#${part.product.definition},$)`,
      );
      const occurrenceShape = writer.add(`PRODUCT_DEFINITION_SHAPE('','',#${occurrence})`);
      const transform = writer.add(`ITEM_DEFINED_TRANSFORMATION('','',#${assembly.axis},#${part.product.axis})`);
      const relationship = writer.add(
        `( REPRESENTATION_RELATIONSHIP('','',#${part.representation},#${representation}) REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#${transform}) SHAPE_REPRESENTATION_RELATIONSHIP() )`,
      );
      writer.add(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#${relationship},#${occurrenceShape})`);
    });
  }
  writer.add(
    `MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${styled.map((id) => `#${id}`).join(',')}),#${context})`,
  );
  return writer.finish(name);
}

class StepWriter {
  private lines: string[] = [];
  private chunks: string[] = [];
  private next = 1;
  private directions = new Map<string, number>();

  add(text: string): number {
    const id = this.next++;
    this.lines.push(`#${id}=${text};\n`);
    if (this.lines.length >= 8192) this.flush();
    return id;
  }

  private flush() {
    this.chunks.push(this.lines.join(''));
    this.lines = [];
  }

  /** A STEP string: quotes doubled, anything outside ASCII as \X2\ UTF-16. */
  text(value: string): string {
    let out = '';
    let wide = '';
    for (const char of value) {
      const code = char.codePointAt(0)!;
      if (code >= 0x20 && code <= 0x7e) {
        if (wide) {
          out += `\\X2\\${wide}\\X0\\`;
          wide = '';
        }
        out += char === "'" ? "''" : char === '\\' ? '\\\\' : char;
      } else {
        for (let i = 0; i < char.length; i += 1) wide += char.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
      }
    }
    if (wide) out += `\\X2\\${wide}\\X0\\`;
    return `'${out}'`;
  }

  point(p: ArrayLike<number>): number {
    return this.add(`CARTESIAN_POINT('',(${real(p[0])},${real(p[1])},${real(p[2])}))`);
  }

  direction(d: ArrayLike<number>): number {
    const key = `${d[0].toFixed(9)},${d[1].toFixed(9)},${d[2].toFixed(9)}`;
    let id = this.directions.get(key);
    if (id === undefined) {
      // Eight digits: a ten-thousandth of a micron over a metre.
      id = this.add(`DIRECTION('',(${real(d[0], 8)},${real(d[1], 8)},${real(d[2], 8)}))`);
      this.directions.set(key, id);
    }
    return id;
  }

  placement(origin: ArrayLike<number>, axis: ArrayLike<number>, reference: ArrayLike<number>): number {
    return this.placementAt(this.point(origin), axis, reference);
  }

  placementAt(point: number, axis: ArrayLike<number>, reference: ArrayLike<number>): number {
    return this.add(`AXIS2_PLACEMENT_3D('',#${point},#${this.direction(axis)},#${this.direction(reference)})`);
  }

  contexts() {
    const application = this.add("APPLICATION_CONTEXT('core data for automotive mechanical design processes')");
    this.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${application})`);
    const productContext = this.add(`PRODUCT_CONTEXT('',#${application},'mechanical')`);
    const definitionContext = this.add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${application},'design')`);
    const length = this.add('( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )');
    const angle = this.add('( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )');
    const solidAngle = this.add('( NAMED_UNIT(*) SOLID_ANGLE_UNIT() SI_UNIT($,.STERADIAN.) )');
    const uncertainty = this.add(
      `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),#${length},'distance_accuracy_value','confusion accuracy')`,
    );
    const context = this.add(
      `( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertainty})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${length},#${angle},#${solidAngle})) REPRESENTATION_CONTEXT('Context','3D') )`,
    );
    return { context, productContext, definitionContext };
  }

  /** A part's faces, edges and vertices; the solid (or surface model) holding them. */
  body(mesh: ExportMesh): { item: number; closed: boolean } {
    const { positions } = mesh;
    // One point per vertex, shared by the vertex, the lines from it and the planes through it.
    const pointIds = new Map<number, number>();
    const pointOf = (v: number) => {
      let id = pointIds.get(v);
      if (id === undefined) {
        id = this.point(positions.subarray(v * 3, v * 3 + 3));
        pointIds.set(v, id);
      }
      return id;
    };
    const vertexIds = new Map<number, number>();
    const vertex = (v: number) => {
      let id = vertexIds.get(v);
      if (id === undefined) {
        id = this.add(`VERTEX_POINT('',#${pointOf(v)})`);
        vertexIds.set(v, id);
      }
      return id;
    };
    // An edge is written once, from its lower vertex to its higher one.
    const edgeIds = new Map<number, number>();
    const count = positions.length / 3;
    const edge = (a: number, b: number) => {
      const from = Math.min(a, b);
      const to = Math.max(a, b);
      const key = from * count + to;
      let id = edgeIds.get(key);
      if (id === undefined) {
        const dx = positions[to * 3] - positions[from * 3];
        const dy = positions[to * 3 + 1] - positions[from * 3 + 1];
        const dz = positions[to * 3 + 2] - positions[from * 3 + 2];
        const length = Math.hypot(dx, dy, dz);
        const vector = this.add(`VECTOR('',#${this.direction([dx / length, dy / length, dz / length])},${real(length)})`);
        const line = this.add(`LINE('',#${pointOf(from)},#${vector})`);
        id = this.add(`EDGE_CURVE('',#${vertex(from)},#${vertex(to)},#${line},.T.)`);
        edgeIds.set(key, id);
      }
      return `#${this.add(`ORIENTED_EDGE('',*,*,#${id},${a === from ? '.T.' : '.F.'})`)}`;
    };

    const faces: number[] = [];
    for (const face of planarFaces(mesh)) {
      const bounds = face.loops.map((loop, index) => {
        const oriented = loop.map((v, i) => edge(v, loop[(i + 1) % loop.length]));
        const edgeLoop = this.add(`EDGE_LOOP('',(${oriented.join(',')}))`);
        return `#${this.add(`${index === 0 ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',#${edgeLoop},.T.)`)}`;
      });
      const plane = this.add(`PLANE('',#${this.placementAt(pointOf(face.loops[0][0]), face.normal, face.reference)})`);
      faces.push(this.add(`ADVANCED_FACE('',(${bounds.join(',')}),#${plane},.T.)`));
    }

    const list = faces.map((id) => `#${id}`).join(',');
    const closed = isClosed(mesh.triangles);
    if (closed) {
      const shell = this.add(`CLOSED_SHELL('',(${list}))`);
      return { item: this.add(`MANIFOLD_SOLID_BREP(${this.text(mesh.name)},#${shell})`), closed };
    }
    const shell = this.add(`OPEN_SHELL('',(${list}))`);
    return { item: this.add(`SHELL_BASED_SURFACE_MODEL(${this.text(mesh.name)},(#${shell}))`), closed };
  }

  /** The colour other CAD systems show the part in. */
  style(item: number, [r, g, b]: [number, number, number]): number {
    const colour = this.add(`COLOUR_RGB('',${real(r)},${real(g)},${real(b)})`);
    const fillColour = this.add(`FILL_AREA_STYLE_COLOUR('',#${colour})`);
    const fill = this.add(`FILL_AREA_STYLE('',(#${fillColour}))`);
    const surfaceFill = this.add(`SURFACE_STYLE_FILL_AREA(#${fill})`);
    const side = this.add(`SURFACE_SIDE_STYLE('',(#${surfaceFill}))`);
    const usage = this.add(`SURFACE_STYLE_USAGE(.BOTH.,#${side})`);
    const assignment = this.add(`PRESENTATION_STYLE_ASSIGNMENT((#${usage}))`);
    return this.add(`STYLED_ITEM('color',(#${assignment}),#${item})`);
  }

  finish(name: string): string[] {
    this.flush();
    const header =
      'ISO-10303-21;\nHEADER;\n' +
      "FILE_DESCRIPTION(('Faceted model exported by DocuView'),'2;1');\n" +
      `FILE_NAME(${this.text(name)},'${new Date().toISOString().slice(0, 19)}',('DocuView'),('DocuView'),'DocuView','DocuView','');\n` +
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n";
    return [header, ...this.chunks, 'ENDSEC;\nEND-ISO-10303-21;\n'];
  }
}

interface PlanarFace {
  /** Vertex loops: the outer one counter-clockwise about the normal, holes the other way. */
  loops: number[][];
  normal: [number, number, number];
  /** A direction in the plane, for the plane's placement. */
  reference: [number, number, number];
}

/**
 * Triangles grouped into flat faces: neighbours sharing an edge, lying in one
 * plane and (where known) coming from one CAD face. A group whose outline
 * does not trace into clean loops stays as its triangles.
 */
function* planarFaces(mesh: ExportMesh): Generator<PlanarFace> {
  const { positions, triangles, faceIds } = mesh;
  const count = triangles.length / 3;
  const vertexCount = positions.length / 3;
  const normals = new Float64Array(count * 3);
  const offsets = new Float64Array(count);
  for (let t = 0; t < count; t += 1) {
    const [a, b, c] = [triangles[t * 3], triangles[t * 3 + 1], triangles[t * 3 + 2]];
    const ux = positions[b * 3] - positions[a * 3];
    const uy = positions[b * 3 + 1] - positions[a * 3 + 1];
    const uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3];
    const vy = positions[c * 3 + 1] - positions[a * 3 + 1];
    const vz = positions[c * 3 + 2] - positions[a * 3 + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    normals.set([nx, ny, nz], t * 3);
    offsets[t] = nx * positions[a * 3] + ny * positions[a * 3 + 1] + nz * positions[a * 3 + 2];
  }

  // Directed edge → triangle, to find the neighbour across each edge.
  const across = new Map<number, number>();
  for (let t = 0; t < count; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      across.set(triangles[t * 3 + k] * vertexCount + triangles[t * 3 + ((k + 1) % 3)], t);
    }
  }

  let extent = 0;
  for (let i = 0; i < positions.length; i += 1) extent = Math.max(extent, Math.abs(positions[i]));
  const flat = Math.max(extent * 1e-7, 1e-6);
  const done = new Uint8Array(count);

  for (let seed = 0; seed < count; seed += 1) {
    if (done[seed]) continue;
    done[seed] = 1;
    const group = [seed];
    const n = [normals[seed * 3], normals[seed * 3 + 1], normals[seed * 3 + 2]] as [number, number, number];
    for (let g = 0; g < group.length; g += 1) {
      const t = group[g];
      for (let k = 0; k < 3; k += 1) {
        const a = triangles[t * 3 + k];
        const b = triangles[t * 3 + ((k + 1) % 3)];
        const other = across.get(b * vertexCount + a);
        if (other === undefined || done[other]) continue;
        if (faceIds && faceIds[other] !== faceIds[seed]) continue;
        const dot = normals[other * 3] * n[0] + normals[other * 3 + 1] * n[1] + normals[other * 3 + 2] * n[2];
        if (dot < 1 - 1e-9 || Math.abs(offsets[other] - offsets[seed]) > flat) continue;
        done[other] = 1;
        group.push(other);
      }
    }

    const loops = group.length > 1 ? outline(group, triangles, vertexCount, positions, n) : null;
    if (loops) {
      yield { loops, normal: n, reference: inPlane(positions, loops[0][0], loops[0][1]) };
    } else {
      for (const t of group) {
        const loop = [triangles[t * 3], triangles[t * 3 + 1], triangles[t * 3 + 2]];
        const normal = [normals[t * 3], normals[t * 3 + 1], normals[t * 3 + 2]] as [number, number, number];
        yield { loops: [loop], normal, reference: inPlane(positions, loop[0], loop[1]) };
      }
    }
  }
}

/** The boundary of a group of triangles as closed loops, the outer one first. */
function outline(
  group: number[],
  triangles: Uint32Array,
  vertexCount: number,
  positions: Float64Array,
  normal: [number, number, number],
): number[][] | null {
  const inside = new Set<number>();
  for (const t of group) {
    for (let k = 0; k < 3; k += 1) inside.add(triangles[t * 3 + k] * vertexCount + triangles[t * 3 + ((k + 1) % 3)]);
  }
  const nextOf = new Map<number, number>();
  for (const key of inside) {
    const a = Math.floor(key / vertexCount);
    const b = key - a * vertexCount;
    if (inside.has(b * vertexCount + a)) continue;
    // Two boundary edges leaving one vertex: the outline touches itself.
    if (nextOf.has(a)) return null;
    nextOf.set(a, b);
  }
  const loops: number[][] = [];
  const seen = new Set<number>();
  for (const start of nextOf.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    let at = start;
    while (!seen.has(at)) {
      seen.add(at);
      loop.push(at);
      const next = nextOf.get(at);
      if (next === undefined) return null;
      at = next;
    }
    if (at !== start || loop.length < 3) return null;
    loops.push(loop);
  }
  // The outer loop winds positively about the normal; holes negatively.
  const areas = loops.map((loop) => {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = 0; i < loop.length; i += 1) {
      const p = loop[i] * 3;
      const q = loop[(i + 1) % loop.length] * 3;
      x += (positions[p + 1] - positions[q + 1]) * (positions[p + 2] + positions[q + 2]);
      y += (positions[p + 2] - positions[q + 2]) * (positions[p] + positions[q]);
      z += (positions[p] - positions[q]) * (positions[p + 1] + positions[q + 1]);
    }
    return x * normal[0] + y * normal[1] + z * normal[2];
  });
  const outer = areas.filter((area) => area > 0);
  if (outer.length !== 1) return null;
  const first = areas.findIndex((area) => area > 0);
  return [loops[first], ...loops.filter((_, index) => index !== first)];
}

function inPlane(positions: Float64Array, a: number, b: number): [number, number, number] {
  const dx = positions[b * 3] - positions[a * 3];
  const dy = positions[b * 3 + 1] - positions[a * 3 + 1];
  const dz = positions[b * 3 + 2] - positions[a * 3 + 2];
  const length = Math.hypot(dx, dy, dz) || 1;
  return [dx / length, dy / length, dz / length];
}

/** Every edge has a triangle on each side, running the other way. */
function isClosed(triangles: Uint32Array): boolean {
  let vertexCount = 0;
  for (const v of triangles) vertexCount = Math.max(vertexCount, v + 1);
  const open = new Map<number, number>();
  for (let t = 0; t < triangles.length; t += 3) {
    for (let k = 0; k < 3; k += 1) {
      const a = triangles[t + k];
      const b = triangles[t + ((k + 1) % 3)];
      const reverse = b * vertexCount + a;
      const waiting = open.get(reverse);
      if (waiting) {
        if (waiting === 1) open.delete(reverse);
        else open.set(reverse, waiting - 1);
      } else {
        const key = a * vertexCount + b;
        open.set(key, (open.get(key) ?? 0) + 1);
      }
    }
  }
  return open.size === 0;
}

/* --------------------------------- helpers -------------------------------- */

/** A STEP real: always with a decimal point. */
function real(value: number, digits = 10): string {
  if (!Number.isFinite(value)) return '0.';
  // Ten digits by default: more than the single-precision mesh carries.
  const rounded = Number(value.toPrecision(digits));
  if (Number.isInteger(rounded) && Math.abs(rounded) < 1e15) return `${rounded}.`;
  const text = String(rounded).toUpperCase();
  if (!text.includes('E')) return text;
  const [mantissa, exponent] = text.split('E');
  return `${mantissa.includes('.') ? mantissa : `${mantissa}.`}E${exponent}`;
}

/** Millimetres to a short decimal, trailing zeros dropped. */
function fixed(value: number): string {
  const short = value.toFixed(5).replace(/\.?0+$/, '');
  return short === '-0' || short === '' ? '0' : short;
}

function xml(value: string): string {
  return value.replace(/[<>&"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[char]!);
}

function ascii(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '_');
}
