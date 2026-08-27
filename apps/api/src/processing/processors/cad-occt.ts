import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { JobResult, NmgManifest, NmgMesh, NmgNode } from '@docuview/shared';
import { ProcessingError, type ProcessorContext } from '../context.js';

const require = createRequire(import.meta.url);

/* ---------------------------- occt-import-js ------------------------------ */

interface OcctMesh {
  name?: string;
  color?: [number, number, number];
  brep_faces?: { first: number; last: number; color: [number, number, number] | null }[];
  attributes: {
    position: { array: number[] };
    normal?: { array: number[] };
  };
  index: { array: number[] };
}

interface OcctNode {
  name?: string;
  meshes: number[];
  children: OcctNode[];
}

interface OcctResult {
  success: boolean;
  root: OcctNode;
  meshes: OcctMesh[];
}

interface OcctModule {
  ReadStepFile(content: Uint8Array, params: unknown): OcctResult;
  ReadIgesFile(content: Uint8Array, params: unknown): OcctResult;
  ReadBrepFile(content: Uint8Array, params: unknown): OcctResult;
}

let modulePromise: Promise<OcctModule> | null = null;

function loadOcct(): Promise<OcctModule> {
  if (!modulePromise) {
    const factory = require('occt-import-js') as () => Promise<OcctModule>;
    modulePromise = factory();
  }
  return modulePromise;
}

function occtVersion(): string {
  try {
    const pkg = require('occt-import-js/package.json') as { version: string };
    return `occt-import-js ${pkg.version} (OpenCascade)`;
  } catch {
    return 'occt-import-js (OpenCascade)';
  }
}

/* ------------------------------ tessellation ------------------------------ */

/**
 * Trade tessellation quality for turnaround on large files. The ratio is
 * relative to the bounding box, so it behaves the same for a bolt and a bridge.
 */
function deflectionFor(sizeBytes: number): { linearDeflection: number; angularDeflection: number } {
  const mb = sizeBytes / (1024 * 1024);
  if (mb > 80) return { linearDeflection: 0.006, angularDeflection: 0.8 };
  if (mb > 20) return { linearDeflection: 0.003, angularDeflection: 0.6 };
  return { linearDeflection: 0.001, angularDeflection: 0.5 };
}

