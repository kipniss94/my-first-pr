import fs from 'node:fs/promises';
import path from 'node:path';
import type { JobResult, NativeCadDocument } from '@docuview/shared';
import { ProcessingError, type ProcessorContext } from '../context.js';
import { convertToStep } from '../converter.js';
import { inspectNativeCad } from '../native-cad.js';
import { findModelPartition, findParasolidPartitions, isSolidWorksPackage } from '../sldprt/container.js';
import { boundsOf, readPoints, type ParasolidBounds } from '../sldprt/parasolid.js';
import { processOcct } from './cad-occt.js';

/**
 * Open a native CAD document — SolidWorks, Inventor, CATIA, Revit, Parasolid —
 * without asking anyone to re-export it first.
 *
 * Two routes, taken in order:
 *
 *  1. If the operator configured a licensed converter, the file is converted to
 *     STEP and goes through the ordinary OpenCascade path, so it arrives with
 *     full geometry, an assembly tree, measurement and sectioning.
 *  2. Otherwise the document is opened from what it carries itself: the preview
 *     the CAD system rendered, its document properties, and — for an assembly —
 *     the list of components it references, which the viewer then asks for.
 *
 * The second route is a real view of the document, and the UI says plainly that
 * it is a preview rather than measurable geometry.
 */

