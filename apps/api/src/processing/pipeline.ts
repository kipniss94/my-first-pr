import type { JobResult, ViewerId } from '@docuview/shared';
import { config } from '../config.js';
import { UserFacingError, type JobRecord, type ProgressReporter } from '../jobs/queue.js';
import { logger } from '../logger.js';
import { assetsDir, originalPath, readMeta } from '../storage/store.js';
import { detectFormat } from './detect.js';
import { ProcessingPool } from './pool.js';
import type { ProcessRequest } from './types.js';

export type { ProcessRequest } from './types.js';

/** Shared warm worker pool for every server-side format. */
export const pool = new ProcessingPool();

/** Run one processing request on the pool. */
export function executeProcessRequest(
  request: ProcessRequest,
  report: ProgressReporter = () => undefined,
  setAbort: (abort: () => void) => void = () => undefined,
): Promise<JobResult> {
  return pool.submit(request, report, setAbort);
}

/** Which viewer a client-parsed format maps to. */
const CLIENT_VIEWERS: Record<string, ViewerId> = {
  stl: 'cad-mesh',
  obj: 'cad-mesh',
  ply: 'cad-mesh',
  gltf: 'cad-mesh',
  '3mf': 'cad-mesh',
  fbx: 'cad-mesh',
  dae: 'cad-mesh',
  dxf: 'cad-dxf',
  pdf: 'pdf',
  image: 'image',
};

/**
 * Formats we recognise but genuinely cannot open yet. Native CAD is no longer
 * on this list: those files go to `cad-proprietary`, which opens them from the
 * preview and properties they carry, or converts them when the server has a
 * licensed converter configured.
 */
const UNSUPPORTED_HINTS: Record<string, string> = {
  ifc: 'IFC/BIM support is scheduled for the next stage.',
};

/**
 * Stage 1 of every job: work out what the file actually is.
 * Runs in the API process because it only reads a few kilobytes.
 */
export async function runPipeline(job: JobRecord, report: ProgressReporter): Promise<JobResult> {
  const meta = await readMeta(job.input.fileId);
  if (!meta) {
    throw new UserFacingError('file_missing', 'This file is no longer available.', 'Uploaded files are deleted automatically. Please upload it again.');
  }

  report('detecting', 20);
  const filePath = originalPath(job.input.fileId);
  const detection = await detectFormat(filePath, meta.extension, meta.size);
  logger.info(
    { fileId: job.input.fileId, detail: detection.detail, format: detection.format?.id ?? null },
    'format detected',
  );

  if (!detection.format) {
    throw new UserFacingError(
      'unknown_format',
      "We couldn't recognise this file type.",
      'Check that the file is not corrupted, or try one of the supported formats listed on the home page.',
    );
  }

  const format = detection.format;
  job.format = {
    formatId: format.id,
    label: format.label,
    kind: format.kind,
    pipeline: format.pipeline,
    support: format.support,
    version: detection.version,
    extensionMismatch: detection.extensionMismatch,
  };

  if (format.pipeline === 'unsupported') {
    throw new UserFacingError(
      'unsupported_format',
      `${format.label} files can't be opened in the browser yet.`,
      UNSUPPORTED_HINTS[format.id] ?? 'Try exporting the model to STEP, STL or 3MF.',
    );
  }

  const warnings: string[] = [];
  if (detection.extensionMismatch) {
    warnings.push(
      `The file is named ".${meta.extension}" but its contents are ${format.label}. It was opened as ${format.label}.`,
    );
  }

  /* ---- client-side formats stream straight to the browser --------------- */
  if (format.pipeline === 'client') {
    report('loading-viewer', 100);
    return {
      kind: format.kind,
      viewer: CLIENT_VIEWERS[format.id] ?? 'none',
      source: `/api/v1/files/${job.input.fileId}/raw`,
      meta: {
        formatId: format.id,
        formatLabel: format.label,
        version: detection.version,
      },
      warnings,
    };
  }

  /* ---- server-side formats go through the isolated runner --------------- */
  report('processing', -1);
  const request: ProcessRequest = {
    fileId: job.input.fileId,
    filePath,
    assetsDir: assetsDir(job.input.fileId),
    formatId: format.id,
    processor: format.processor ?? 'unknown',
    extension: meta.extension,
    displayName: meta.displayName,
    size: meta.size,
    options: {
      libreOfficeBin: config.libreOfficeBin,
      dwgConverterCmd: config.dwgConverterCmd,
      cadConverterCmd: config.cadConverterCmd,
      timeoutMs: config.processingTimeoutMs,
    },
  };

  const result = await executeProcessRequest(request, report, (abort) => {
    job.abort = abort;
  });
  result.warnings = [...warnings, ...result.warnings];
  attachAssembly(job, result);
  return result;
}

/**
 * Record the components an assembly is waiting for.
 *
 * The viewer reads this straight off the job, asks for the missing files, and
 * draws each component as its own job finishes — so a big assembly appears
 * piece by piece instead of all at once at the end.
 */
function attachAssembly(job: JobRecord, result: JobResult): void {
  const names = result.meta.componentNames;
  if (result.meta.role !== 'assembly' || !Array.isArray(names) || names.length === 0) return;
  job.assembly = {
    role: 'assembly',
    components: names
      .filter((name): name is string => typeof name === 'string')
      .map((name) => ({ name, status: 'missing' as const, jobId: null, fileId: null })),
    updatedAt: new Date().toISOString(),
  };
}

/** Build a `ProcessRequest` for an on-demand rendition of an already stored file. */
export function buildRenditionRequest(
  fileId: string,
  formatId: string,
  extension: string,
  displayName: string,
  size: number,
  processor: string,
): ProcessRequest {
  return {
    fileId,
    filePath: originalPath(fileId),
    assetsDir: assetsDir(fileId),
    formatId,
    processor,
    extension,
    displayName,
    size,
    options: {
      libreOfficeBin: config.libreOfficeBin,
      dwgConverterCmd: config.dwgConverterCmd,
      cadConverterCmd: config.cadConverterCmd,
      timeoutMs: config.processingTimeoutMs,
    },
  };
}