function toHex(color: [number, number, number] | undefined): string | undefined {
  if (!color) return undefined;
  const channel = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(color[0])}${channel(color[1])}${channel(color[2])}`;
}

/* --------------------------------- driver --------------------------------- */

export async function processOcct(ctx: ProcessorContext): Promise<JobResult> {
  const { request } = ctx;
  ctx.progress('processing', 10);

  const content = await fs.readFile(request.filePath);
  const occt = await loadOcct();
  const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', ...deflectionFor(request.size) };

  ctx.progress('processing', 35);
  let result: OcctResult;
  try {
    const bytes = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    if (request.formatId === 'step') result = occt.ReadStepFile(bytes, params);
    else if (request.formatId === 'iges') result = occt.ReadIgesFile(bytes, params);
    else result = occt.ReadBrepFile(bytes, params);
  } catch (err) {
    throw new ProcessingError(
      'cad_read_failed',
      "We couldn't read the geometry in this CAD file.",
      'The file may be truncated, or exported with a CAD version we cannot read yet. Re-exporting as STEP AP214 usually helps.',
      false,
      err instanceof Error ? err.message : String(err),
    );
  }

  if (!result || !result.success) {
    throw new ProcessingError(
      'cad_read_failed',
      "We couldn't read the geometry in this CAD file.",
      'Try re-exporting the model as STEP AP214 or AP242 from your CAD system.',
      false,
      'occt returned success=false',
    );
  }
  if (!result.meshes || result.meshes.length === 0) {
    throw new ProcessingError(
      'cad_empty',
      'This CAD file opened, but it contains no visible geometry.',
      'The file may only hold construction geometry, curves or metadata.',
      false,
      'occt returned zero meshes',
    );
  }

  ctx.progress('preparing-geometry', 60);
  const manifest = await writeNmg(result, request.assetsDir, request.size, ctx);
  ctx.progress('preparing-geometry', 95);

  return {
    kind: 'cad',
    viewer: 'cad-nmg',
    source: `/api/v1/files/${request.fileId}/assets/model.nmg.json`,
    meta: {
      formatId: request.formatId,
      triangles: manifest.stats.triangles,
      vertices: manifest.stats.vertices,
      parts: manifest.stats.meshes,
      units: manifest.units,
      producer: manifest.producer,
    },
    warnings: manifest.warnings,
  };
}

/**
 * Serialise the OCCT result into a manifest plus one binary blob.
 *
 * Everything is written as typed arrays so the browser can hand the buffers to
 * WebGL without a per-vertex JSON parse — the difference is seconds on a
 * million-triangle assembly.
 */
async function writeNmg(
  result: OcctResult,
  outDir: string,
  sourceSize: number,
  ctx: ProcessorContext,
): Promise<NmgManifest> {
  await fs.mkdir(outDir, { recursive: true });

  const warnings: string[] = [];
  const meshes: NmgMesh[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;
  let triangles = 0;
  let vertices = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  const push = (buffer: Buffer): { offset: number; count: number; bytes: number } => {
    // Keep 4-byte alignment so Float32Array/Uint32Array views are valid.
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      offset += pad;
    }
    const start = offset;
    chunks.push(buffer);
    offset += buffer.byteLength;
    return { offset: start, count: buffer.byteLength / 4, bytes: buffer.byteLength };
  };

  result.meshes.forEach((mesh, index) => {
    const positions = mesh.attributes?.position?.array;
    const indices = mesh.index?.array;
    if (!positions || positions.length === 0 || !indices || indices.length === 0) {
      warnings.push(`Part "${mesh.name || `Solid ${index + 1}`}" produced no triangles and was skipped.`);
      return;
    }

    const positionArray = Float32Array.from(positions);
    for (let i = 0; i < positionArray.length; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = positionArray[i + axis];
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }

    const positionAccessor = push(Buffer.from(positionArray.buffer, positionArray.byteOffset, positionArray.byteLength));

    let normalAccessor: { offset: number; count: number } | undefined;
    const normals = mesh.attributes.normal?.array;
    if (normals && normals.length === positions.length) {
      const normalArray = Float32Array.from(normals);
      normalAccessor = push(Buffer.from(normalArray.buffer, normalArray.byteOffset, normalArray.byteLength));
    }

    const indexArray = Uint32Array.from(indices);
    const indexAccessor = push(Buffer.from(indexArray.buffer, indexArray.byteOffset, indexArray.byteLength));

    triangles += indexArray.length / 3;
    vertices += positionArray.length / 3;

    const faceRanges: number[] = [];
    for (const face of mesh.brep_faces ?? []) {
      faceRanges.push(face.first, face.last);
    }

    meshes.push({
      id: index,
      name: mesh.name?.trim() || `Solid ${index + 1}`,
      position: { offset: positionAccessor.offset, count: positionAccessor.count },
      normal: normalAccessor,
      index: { offset: indexAccessor.offset, count: indexAccessor.count },
      color: toHex(mesh.color),
      faceRanges: faceRanges.length > 0 ? faceRanges : undefined,
    });
  });

  if (meshes.length === 0) {
    throw new ProcessingError(
      'cad_empty',
      'This CAD file opened, but it contains no visible geometry.',
      'The file may only hold construction geometry, curves or metadata.',
      false,
      'all meshes empty',
    );
  }

  /* ------------------------------ assembly tree --------------------------- */
  const nodes: NmgNode[] = [];
  const validMeshIds = new Set(meshes.map((m) => m.id));

  const walk = (source: OcctNode, parent: number | null, depth: number): number => {
    const id = nodes.length;
    const node: NmgNode = {
      id,
      name: source.name?.trim() || (parent === null ? 'Model' : `Component ${id}`),
      parent,
      children: [],
      meshes: (source.meshes ?? []).filter((m) => validMeshIds.has(m)),
    };
    nodes.push(node);
    if (depth < 64) {
      for (const child of source.children ?? []) {
        node.children.push(walk(child, id, depth + 1));
      }
    } else {
      warnings.push('The assembly tree is deeper than 64 levels; deeper components were flattened.');
    }
    return id;
  };

  const roots: number[] = [];
  if (result.root) {
    roots.push(walk(result.root, null, 0));
  } else {
    const id = nodes.length;
    nodes.push({ id, name: 'Model', parent: null, children: [], meshes: meshes.map((m) => m.id) });
    roots.push(id);
  }

  // Meshes that no node references would otherwise be invisible in the tree.
  const referenced = new Set(nodes.flatMap((n) => n.meshes));
  const orphans = meshes.filter((m) => !referenced.has(m.id)).map((m) => m.id);
  if (orphans.length > 0 && roots.length > 0) {
    nodes[roots[0]].meshes.push(...orphans);
  }

  const buffer = Buffer.concat(chunks);
  await fs.writeFile(path.join(outDir, 'model.bin'), buffer);

  const manifest: NmgManifest = {
    version: 1,
    units: 'mm',
    bbox: { min, max },
    buffer: { uri: 'model.bin', byteLength: buffer.byteLength },
    meshes,
    nodes,
    roots,
    stats: { meshes: meshes.length, triangles, vertices },
    producer: occtVersion(),
    warnings,
  };

  await fs.writeFile(path.join(outDir, 'model.nmg.json'), JSON.stringify(manifest));
  ctx.log(
    'info',
    `normalized ${meshes.length} solids / ${triangles} triangles from a ${(sourceSize / 1048576).toFixed(1)} MB file`,
  );
  return manifest;
}
