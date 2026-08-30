import fs from 'node:fs/promises';
import path from 'node:path';
import type { JobResult, NativeCadDocument } from '@docuview/shared';
import { ProcessingError, type ProcessorContext } from '../context.js';
import { convertToStep } from '../converter.js';
import { inspectNativeCad } from '../native-cad.js';
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

/** Formats whose bytes carry nothing we can show without a converter. */
const NO_PREVIEW_FORMATS = new Set(['parasolid']);

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

  /* -------------------------- 2. native preview -------------------------- */
  ctx.progress('processing', 55);
  const buffer = await fs.readFile(request.filePath);
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

  if (!previewAsset && info.properties.length === 0 && info.references.length === 0) {
    throw new ProcessingError(
      'cad_no_readable_content',
      `This ${info.application} file doesn't carry a preview we can show.`,
      NO_PREVIEW_FORMATS.has(request.formatId)
        ? 'This format stores geometry only. Export a STEP file, or configure a CAD converter on the server (CAD_CONVERTER_CMD).'
        : 'It may have been saved without a preview image. Export a STEP file, or configure a CAD converter on the server (CAD_CONVERTER_CMD).',
      false,
      `no preview, properties or references found (${info.detail.join(', ')})`,
    );
  }

  const document: NativeCadDocument = {
    application: info.application,
    version: info.version,
    role: info.role,
    preview: previewAsset,
    properties: info.properties,
    components: info.references.map((name) => ({ name, status: 'missing', jobId: null, fileId: null })),
    geometry: 'preview-only',
    note: previewAsset
      ? `${info.application} stores its geometry in a closed format, so this is the preview the CAD system saved inside the file. Measurement and sectioning need the real solid — add a STEP export, or ask your administrator to configure a CAD converter.`
      : `This ${info.application} document opened, but it was saved without a preview image. Its properties are shown below.`,
  };

  await fs.writeFile(path.join(request.assetsDir, 'native.json'), JSON.stringify(document));
  ctx.progress('preparing-geometry', 95);

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
      componentCount: info.references.length,
      // The pipeline turns these into the job's assembly state, which is what
      // the viewer polls while components are being supplied.
      componentNames: document.components.map((component) => component.name),
      converter: false,
    },
    warnings,
  };
}
