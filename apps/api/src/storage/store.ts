import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, tmpDir, uploadsDir } from '../config.js';
import { logger } from '../logger.js';

/** Metadata persisted next to every upload. Never leaves the server verbatim. */
export interface FileMeta {
  fileId: string;
  /** Original name, sanitised for display only. */
  displayName: string;
  /** Lower-case extension without the dot, derived from the original name. */
  extension: string;
  size: number;
  /** MIME type the browser claimed. Advisory only — never trusted. */
  declaredMime: string;
  createdAt: string;
  expiresAt: string;
}

const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function initStorage(): Promise<void> {
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.mkdir(tmpDir, { recursive: true });
}

export function fileDir(fileId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(fileId)) throw new Error('invalid file id');
  return path.join(uploadsDir, fileId);
}

export function originalPath(fileId: string): string {
  // The upload is always stored under a generated name. The user supplied name
  // is kept in meta.json for display and never touches the filesystem.
  return path.join(fileDir(fileId), 'original.bin');
}

export function assetsDir(fileId: string): string {
  return path.join(fileDir(fileId), 'assets');
}

/** Resolve an asset path, refusing anything that escapes the asset directory. */
export function assetPath(fileId: string, name: string): string {
  if (!ASSET_NAME_RE.test(name)) throw new Error('invalid asset name');
  const dir = assetsDir(fileId);
  const resolved = path.resolve(dir, name);
  if (resolved !== path.join(dir, name)) throw new Error('invalid asset name');
  return resolved;
}

/**
 * Undo the latin-1 reading of a multipart file name.
 *
 * Browsers put the file name into the `Content-Disposition` header as raw
 * UTF-8 bytes, but RFC 7578 leaves the encoding unstated and busboy therefore
 * decodes each byte as latin-1, so a Cyrillic name arrives as twice as many
 * Western-European letters — every non-ASCII name mangled, which for a
 * Cyrillic or CJK part library is every file in it.
 *
 * Re-encoding to bytes and decoding as UTF-8 reverses that exactly. The strict
 * decoder is what makes it safe to do unconditionally: a name that was never
 * mis-decoded UTF-8 fails to parse and is returned untouched, and pure ASCII
 * round-trips to itself.
 */
function decodeUploadName(name: string): string {
  if (!/[\u0080-\u00ff]/.test(name)) return name;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(name, 'latin1'));
  } catch {
    return name;
  }
}

/** Strip directory components and control characters from a user file name. */
export function sanitizeDisplayName(name: string): string {
  const base = decodeUploadName(name).split(/[\\/]/).pop() ?? 'document';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (cleaned || 'document').slice(0, 180);
}

export function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9_]{1,12})$/.exec(name);
  return match ? match[1].toLowerCase() : '';
}

export function newFileId(): string {
  return randomUUID();
}

export async function createFileDir(fileId: string): Promise<string> {
  const dir = fileDir(fileId);
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  return dir;
}

export async function writeMeta(meta: FileMeta): Promise<void> {
  await fs.writeFile(path.join(fileDir(meta.fileId), 'meta.json'), JSON.stringify(meta, null, 2));
}

export async function readMeta(fileId: string): Promise<FileMeta | null> {
  try {
    const raw = await fs.readFile(path.join(fileDir(fileId), 'meta.json'), 'utf8');
    return JSON.parse(raw) as FileMeta;
  } catch {
    return null;
  }
}

export async function removeFile(fileId: string): Promise<void> {
  await fs.rm(fileDir(fileId), { recursive: true, force: true });
}

/**
 * Delete every upload past its retention window. Runs on an interval and once
 * at boot so a crashed process cannot leak user data indefinitely.
 */
export async function sweepExpired(now = Date.now()): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(uploadsDir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const dir = path.join(uploadsDir, entry);
    try {
      const meta = await readMeta(entry).catch(() => null);
      let expired: boolean;
      if (meta) {
        expired = Date.parse(meta.expiresAt) <= now;
      } else {
        // No metadata (crash mid-upload): fall back to the directory mtime.
        const stat = await fs.stat(dir);
        expired = stat.mtimeMs + config.retentionSeconds * 1000 <= now;
      }
      if (expired) {
        await fs.rm(dir, { recursive: true, force: true });
        removed += 1;
      }
    } catch (err) {
      logger.warn({ err, entry }, 'sweep failed for entry');
    }
  }
  // Orphaned temp files from aborted uploads.
  try {
    for (const entry of await fs.readdir(tmpDir)) {
      const target = path.join(tmpDir, entry);
      const stat = await fs.stat(target);
      if (stat.mtimeMs + 15 * 60 * 1000 <= now) {
        await fs.rm(target, { recursive: true, force: true });
      }
    }
  } catch {
    /* tmp dir may not exist yet */
  }
  if (removed > 0) logger.info({ removed }, 'expired uploads removed');
  return removed;
}

export function startSweeper(): NodeJS.Timeout {
  void sweepExpired();
  const timer = setInterval(() => {
    void sweepExpired();
  }, config.sweepIntervalSeconds * 1000);
  timer.unref();
  return timer;
}
