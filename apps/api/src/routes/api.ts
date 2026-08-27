import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { ACCEPTED_EXTENSIONS, FORMATS, formatById, type CapabilitiesResponse } from '@docuview/shared';
import { config, tmpDir } from '../config.js';
import { logger } from '../logger.js';
import { JobQueue } from '../jobs/queue.js';
import { buildRenditionRequest, executeProcessRequest, runPipeline } from '../processing/pipeline.js';
import {
  assetPath,
  createFileDir,
  extensionOf,
  newFileId,
  originalPath,
  readMeta,
  removeFile,
  sanitizeDisplayName,
  writeMeta,
  type FileMeta,
} from '../storage/store.js';

export const queue = new JobQueue(runPipeline);

const FILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCEPTED = new Set(ACCEPTED_EXTENSIONS.map((e) => e.slice(1)));

/** Content types we are willing to emit for derived assets. */
const ASSET_CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.dxf': 'application/dxf',
  // Generated document markup is served as plain text on purpose: the browser
  // must never execute it by navigating straight to the asset URL.
  '.html': 'text/plain; charset=utf-8',
  '.svg': 'text/plain; charset=utf-8',
};

const uploadLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.uploads,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many uploads from this device. Please wait a moment.', retryable: true } },
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, tmpDir),
    // The stored name is ours, never the user's.
    filename: (_req, _file, cb) => cb(null, `upload-${newFileId()}.part`),
  }),
  limits: { fileSize: config.maxUploadBytes, files: 1, fields: 4 },
  fileFilter: (_req, file, cb) => {
    const extension = extensionOf(file.originalname);
    if (extension === '' || ACCEPTED.has(extension)) {
      cb(null, true);
      return;
    }
    cb(new UploadRejected(`We don't support ".${extension}" files.`));
  },
});

class UploadRejected extends Error {}

export const api = Router();

/* ------------------------------ capabilities ------------------------------ */

api.get('/capabilities', (_req: Request, res: Response) => {
  const body: CapabilitiesResponse = {
    maxUploadBytes: config.maxUploadBytes,
    retentionSeconds: config.retentionSeconds,
    libreOffice: Boolean(config.libreOfficeBin),
    dwgConverter: Boolean(config.dwgConverterCmd),
    formats: FORMATS,
  };
  res.set('Cache-Control', 'public, max-age=300');
  res.json(body);
});

/* -------------------------------- uploads --------------------------------- */

api.post('/uploads', uploadLimiter, (req: Request, res: Response) => {
  upload.single('file')(req, res, async (err: unknown) => {
    if (err) {
      await cleanupTemp(req);
      if (err instanceof UploadRejected) {
        res.status(415).json({
          error: {
            code: 'unsupported_extension',
            message: err.message,
            hint: 'Supported formats are listed on the home page.',
            retryable: false,
          },
        });
        return;
      }
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          error: {
            code: 'file_too_large',
            message: `This file is larger than the ${Math.round(config.maxUploadBytes / 1048576)} MB limit.`,
            hint: 'Try a compressed or simplified export.',
            retryable: false,
          },
        });
        return;
      }
      logger.error({ err }, 'upload failed');
      res.status(400).json({
        error: { code: 'upload_failed', message: "We couldn't receive this file.", retryable: true },
      });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({
        error: { code: 'no_file', message: 'No file was received.', retryable: true },
      });
      return;
    }

    if (file.size === 0) {
      await fs.rm(file.path, { force: true });
      res.status(400).json({
        error: { code: 'empty_file', message: 'This file is empty.', retryable: false },
      });
      return;
    }

    const fileId = newFileId();
    const displayName = sanitizeDisplayName(file.originalname);
    const now = Date.now();
    const meta: FileMeta = {
      fileId,
      displayName,
      extension: extensionOf(displayName),
      size: file.size,
      declaredMime: String(file.mimetype ?? '').slice(0, 120),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + config.retentionSeconds * 1000).toISOString(),
    };

    try {
      await createFileDir(fileId);
      await moveFile(file.path, originalPath(fileId));
      await writeMeta(meta);
    } catch (moveErr) {
      logger.error({ err: moveErr }, 'failed to store upload');
      await fs.rm(file.path, { force: true }).catch(() => undefined);
      await removeFile(fileId).catch(() => undefined);
      res.status(500).json({
        error: { code: 'storage_failed', message: "We couldn't store this file.", retryable: true },
      });
      return;
    }

    const job = queue.enqueue({
      fileId,
      fileName: displayName,
      size: file.size,
      expiresAt: meta.expiresAt,
    });
    logger.info({ fileId, jobId: job.id, size: file.size, name: displayName }, 'upload accepted');

    res.status(202).json({ fileId, jobId: job.id, job: job.toState() });
  });
});

/* ---------------------------------- jobs ---------------------------------- */

api.get('/jobs/:jobId', (req: Request, res: Response) => {
  const job = queue.get(param(req, 'jobId'));
  if (!job) {
    res.status(404).json({
      error: {
        code: 'job_not_found',
        message: 'This document session has expired.',
        hint: 'Uploaded files are removed automatically. Please upload the file again.',
        retryable: false,
      },
    });
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.json(job.toState());
});

api.delete('/jobs/:jobId', (req: Request, res: Response) => {
  const cancelled = queue.cancel(param(req, 'jobId'));
  res.json({ cancelled });
});

/* --------------------------------- files ---------------------------------- */

api.get('/files/:fileId/raw', async (req: Request, res: Response) => {
  const meta = await requireMeta(req, res);
  if (!meta) return;

  const download = req.query.download === '1';
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(meta.size),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=600',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${asciiFileName(meta.displayName)}"`,
  });
  streamFile(originalPath(meta.fileId), res);
});

