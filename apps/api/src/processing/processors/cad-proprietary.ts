import fs from 'node:fs/promises';
import path from 'node:path';
import type { JobResult, NativeCadDocument } from '@docuview/shared';
import { ProcessingError, type ProcessorContext } from '../context.js';
import { convertToStep } from '../converter.js';
import { inspectNativeCad } from '../native-cad.js';
import { documentEntries, readAssemblyTree } from '../sldprt/assembly.js';
import { findBrepSource, meshFromBrep } from '../sldprt/brep-mesh.js';
import { findModelPartition, findParasolidPartitions, findPreviewPng, type PackageEntry } from '../sldprt/container.js';
import { findDisplayMesh, measureMesh, toIndexedMesh, type IndexedMesh } from '../sldprt/display-list.js';
import { processOcct, writeNmg } from './cad-occt.js';

/**
 * Open a native CAD document — SolidWorks, Inventor, CATIA, Revit, Parasolid —
 * without asking anyone to re-export it and without any CAD on the machine.
 *
 * For a SolidWorks part the file itself is enough. It is a ZIP archive in
 * disguise (or, from older writers, an OLE compound file), and it carries
 * three things this reads directly:
 *
 *  1. The display mesh — SolidWorks' own triangulation of every face, with its
 *     normals. That is what is drawn: real 3D you can rotate, section and
 *     measure, identical to what SolidWorks showed.
 *  2. The exact B-rep as a Parasolid stream, saved alongside as `geometry.x_t`
 *     for anyone who needs the precise solid in another tool. When a part was
 *     saved without a display mesh — written by an importer, or with its
 *     display data stripped — this is triangulated here instead
 *     (`brep-mesh.ts`), so it opens in 3D all the same.
 *  3. The preview image SolidWorks rendered at the last save.
 *
 * Only when a file carries neither — an assembly, which references its parts
 * rather than containing them, a part with nothing modelled in it, or a format
 * other than SolidWorks — does this fall back: to a converter if an operator
 * configured one, and otherwise to the preview, properties and component list,
 * said plainly.
 */

/** A part's own mesh, in its own coordinates: SolidWorks' display mesh, else its B-rep triangulated. */
function partMesh(entries: PackageEntry[]): IndexedMesh | null {
  const faces = findDisplayMesh(entries);
  if (faces.length > 0) {
    const mesh = toIndexedMesh(faces);
    if (mesh.triangles > 0) return mesh;
  }
  const { source } = findBrepSource(entries);
  return source ? (meshFromBrep(source.model)?.mesh ?? null) : null;
}

