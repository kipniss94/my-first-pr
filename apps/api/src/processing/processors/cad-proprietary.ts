import fs from 'node:fs/promises';
import path from 'node:path';
import type { DrawingDocument, DrawingSheetDocument, JobResult, NativeCadDocument } from '@docuview/shared';
import { ProcessingError, type ProcessorContext } from '../context.js';
import { convertToStep } from '../converter.js';
import { inspectNativeCad } from '../native-cad.js';
import { documentEntries, readAssemblyTree } from '../sldprt/assembly.js';
import { readStoredGraphics } from '../sldprt/stored-graphics.js';
import { findBrepSource, meshFromBrep } from '../sldprt/brep-mesh.js';
import { findModelPartition, findParasolidPartitions, findPreviewPng, unwrapCodec, type PackageEntry } from '../sldprt/container.js';
import { isBinaryXt, readXt } from '../sldprt/xt-reader.js';
import {
  colouredFaces,
  findDisplayMesh,
  mainColour,
  measureMesh,
  toIndexedMesh,
  visualStatesColour,
  type DisplayFace,
  type IndexedMesh,
} from '../sldprt/display-list.js';
import { readDrawing, sheetSvg, type Drawing } from '../sldprt/drawing.js';
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
    if (mesh.triangles > 0) {
      const solid = solidInstead(entries, faces.length)?.mesh;
      return solid ? coloured(solid, mainColour(faces) ?? visualStatesColour(entries)) : mesh;
    }
  }
  const { source } = findBrepSource(entries);
  const mesh = source ? (meshFromBrep(source.model)?.mesh ?? null) : null;
  return mesh ? coloured(mesh, visualStatesColour(entries)) : null;
}

/** A mesh without colours of its own, given one throughout. */
function coloured(mesh: IndexedMesh, colour: [number, number, number] | null): IndexedMesh {
  return colour && !mesh.faceColors ? { ...mesh, faceColors: mesh.faceRanges.map(() => colour) } : mesh;
}

/**
 * The solid of the configuration the part was last shown in — the one its
 * display mesh was drawn from.
 */
function shownSolid(entries: PackageEntry[]) {
  const current = partConfigurations(entries).find((configuration) => configuration.current);
  const entry = current ? entries.find((e) => new RegExp(`(^|/)Config-${current.id}-Partition$`).test(e.name)) : undefined;
  const data = entry ? unwrapCodec(entry.data) : null;
  if (data && isBinaryXt(data)) {
    try {
      return readXt(data);
    } catch {
      /* fall back to the partition the B-rep path would use */
    }
  }
  return findBrepSource(entries).source?.model ?? null;
}

/**
 * The solid, triangulated, when SolidWorks' stored display mesh is out of date.
 *
 * The display mesh is what SolidWorks drew at some save; the partition is the
 * solid itself, and normally the two have one face for one face. When the
 * counts differ, the mesh is from an earlier state of the part — a screw drawn
 * at another size, a plate before its last cut — and in the assemblies it
 * disagrees with the extent SolidWorks recorded, while the solid agrees. The
 * solid is only preferred when every one of its faces could be evaluated
 * exactly: an approximation is not trusted over SolidWorks' own drawing.
 */