api.get('/files/:fileId/assets/:name', async (req: Request, res: Response) => {
  const meta = await requireMeta(req, res);
  if (!meta) return;

  let target: string;
  try {
    target = assetPath(meta.fileId, param(req, 'name'));
  } catch {
    res.status(400).json({ error: { code: 'bad_asset', message: 'Unknown document resource.', retryable: false } });
    return;
  }

  const extension = path.extname(target).toLowerCase();
  const contentType = ASSET_CONTENT_TYPES[extension];
  if (!contentType) {
    res.status(400).json({ error: { code: 'bad_asset', message: 'Unknown document resource.', retryable: false } });
    return;
  }

  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    res.status(404).json({ error: { code: 'asset_missing', message: 'This document resource is no longer available.', retryable: false } });
    return;
  }

  res.set({
    'Content-Type': contentType,
    'Content-Length': String(stat.size),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=600',
    'Content-Disposition': 'inline',
  });
  streamFile(target, res);
});

/**
 * Exact page layout for Word/Excel, produced on demand so the fast structural
 * view is never delayed by a full LibreOffice run.
 */
api.get('/files/:fileId/rendition/pdf', async (req: Request, res: Response) => {
  const meta = await requireMeta(req, res);
  if (!meta) return;

  if (!config.libreOfficeBin) {
    res.status(501).json({
      error: {
        code: 'engine_missing',
        message: 'The exact page layout needs LibreOffice on the server, and it is not installed.',
        hint: 'Install LibreOffice or run the app with Docker.',
        retryable: false,
      },
    });
    return;
  }

  const job = queue.findByFile(meta.fileId);
  const formatId = job?.format?.formatId;
  if (!formatId || !formatById(formatId)) {
    res.status(409).json({
      error: { code: 'not_ready', message: 'This document is still being prepared.', retryable: true },
    });
    return;
  }

  let target: string;
  try {
    target = assetPath(meta.fileId, 'rendition.pdf');
  } catch {
    res.status(400).json({ error: { code: 'bad_asset', message: 'Unknown document resource.', retryable: false } });
    return;
  }

  const exists = await fs
    .stat(target)
    .then(() => true)
    .catch(() => false);

  if (!exists) {
    try {
      await executeProcessRequest(
        buildRenditionRequest(meta.fileId, formatId, meta.extension, meta.displayName, meta.size, 'office-pdf'),
      );
    } catch (err) {
      logger.error({ err, fileId: meta.fileId }, 'rendition failed');
      res.status(500).json({
        error: {
          code: 'rendition_failed',
          message: "We couldn't build the page layout for this document.",
          hint: 'The structural view above still shows the content.',
          retryable: true,
        },
      });
      return;
    }
  }

  const stat = await fs.stat(target);
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Length': String(stat.size),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=600',
    'Content-Disposition': 'inline',
  });
  streamFile(target, res);
});

api.delete('/files/:fileId', async (req: Request, res: Response) => {
  const fileId = param(req, 'fileId');
  if (!FILE_ID_RE.test(fileId)) {
    res.status(400).json({ error: { code: 'bad_id', message: 'Unknown document.', retryable: false } });
    return;
  }
  await removeFile(fileId).catch(() => undefined);
  queue.forget(fileId);
  logger.info({ fileId }, 'file deleted on request');
  res.json({ deleted: true });
});

/* -------------------------------- helpers --------------------------------- */

/** Express 5 types a route param as `string | string[]`; ours are always single. */
function param(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[]>)[name];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

async function requireMeta(req: Request, res: Response): Promise<FileMeta | null> {
  const fileId = param(req, 'fileId');
  if (!FILE_ID_RE.test(fileId)) {
    res.status(400).json({ error: { code: 'bad_id', message: 'Unknown document.', retryable: false } });
    return null;
  }
  const meta = await readMeta(fileId);
  if (!meta) {
    res.status(404).json({
      error: {
        code: 'file_expired',
        message: 'This document is no longer available.',
        hint: 'Uploaded files are deleted automatically after a short time. Please upload it again.',
        retryable: false,
      },
    });
    return null;
  }
  return meta;
}

function streamFile(target: string, res: Response): void {
  const stream = createReadStream(target);
  stream.on('error', (err) => {
    logger.error({ err, target }, 'failed to stream file');
    if (!res.headersSent) {
      res.status(500).json({ error: { code: 'read_failed', message: "We couldn't read this document.", retryable: true } });
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
}

/** `rename` fails across devices, so fall back to a copy. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch {
    await fs.copyFile(from, to);
    await fs.rm(from, { force: true });
  }
}

async function cleanupTemp(req: Request): Promise<void> {
  const file = (req as Request & { file?: { path?: string } }).file;
  if (file?.path) await fs.rm(file.path, { force: true }).catch(() => undefined);
}

/** Header values must stay ASCII; the UI shows the real name from the job. */
function asciiFileName(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
}