/** A mesh moved by a rigid 4×4 placement (column-major, millimetres). */
function placeMesh(mesh: IndexedMesh, m: number[]): { positions: Float32Array; normals: Float32Array } {
  const positions = new Float32Array(mesh.positions.length);
  const normals = new Float32Array(mesh.normals.length);
  for (let i = 0; i < positions.length; i += 3) {
    const [x, y, z] = [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
    positions[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    positions[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    positions[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    const [a, b, c] = [mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]];
    normals[i] = m[0] * a + m[4] * b + m[8] * c;
    normals[i + 1] = m[1] * a + m[5] * b + m[9] * c;
    normals[i + 2] = m[2] * a + m[6] * b + m[10] * c;
  }
  return { positions, normals };
}

/** The preview SolidWorks saved, written out as an asset. */
async function writePreview(
  ctx: ProcessorContext,
  entries: PackageEntry[],
  info: ReturnType<typeof inspectNativeCad>,
): Promise<NativeCadDocument['preview']> {
  const { request } = ctx;
  const png = findPreviewPng(entries);
  if (png) {
    await fs.writeFile(path.join(request.assetsDir, 'preview.png'), png);
    return {
      url: `/api/v1/files/${request.fileId}/assets/preview.png`,
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
      contentType: 'image/png',
    };
  }
  if (info.preview) {
    const previewName = `preview.${info.preview.extension}`;
    await fs.writeFile(path.join(request.assetsDir, previewName), info.preview.data);
    return {
      url: `/api/v1/files/${request.fileId}/assets/${previewName}`,
      width: info.preview.width,
      height: info.preview.height,
      contentType: info.preview.contentType,
    };
  }
  return null;
}

/** Beyond this, components saved inside an assembly are listed rather than drawn. */
const MAX_EMBEDDED_TRIANGLES = 8_000_000;

/**
 * An assembly: where each part goes, read from the assembly itself.
 *
 * Parts saved inside the assembly (virtual components) are drawn right away,
 * placed; parts in their own files are listed with their placements, and the
 * viewer puts each one where it belongs as its file is added.
 */
async function processAssembly(
  ctx: ProcessorContext,
  entries: PackageEntry[],
  info: ReturnType<typeof inspectNativeCad>,
  previewAsset: NativeCadDocument['preview'],
): Promise<JobResult | null> {
  const { request } = ctx;
  const tree = readAssemblyTree(entries);
  if (!tree) return null;
  const name = request.displayName.replace(/\.[^.]+$/, '') || 'Assembly';
  ctx.log(
    'info',
    `assembly: ${tree.instances.length} part instances, ${tree.suppressed} suppressed, ${tree.hidden} hidden, ${tree.unexpanded.length} sub-assemblies not opened up`,
  );

  /* ------------------------- components saved inside ----------------------- */
  const warnings: string[] = [];
  const embedded = tree.instances.filter((instance) => instance.embedded);
  const meshes = new Map<PackageEntry[], IndexedMesh | null>();
  const nodes = new Map<string, { name: string; meshes: number[]; children: string[] }>();
  const rootKey = '';
  nodes.set(rootKey, { name, meshes: [], children: [] });
  const nodeFor = (path: string[]): string => {
    let key = rootKey;
    for (const part of path) {
      const next = `${key}/${part}`;
      if (!nodes.has(next)) {
        nodes.set(next, { name: part, meshes: [], children: [] });
        nodes.get(key)?.children.push(next);
      }
      key = next;
    }
    return key;
  };
  const placedMeshes: {
    name: string;
    attributes: { position: { array: Float32Array }; normal: { array: Float32Array } };
    index: { array: Uint32Array };
    brep_faces: { first: number; last: number; color: null }[];
  }[] = [];
  let triangles = 0;
  let drawnInside = 0;
  for (const instance of embedded) {
    const document = instance.embedded as PackageEntry[];
    if (!meshes.has(document)) meshes.set(document, partMesh(document));
    const mesh = meshes.get(document);
    if (!mesh) continue;
    if (triangles + mesh.triangles > MAX_EMBEDDED_TRIANGLES) {
      warnings.push('Some components saved inside this assembly are too large to draw together and were left out.');
      break;
    }
    const placed = placeMesh(mesh, instance.matrix);
    nodes.get(nodeFor(instance.path))?.meshes.push(placedMeshes.length);
    placedMeshes.push({
      name: instance.path[instance.path.length - 1],
      attributes: { position: { array: placed.positions }, normal: { array: placed.normals } },
      index: { array: mesh.indices },
      brep_faces: mesh.faceRanges.map((range) => ({ ...range, color: null })),
    });
    triangles += mesh.triangles;
    drawnInside += 1;
  }
  const missingInside = tree.instances.filter((instance) => instance.virtual).length - drawnInside;
  if (missingInside > 0) warnings.push(`${missingInside} component(s) saved inside this assembly could not be drawn.`);

  let geometry3d: string | null = null;
  if (placedMeshes.length > 0) {
    ctx.progress('preparing-geometry', 80);
    const toNode = (key: string): { name: string; meshes: number[]; children: unknown[] } => {
      const node = nodes.get(key) as { name: string; meshes: number[]; children: string[] };
      return { name: node.name, meshes: node.meshes, children: node.children.map(toNode) };
    };
    await writeNmg(
      { success: true, root: toNode(rootKey) as never, meshes: placedMeshes },
      request.assetsDir,
      request.size,
      ctx,
      'SolidWorks assembly, components saved inside it',
    );
    geometry3d = `/api/v1/files/${request.fileId}/assets/model.nmg.json`;
  }

  /* ------------------------- components in own files ----------------------- */
  const external = tree.instances.filter((instance) => !instance.virtual);
  const componentNames: string[] = [];
  const seen = new Set<string>();
  for (const instance of external) {
    const key = instance.component.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    componentNames.push(instance.component);
  }
  if (tree.unexpanded.length > 0) {
    warnings.push(`${tree.unexpanded.length} sub-assembly reference(s) carry no placements of their own and are not shown.`);
  }

  const document: NativeCadDocument = {
    application: info.application,
    version: info.version,
    role: 'assembly',
    preview: previewAsset,
    properties: info.properties,
    components: componentNames.map((component) => ({ name: component, status: 'missing', jobId: null, fileId: null })),
    geometry: 'preview-only',
    measured: null,
    note:
      external.length === 0
        ? `All ${tree.instances.length} parts of this assembly are saved inside it and are drawn in place.`
        : `This assembly places ${external.length} part occurrence(s) from ${componentNames.length} part file(s)${
            drawnInside ? `, and ${drawnInside} more saved inside it` : ''
          }. Add the part files — or drop the whole folder — and each part appears where it belongs.`,
    placements: external.map(({ component, configuration, path, matrix }) => ({ component, configuration, path, matrix })),
    geometry3d,
  };
  await fs.writeFile(path.join(request.assetsDir, 'native.json'), JSON.stringify(document));
  ctx.progress('preparing-geometry', 95);

  return {
    kind: 'cad',
    viewer: 'cad-preview',
    source: `/api/v1/files/${request.fileId}/assets/native.json`,
    meta: {
      formatId: request.formatId,
      application: info.application,
      role: 'assembly',
      hasPreview: Boolean(previewAsset),
      componentCount: componentNames.length,
      componentNames,
      instances: tree.instances.length,
      instancesInside: drawnInside,
      instancesInFiles: external.length,
      suppressed: tree.suppressed,
      hidden: tree.hidden,
      triangles,
      converter: false,
    },
    warnings,
  };
}

export async function processProprietaryCad(ctx: ProcessorContext): Promise<JobResult> {
  const { request } = ctx;
  ctx.progress('processing', 8);
  await fs.mkdir(request.assetsDir, { recursive: true });

  const buffer = await fs.readFile(request.filePath);
  const entries = documentEntries(buffer);
  ctx.log('info', `package: ${entries.length} verified entries`);
  ctx.progress('processing', 30);

  // An assembly first: its own display data is a cache of its parts in their
  // own coordinates, not the assembly, and must not be drawn as if it were.
  const isAssemblyFile = request.extension === 'sldasm';
  if (isAssemblyFile) {
    const info = inspectNativeCad(buffer, request.formatId, request.extension);
    const assembly = await processAssembly(ctx, entries, info, await writePreview(ctx, entries, info));
    if (assembly) return assembly;
  }

  /* ------------------------------- exact B-rep ----------------------------- */
  let model: { data: Buffer; version: string | null } | null = findModelPartition(buffer, entries);
  if (model) ctx.log('info', `Parasolid model: ${model.data.length} B, modeller ${model.version}`);
  const parasolidMeta = () => ({
    parasolidBytes: model?.data.length ?? 0,
    parasolidVersion: model?.version ?? null,
    parasolidUrl: model ? `/api/v1/files/${request.fileId}/assets/geometry.x_t` : null,
  });

  const name = request.displayName.replace(/\.[^.]+$/, '') || 'Part';
  const drawMesh = async (mesh: IndexedMesh, faceCount: number, producer: string, extra: Record<string, unknown>, warnings: string[]): Promise<JobResult> => {
    ctx.progress('preparing-geometry', 70);
    if (model) await fs.writeFile(path.join(request.assetsDir, 'geometry.x_t'), model.data);
    const manifest = await writeNmg(
      {
        success: true,
        root: { name, meshes: [0], children: [] },
        meshes: [
          {
            name,
            attributes: { position: { array: mesh.positions }, normal: { array: mesh.normals } },
            index: { array: mesh.indices },
            brep_faces: mesh.faceRanges.map((range) => ({ ...range, color: null })),
          },
        ],
      },
      request.assetsDir,
      request.size,
      ctx,
      producer,
    );
    const measured = measureMesh(mesh);
    ctx.log(
      'info',
      `${producer}: ${faceCount} faces, ${mesh.triangles} triangles, ${measured.size.map((v) => v.toFixed(1)).join(' x ')} mm`,
    );
    ctx.progress('preparing-geometry', 95);
    return {
      kind: 'cad',
      viewer: 'cad-nmg',
      source: `/api/v1/files/${request.fileId}/assets/model.nmg.json`,
      meta: {
        formatId: request.formatId,
        application: 'SolidWorks',
        triangles: manifest.stats.triangles,
        vertices: manifest.stats.vertices,
        parts: manifest.stats.meshes,
        faces: faceCount,
        units: manifest.units,
        producer: manifest.producer,
        sizeMm: measured.size,
        volumeMm3: measured.volume,
        areaMm2: measured.area,
        ...extra,
        ...parasolidMeta(),
      },
      warnings: [...manifest.warnings, ...warnings],
    };
  };

  /* ------------------------------- display mesh ---------------------------- */
  ctx.progress('processing', 45);
  const faces = isAssemblyFile ? [] : findDisplayMesh(entries);
  if (faces.length > 0) {
    const mesh = toIndexedMesh(faces);
    if (mesh.triangles > 0) {
      return drawMesh(mesh, faces.length, 'SolidWorks display mesh, read from the file', { meshSource: 'display' }, []);
    }
  }

  /* ----------------------- the solid, triangulated here -------------------- */
  // Parts only: an assembly's bodies are in its component files.
  const { source: brep, readable } = isAssemblyFile ? { source: null, readable: 0 } : findBrepSource(entries);
  if (brep) {
    ctx.progress('processing', 55);
    const built = meshFromBrep(brep.model);
    if (built) {
      const { stats } = built;
      ctx.log(
        'info',
        `no display mesh; triangulated the B-rep in ${brep.name}: ${stats.exact} exact, ${stats.approximated} approximated, ${stats.skipped} skipped (${Object.entries(stats.surfaces).map(([k, v]) => `${k} ${v}`).join(', ')})`,
      );
      // A part made by an importer may carry its solid only here; it is a
      // complete transmit stream, so it is as good a download as a partition.
      if (!model) model = { data: brep.data, version: /version\s+(\d+)/.exec(brep.data.subarray(0, 160).toString('latin1'))?.[1] ?? null };
      const warnings =
        stats.approximated + stats.skipped > 0
          ? [
              `${stats.approximated + stats.skipped} of ${stats.faces} faces lie on surfaces this viewer cannot evaluate yet and are drawn flat through their edges or left out.`,
            ]
          : [];
      return drawMesh(
        built.mesh,
        stats.faces,
        'SolidWorks B-rep (Parasolid), triangulated by DocuView',
        { meshSource: 'b-rep', approximatedFaces: stats.approximated + stats.skipped },
        warnings,
      );
    }
  }
  if (model) await fs.writeFile(path.join(request.assetsDir, 'geometry.x_t'), model.data);

  /* ------------------------------ converter ------------------------------- */
  const warnings: string[] = [];
  const converterCmd = request.options.cadConverterCmd;
  if (converterCmd) {
    try {
      ctx.log('info', `no display mesh in this ${request.formatId}; converting with the configured CAD converter`);
      const stepPath = await convertToStep({
        command: converterCmd,
        inputPath: request.filePath,
        outDir: path.join(request.assetsDir, 'convert'),
        informat: request.extension,
        timeoutMs: request.options.timeoutMs,
        log: ctx.log,
      });
      const stat = await fs.stat(stepPath);
      const result = await processOcct({
        ...ctx,
        request: { ...request, filePath: stepPath, formatId: 'step', size: stat.size },
      });
      result.meta = { ...result.meta, formatId: request.formatId, convertedVia: 'server converter', ...parasolidMeta() };
      return result;
    } catch (err) {
      const message = err instanceof ProcessingError ? err.message : "The CAD converter on this server couldn't read this file.";
      ctx.log('warn', `converter failed: ${message}`);
      warnings.push(message);
    }
  }

  /* ------------------------ preview, properties, parts --------------------- */
  ctx.progress('processing', 60);
  const info = inspectNativeCad(buffer, request.formatId, request.extension);
  ctx.log('info', `native inspection: ${info.detail.join(', ') || 'nothing found'}`);

  const previewAsset = await writePreview(ctx, entries, info);

  const isAssembly = info.role === 'assembly' || request.extension === 'sldasm';
  const stubOnly = !model && findParasolidPartitions(buffer, entries).length > 0;
  // Every body stream read, and not one face in any of them: nothing was
  // modelled in this part. That is an answer, not a failure to find one.
  const emptyPart = !isAssembly && readable > 0 && !brep;

  const document: NativeCadDocument = {
    application: info.application,
    version: info.version,
    role: isAssembly ? 'assembly' : info.role,
    preview: previewAsset,
    properties: info.properties,
    components: info.references.map((component) => ({ name: component, status: 'missing', jobId: null, fileId: null })),
    geometry: 'preview-only',
    measured: null,
    note: isAssembly
      ? `A ${info.application} assembly does not contain the geometry of its parts — it references them. ${
          previewAsset ? 'This is the preview SolidWorks saved with it. ' : ''
        }Open the part files themselves to see each one in 3D.`
      : emptyPart
        ? `This ${info.application} part is empty: it holds no solid or surface body, so there is nothing to show in 3D.`
        : stubOnly
          ? `This ${info.application} file carries its solid but was saved without a display mesh, so there is nothing ready to draw. ${
              previewAsset ? 'The preview SolidWorks saved with it is shown instead. ' : ''
            }The exact solid can be downloaded as a standard .x_t.`
          : previewAsset
            ? `This ${info.application} file carries no 3D data this viewer can draw, so this is the preview saved inside it.`
            : `This ${info.application} document opened, but it holds neither 3D data nor a preview. Its properties are shown below.`,
  };

  await fs.writeFile(path.join(request.assetsDir, 'native.json'), JSON.stringify(document));
  ctx.progress('preparing-geometry', 95);

  if (isAssembly && info.references.length > 0) {
    warnings.push(
      `This is an assembly of ${info.references.length} component${info.references.length === 1 ? '' : 's'}. Add the component files to build the model.`,
    );
  }

  return {
    kind: 'cad',
    viewer: 'cad-preview',
    source: `/api/v1/files/${request.fileId}/assets/native.json`,
    meta: {
      formatId: request.formatId,
      application: info.application,
      role: document.role,
      hasPreview: Boolean(previewAsset),
      componentCount: info.references.length,
      componentNames: document.components.map((component) => component.name),
      converter: false,
      emptyModel: emptyPart,
      ...parasolidMeta(),
    },
    warnings,
  };
}