export async function processProprietaryCad(ctx: ProcessorContext): Promise<JobResult> {
  const { request } = ctx;
  ctx.progress('processing', 8);

  const converterCmd = request.options.cadConverterCmd;
  const warnings: string[] = [];

  /* ---------------------- 1. licensed converter path --------------------- */
  if (converterCmd) {
    try {
      ctx.log('info', `converting ${request.formatId} with the configured CAD converter`);
      const stepPath = await convertToStep({
        command: converterCmd,
        inputPath: request.filePath,
        outDir: path.join(request.assetsDir, 'convert'),
        informat: request.extension,
        timeoutMs: request.options.timeoutMs,
        log: ctx.log,
      });
      ctx.progress('processing', 45);

      const stat = await fs.stat(stepPath);
      const result = await processOcct({
        ...ctx,
        request: { ...request, filePath: stepPath, formatId: 'step', size: stat.size },
      });
      result.meta = { ...result.meta, formatId: request.formatId, convertedVia: 'server converter' };
      return result;
    } catch (err) {
      // A converter failure must not lose the document: fall through to the
      // preview, and say why the full model is missing.
      const message = err instanceof ProcessingError ? err.message : "The CAD converter on this server couldn't read this file.";
      ctx.log('warn', `converter failed, falling back to the stored preview: ${message}`);
      warnings.push(`${message} The document is shown from the preview stored inside it.`);
    }
  }

  /* --------------- 2. the geometry a modern SolidWorks carries ------------ */
  ctx.progress('processing', 40);
  const buffer = await fs.readFile(request.filePath);

  /*
   * A current SolidWorks part is not an OLE compound file at all — it is a
   * package of its own, and the model inside it is an ordinary Parasolid
   * transmit stream under plain zlib. Pulling that out is worth doing even
   * before we can draw it: it is the exact geometry, it is a format other
   * tools accept, and having it is what lets the converter path work on a
   * standard `.x_t` rather than on a closed SolidWorks file.
   */
  let parasolid: { bytes: number; version: string | null; coordinates: number } | null = null;
  /** The model partition is missing, but the stub that references it is here. */
  let stubOnly = false;
  let vertices: ReturnType<typeof readPoints> = [];
  let bounds: ParasolidBounds | null = null;
  // Not gated on recognising the package: the payload scan verifies itself, so
  // trying it costs one pass and cannot produce a wrong answer, whereas gating
  // on a signature meant a stricter recogniser silently discarded geometry the
  // reader was perfectly able to extract.
  const model = findModelPartition(buffer);
  if (model) {
    await fs.mkdir(request.assetsDir, { recursive: true });
    await fs.writeFile(path.join(request.assetsDir, 'geometry.x_t'), model.data);
    parasolid = { bytes: model.data.length, version: model.version, coordinates: model.coordinates };
    ctx.log('info', `extracted a ${model.data.length} B Parasolid model with ${model.coordinates} coordinates (modeller ${model.version})`);

    // The vertices are readable even though the rest of the node graph is not,
    // and they are worth reading: a size taken from the model itself is the
    // first thing about this file that is a measurement rather than a promise.
    vertices = readPoints(model.data);
    bounds = boundsOf(vertices);
    if (bounds) {
      const { x, y, z } = bounds.sizeMm;
      ctx.log('info', `measured ${x.toFixed(1)} x ${y.toFixed(1)} x ${z.toFixed(1)} mm from ${vertices.length} vertices`);
    }
  } else if (findParasolidPartitions(buffer).length > 0) {
    stubOnly = true;
    // The distinction matters to the person looking at the file. A stub-only
    // part is not a file we failed to parse — it is one whose model SolidWorks
    // put behind the codec, leaving a reference frame we can read and nothing
    // to draw. Writing that stub out as `geometry.x_t` would hand someone an
    // empty solid and call it geometry.
    ctx.log('warn', 'only stub Parasolid streams here: the model partition is behind the codec');
  } else if (isSolidWorksPackage(buffer)) {
    ctx.log('warn', 'SolidWorks package recognised, but no Parasolid stream is plain zlib');
  }

  ctx.progress('processing', 55);
  const info = inspectNativeCad(buffer, request.formatId, request.extension);
  ctx.log('info', `native inspection: ${info.detail.join(', ') || 'nothing found'}`);

  ctx.progress('preparing-geometry', 75);
  await fs.mkdir(request.assetsDir, { recursive: true });

  let previewAsset: NativeCadDocument['preview'] = null;
  if (info.preview) {
    const name = `preview.${info.preview.extension}`;
    await fs.writeFile(path.join(request.assetsDir, name), info.preview.data);
    previewAsset = {
      url: `/api/v1/files/${request.fileId}/assets/${name}`,
      width: info.preview.width,
      height: info.preview.height,
      contentType: info.preview.contentType,
    };
  }

  /*
   * Nothing readable is a result, not a crash. Some SolidWorks packages keep
   * every payload behind a codec we cannot open — the entry names decode, the
   * sizes are there, and the bytes are indistinguishable from random. The
   * document still opens, saying exactly that, because a dead end with a
   * "reference: CAD_NO_READABLE_CONTENT" tells the person nothing they can act
   * on.
   */
  const opaque = !previewAsset && !parasolid && info.properties.length === 0 && info.references.length === 0;
  if (opaque) {
    ctx.log('warn', 'no readable payload: every part of this package uses a codec we cannot open');
  }

  const document: NativeCadDocument = {
    application: info.application,
    version: info.version,
    role: info.role,
    preview: previewAsset,
    properties: info.properties,
    components: info.references.map((name) => ({ name, status: 'missing', jobId: null, fileId: null })),
    geometry: 'preview-only',
    measured: bounds ? { sizeMm: bounds.sizeMm, vertices: vertices.length } : null,
    note: parasolid
      ? `The exact geometry was found inside this file — a ${(parasolid.bytes / 1024).toFixed(1)} KB Parasolid solid carrying ${parasolid.coordinates} distinct coordinates, written by modeller ${parasolid.version ?? 'unknown'} — and extracted.${
          bounds
            ? ` Its vertices read as a part measuring ${bounds.sizeMm.x.toFixed(1)} × ${bounds.sizeMm.y.toFixed(1)} × ${bounds.sizeMm.z.toFixed(1)} mm.`
            : ' Its vertices could not be read, which is normal for a turned or revolved part: those have no corners to read.'
        } Drawing the solid needs the rest of the Parasolid schema, which is still being worked out; until then it can be downloaded as a standard .x_t, or a configured converter will turn it into geometry you can measure.`
      : stubOnly
      ? `This file names its solid but does not hand it over: SolidWorks wrote the reference frame in the clear and kept the model itself behind a codec we cannot open yet. That is a different thing from a file we failed to parse, and it is why nothing is offered for download here rather than an empty solid. About a third of the parts tested behave this way. A configured CAD converter reads this one.`
      : opaque
        ? `This ${info.application} file keeps all of its content behind a codec we cannot open yet. The package structure reads fine — the parts are named and sized — but their bytes are indistinguishable from random, so there is nothing here to show. Around a third of the files tested behave this way; the rest open. A configured CAD converter handles this one.`
        : previewAsset
          ? `${info.application} stores its geometry in a closed format, so this is the preview the CAD system saved inside the file. Measurement and sectioning need the real solid — add a STEP export, or ask your administrator to configure a CAD converter.`
          : `This ${info.application} document opened, but it was saved without a preview image. Its properties are shown below.`,
  };

  await fs.writeFile(path.join(request.assetsDir, 'native.json'), JSON.stringify(document));
  ctx.progress('preparing-geometry', 95);

  if (opaque) {
    warnings.push('Nothing in this file could be opened: every part of it uses a codec we cannot read yet.');
  }

  if (info.role === 'assembly' && info.references.length > 0) {
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
      role: info.role,
      hasPreview: Boolean(previewAsset),
      parasolidBytes: parasolid?.bytes ?? 0,
      parasolidVersion: parasolid?.version ?? null,
      parasolidCoordinates: parasolid?.coordinates ?? 0,
      vertexCount: vertices.length,
      sizeMm: bounds ? [bounds.sizeMm.x, bounds.sizeMm.y, bounds.sizeMm.z] : null,
      parasolidUrl: parasolid ? `/api/v1/files/${request.fileId}/assets/geometry.x_t` : null,
      componentCount: info.references.length,
      // The pipeline turns these into the job's assembly state, which is what
      // the viewer polls while components are being supplied.
      componentNames: document.components.map((component) => component.name),
      converter: false,
    },
    warnings,
  };
}
