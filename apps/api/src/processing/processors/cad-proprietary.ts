import fs from 'node:fs/promises';
import path from 'node:path';
import type { JobResult, NativeCadDocument } from '@docuview/shared';
import { ProcessingError, type ProcessorContext } from '../context.js';
import { convertToStep } from '../converter.js';
import { inspectNativeCad } from '../native-cad.js';
import { findModelPartition, findParasolidPartitions, findPreviewPng, readPackage } from '../sldprt/container.js';
import { findDisplayMesh, measureMesh, toIndexedMesh } from '../sldprt/display-list.js';
import { processOcct, writeNmg } from './cad-occt.js';

/**
 * Open a native CAD document — SolidWorks, Inventor, CATIA, Revit, Parasolid —
 * without asking anyone to re-export it and without any CAD on the machine.
 *
 * For a SolidWorks part the file itself is enough. It is a ZIP archive in
 * disguise, and it carries three things this reads directly:
 *
 *  1. The display mesh — SolidWorks' own triangulation of every face, with its
 *     normals. That is what is drawn: real 3D you can rotate, section and
 *     measure, identical to what SolidWorks showed.
 *  2. The exact B-rep as a Parasolid stream, saved alongside as `geometry.x_t`
 *     for anyone who needs the precise solid in another tool.
 *  3. The preview image SolidWorks rendered at the last save.
 *
 * Only when a file carries no display mesh — an assembly, which references its
 * parts rather than containing them, or a format other than SolidWorks — does
 * this fall back: to a converter if an operator configured one, and otherwise
 * to the preview, properties and component list, said plainly.
 */

export async function processProprietaryCad(ctx: ProcessorContext): Promise<JobResult> {
  const { request } = ctx;
  ctx.progress('processing', 8);
  await fs.mkdir(request.assetsDir, { recursive: true });

  const buffer = await fs.readFile(request.filePath);
  const entries = readPackage(buffer);
  ctx.log('info', `package: ${entries.length} verified entries`);
  ctx.progress('processing', 30);

  /* ------------------------------- exact B-rep ----------------------------- */
  const model = findModelPartition(buffer, entries);
  if (model) {
    await fs.writeFile(path.join(request.assetsDir, 'geometry.x_t'), model.data);
    ctx.log('info', `Parasolid model: ${model.data.length} B, modeller ${model.version}`);
  }
  const parasolidMeta = {
    parasolidBytes: model?.data.length ?? 0,
    parasolidVersion: model?.version ?? null,
    parasolidUrl: model ? `/api/v1/files/${request.fileId}/assets/geometry.x_t` : null,
  };

  /* ------------------------------- display mesh ---------------------------- */
  ctx.progress('processing', 45);
  const faces = findDisplayMesh(entries);
  if (faces.length > 0) {
    const mesh = toIndexedMesh(faces);
    if (mesh.triangles > 0) {
      ctx.progress('preparing-geometry', 70);
      const name = request.displayName.replace(/\.[^.]+$/, '') || 'Part';
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
        'SolidWorks display mesh, read from the file',
      );
      const measured = measureMesh(mesh);
      ctx.log(
        'info',
        `display mesh: ${faces.length} faces, ${mesh.triangles} triangles, ${measured.size.map((v) => v.toFixed(1)).join(' x ')} mm`,
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
          faces: faces.length,
          units: manifest.units,
          producer: manifest.producer,
          sizeMm: measured.size,
          volumeMm3: measured.volume,
          areaMm2: measured.area,
          ...parasolidMeta,
        },
        warnings: manifest.warnings,
      };
    }
  }

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
      result.meta = { ...result.meta, formatId: request.formatId, convertedVia: 'server converter', ...parasolidMeta };
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

  let previewAsset: NativeCadDocument['preview'] = null;
  const png = findPreviewPng(entries);
  if (png) {
    await fs.writeFile(path.join(request.assetsDir, 'preview.png'), png);
    previewAsset = {
      url: `/api/v1/files/${request.fileId}/assets/preview.png`,
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
      contentType: 'image/png',
    };
  } else if (info.preview) {
    const name = `preview.${info.preview.extension}`;
    await fs.writeFile(path.join(request.assetsDir, name), info.preview.data);
    previewAsset = {
      url: `/api/v1/files/${request.fileId}/assets/${name}`,
      width: info.preview.width,
      height: info.preview.height,
      contentType: info.preview.contentType,
    };
  }

  const isAssembly = info.role === 'assembly' || request.extension === 'sldasm';
  const stubOnly = !model && findParasolidPartitions(buffer, entries).length > 0;

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
      ...parasolidMeta,
    },
    warnings,
  };
}