function solidInstead(entries: PackageEntry[], displayFaces: number): ReturnType<typeof meshFromBrep> {
  const model = shownSolid(entries);
  const faces = model?.byType.get(14)?.length ?? 0;
  if (!model || faces === 0 || faces === displayFaces) return null;
  let built: ReturnType<typeof meshFromBrep> = null;
  try {
    built = meshFromBrep(model);
  } catch {
    // The display mesh still opens the part; nothing is lost by keeping it.
    return null;
  }
  if (!built || built.stats.approximated + built.stats.skipped > 0) return null;
  return built;
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

interface PartConfiguration {
  name: string;
  /** `N` of `Contents/Config-N-Partition`. */
  id: number;
  current: boolean;
}

/** The configurations a part keeps, as its own XML lists them. */
function partConfigurations(entries: PackageEntry[]): PartConfiguration[] {
  for (const entry of entries.filter((e) => /(^|\/)swXmlContents\//.test(e.name))) {
    const data = /__ZLB$/.test(entry.name) ? unwrapCodec(entry.data) : entry.data;
    const xml = data?.toString('utf8') ?? '';
    const list: PartConfiguration[] = [];
    for (const match of xml.matchAll(/<swConfiguration\s[^>]*>/g)) {
      const attribute = (name: string) =>
        new RegExp(`\\b${name}="([^"]*)"`)
          .exec(match[0])?.[1]
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&');
      const id = Number(attribute('swID'));
      const name = attribute('swName');
      if (name !== undefined && Number.isInteger(id)) list.push({ name, id, current: attribute('swMostRecentConfiguration') === 'YES' });
    }
    if (list.length > 0) return list;
  }
  return [];
}

/**
 * Meshes for the configurations an assembly uses, beside the one drawn.
 *
 * A part keeps one display mesh — for the configuration it was last shown in —
 * but the solid of every configuration it has built, one partition each. When
 * an assembly uses another one (a screw of another length, a spring
 * compressed), that solid is triangulated and written as `config-N`. The map
 * says, per configuration name, which manifest to draw: `null` for the main
 * one, absent when the file does not hold that configuration at all.
 */
async function configurationMeshes(
  ctx: ProcessorContext,
  entries: PackageEntry[],
  mainId: number | null,
): Promise<{ map: Record<string, string | null>; unavailable: string[] }> {
  const { request } = ctx;
  const wanted = [...new Set(request.options.configurations ?? [])];
  const map: Record<string, string | null> = {};
  const unavailable: string[] = [];
  if (wanted.length === 0) return { map, unavailable };
  const configurations = partConfigurations(entries);
  const main = mainId ?? configurations.find((c) => c.current)?.id ?? null;
  for (const name of wanted) {
    const configuration = configurations.find((c) => c.name === name) ?? configurations.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!configuration) {
      // A single-configuration part, or an unnamed one: what is drawn is it.
      if (configurations.length <= 1) map[name] = null;
      else unavailable.push(name);
      continue;
    }
    if (configuration.id === main) {
      map[name] = null;
      continue;
    }
    const partition = entries.find((e) => new RegExp(`(^|/)Config-${configuration.id}-Partition$`).test(e.name));
    const data = partition ? unwrapCodec(partition.data) : null;
    let built: ReturnType<typeof meshFromBrep> = null;
    try {
      built = data ? meshFromBrep(readXt(data)) : null;
    } catch {
      built = null;
    }
    if (!built) {
      unavailable.push(name);
      continue;
    }
    const base = `config-${configuration.id}`;
    await writeNmg(
      {
        success: true,
        root: { name, meshes: [0], children: [] },
        meshes: [
          {
            name,
            attributes: { position: { array: built.mesh.positions }, normal: { array: built.mesh.normals } },
            index: { array: built.mesh.indices },
            ...colouredFaces(built.mesh, visualStatesColour(entries)),
          },
        ],
      },
      request.assetsDir,
      request.size,
      ctx,
      `SolidWorks B-rep (Parasolid) of configuration "${name}", triangulated by DocuView`,
      base,
    );
    map[name] = `/api/v1/files/${request.fileId}/assets/${base}.nmg.json`;
  }
  if (unavailable.length > 0) ctx.log('warn', `configurations not kept in the file: ${unavailable.join(', ')}`);
  return { map, unavailable };
}

/**
 * A SolidWorks drawing as one SVG per sheet (see sldprt/drawing.ts), with the
 * picture SolidWorks saved of each sheet beside it. Null when the file keeps
 * no sheet graphics — the preview path then shows what there is.
 */
async function processDrawing(ctx: ProcessorContext, entries: PackageEntry[], buffer: Buffer): Promise<JobResult | null> {
  const { request } = ctx;
  let drawing: Drawing | null = null;
  try {
    drawing = readDrawing(entries);
  } catch (err) {
    ctx.log('warn', `drawing sheets not read: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!drawing || !drawing.sheets.some((sheet) => sheet.shapes.length > 0)) return null;
  const info = inspectNativeCad(buffer, request.formatId, request.extension);
  ctx.progress('preparing-geometry', 60);

  const base = `/api/v1/files/${request.fileId}/assets`;
  const sheets: DrawingSheetDocument[] = [];
  for (const [k, sheet] of drawing.sheets.entries()) {
    await fs.writeFile(path.join(request.assetsDir, `sheet-${k}.svg`), sheetSvg(sheet));
    if (sheet.image) await fs.writeFile(path.join(request.assetsDir, `sheet-${k}.png`), sheet.image);
    const shown = sheet.views.filter((view) => !view.hidden);
    sheets.push({
      name: sheet.name,
      widthMm: Math.round(sheet.width * 10000) / 10,
      heightMm: Math.round(sheet.height * 10000) / 10,
      svg: `${base}/sheet-${k}.svg`,
      picture: sheet.image ? `${base}/sheet-${k}.png` : null,
      views: shown.length,
      viewsDrawn: shown.filter((view) => view.drawn).length,
      viewsFromPicture: shown.filter((view) => !view.drawn).length,
      active: sheet.active,
    });
  }
  const views = sheets.reduce((n, sheet) => n + sheet.views, 0);
  const drawn = sheets.reduce((n, sheet) => n + sheet.viewsDrawn, 0);
  const fromPicture = sheets.reduce((n, sheet) => n + sheet.viewsFromPicture, 0);
  const texts = drawing.sheets.reduce((n, sheet) => n + sheet.shapes.filter((shape) => shape.kind === 'text').length, 0);
  const document: DrawingDocument = {
    application: info.application,
    version: info.version,
    sheets,
    properties: info.properties,
    note:
      `${sheets.length} sheet${sheets.length === 1 ? '' : 's'} drawn from the file itself: frames, notes, dimensions and ${drawn} of ${views} view${views === 1 ? '' : 's'} from their own edges` +
      (fromPicture > 0 ? `; ${fromPicture} shown from the picture SolidWorks saved, whose edges this viewer cannot place yet.` : '.'),
  };
  await fs.writeFile(path.join(request.assetsDir, 'drawing.json'), JSON.stringify(document));
  ctx.log('info', `drawing: ${sheets.length} sheet(s), ${views} view(s), ${drawn} drawn, ${fromPicture} from the picture, ${texts} texts`);
  ctx.progress('preparing-geometry', 95);
  return {
    kind: 'cad',
    viewer: 'cad-drawing',
    source: `${base}/drawing.json`,
    meta: {
      formatId: request.formatId,
      application: info.application,
      role: 'drawing',
      sheets: sheets.length,
      views,
      viewsDrawn: drawn,
      viewsFromPicture: fromPicture,
      texts,
      preview: sheets.find((sheet) => sheet.active)?.picture ?? sheets[0]?.picture ?? null,
    },
    warnings: [],
  };
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
    color?: [number, number, number];
    brep_faces: { first: number; last: number; color: [number, number, number] | null }[];
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
      ...colouredFaces(mesh),
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
  const componentConfigurations: Record<string, string[]> = {};
  for (const instance of external) {
    const key = instance.component.toLowerCase();
    if (!componentConfigurations[key]) {
      componentConfigurations[key] = [];
      componentNames.push(instance.component);
    }
    if (!componentConfigurations[key].includes(instance.configuration)) componentConfigurations[key].push(instance.configuration);
  }
  if (tree.unexpanded.length > 0) {
    warnings.push(`${tree.unexpanded.length} sub-assembly reference(s) carry no placements of their own and are not shown.`);
  }

  /* --------------- the same parts, from the graphics kept in here ----------- */
  // Drawn wherever a part's own file has not been added — a Toolbox fastener
  // from the author's library, say.
  const stored = readStoredGraphics(entries);
  const storedMeshes: typeof placedMeshes = [];
  const storedIds = new Map<DisplayFace[], number | null>();
  let storedTriangles = 0;
  const storedOf = external.map((instance) => {
    const faces = stored?.facesAt(instance.path);
    if (!faces) return undefined;
    if (!storedIds.has(faces)) {
      const mesh = toIndexedMesh(faces);
      const fits = mesh.triangles > 0 && storedTriangles + mesh.triangles <= MAX_EMBEDDED_TRIANGLES;
      storedIds.set(faces, fits ? storedMeshes.length : null);
      if (fits) {
        storedTriangles += mesh.triangles;
        storedMeshes.push({
          name: instance.component.replace(/\.[^.]+$/, ''),
          attributes: { position: { array: mesh.positions }, normal: { array: mesh.normals } },
          index: { array: mesh.indices },
          ...colouredFaces(mesh),
        });
      }
    }
    return storedIds.get(faces) ?? undefined;
  });
  let storedGeometry: string | null = null;
  if (storedMeshes.length > 0) {
    ctx.progress('preparing-geometry', 88);
    await writeNmg(
      { success: true, root: { name, meshes: storedMeshes.map((_, k) => k), children: [] }, meshes: storedMeshes },
      request.assetsDir,
      request.size,
      ctx,
      'SolidWorks assembly, the graphics it keeps of its parts',
      'stored',
    );
    storedGeometry = `/api/v1/files/${request.fileId}/assets/stored.nmg.json`;
    ctx.log('info', `stored graphics: ${storedOf.filter((id) => id !== undefined).length} of ${external.length} occurrences, ${storedMeshes.length} parts`);
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
    placements: external.map(({ component, configuration, path, matrix }, k) => ({
      component,
      configuration,
      path,
      matrix,
      ...(storedOf[k] !== undefined ? { stored: storedOf[k] } : {}),
    })),
    geometry3d,
    storedGeometry,
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
      componentConfigurations,
      instances: tree.instances.length,
      referencedFiles: tree.files,
      unexpandedAssemblies: tree.unexpanded,
      // Where SolidWorks had the assembly and every file it references: how
      // the right copy is told apart from another with the same name.
      originalPath: tree.originalPath,
      referencedPaths: tree.paths,
      boundingBoxMm: tree.boundingBoxMm,
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

  // A drawing: its sheets, drawn from what SolidWorks keeps for showing them.
  // Its section bodies are Parasolid too and must not be taken for a part.
  if (request.extension === 'slddrw') {
    const drawing = await processDrawing(ctx, entries, buffer);
    if (drawing) return drawing;
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
  const drawMesh = async (
    mesh: IndexedMesh,
    faceCount: number,
    producer: string,
    extra: Record<string, unknown>,
    warnings: string[],
    colour: [number, number, number] | null = null,
  ): Promise<JobResult> => {
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
            ...colouredFaces(mesh, colour),
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
      const configurations = await configurationMeshes(ctx, entries, null);
      const solid = solidInstead(entries, faces.length);
      if (solid) {
        ctx.log('info', `display mesh has ${faces.length} faces but the solid ${solid.stats.faces}: drawing the solid`);
        return drawMesh(
          solid.mesh,
          solid.stats.faces,
          'SolidWorks B-rep (Parasolid), triangulated by DocuView',
          {
            meshSource: 'b-rep',
            staleDisplayMesh: true,
            configurations: configurations.map,
            unavailableConfigurations: configurations.unavailable,
          },
          [
            `The picture SolidWorks stored in this file is from an earlier state of the part (${faces.length} faces; the part has ${solid.stats.faces}), so it is drawn from its exact geometry instead.`,
          ],
          mainColour(faces) ?? visualStatesColour(entries),
        );
      }
      return drawMesh(
        mesh,
        faces.length,
        'SolidWorks display mesh, read from the file',
        { meshSource: 'display', configurations: configurations.map, unavailableConfigurations: configurations.unavailable },
        [],
      );
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
        {
          meshSource: 'b-rep',
          approximatedFaces: stats.approximated + stats.skipped,
          ...(await configurationMeshes(ctx, entries, Number(/Config-(\d+)-/.exec(brep.name)?.[1] ?? 0)).then((c) => ({
            configurations: c.map,
            unavailableConfigurations: c.unavailable,
          }))),
        },
        warnings,
        visualStatesColour(entries),
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
