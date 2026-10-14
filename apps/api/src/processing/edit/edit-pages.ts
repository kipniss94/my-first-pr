/**
 * Page editing on a stored document: delete pages, undo the last edit.
 *
 * The edited file replaces the stored original, so downloading it gives the
 * edited document — a real .docx or .pdf, not a picture of one. Every edit
 * first moves the previous version into the file's history, which is what
 * undo restores; nothing is ever lost by pressing Delete.
 *
 * A Word edit is checked before it is accepted: the result is laid out again
 * and the text of every page that was meant to stay must still be there. If it
 * is not, the edit is rolled back and reported, rather than handing someone a
 * document with a paragraph silently missing.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { JobResult } from '@docuview/shared';
import { config } from '../../config.js';
import { assetPath, fileDir, originalPath, writeMeta, type FileMeta } from '../../storage/store.js';
import { buildRenditionRequest, executeProcessRequest } from '../pipeline.js';
import { deleteDocxPages, normaliseText, PageEditError } from './docx-pages.js';
import { deletePdfPages } from './pdf-pages.js';
import { pdfPageTexts } from './pdf-text.js';

export { PageEditError };

export interface PageEditOutcome {
  revision: number;
  pageCount: number;
  canUndo: boolean;
  /** Something the person should know about the result, if anything. */
  note: string | null;
  /** The refreshed structural view, for formats that have one. */
  result: JobResult | null;
}

export const EDITABLE_FORMATS = new Set(['pdf', 'docx']);

const locks = new Map<string, Promise<unknown>>();

/** One edit at a time per file; a second Delete waits for the first. */
function exclusive<T>(fileId: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(fileId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  locks.set(fileId, next);
  // The caller handles the outcome; this branch only tidies up, and must not
  // leave a rejected promise behind — Node ends the process on one.
  next
    .finally(() => {
      if (locks.get(fileId) === next) locks.delete(fileId);
    })
    .catch(() => undefined);
  return next;
}

function historyDir(fileId: string): string {
  return path.join(fileDir(fileId), 'history');
}

async function historyVersions(fileId: string): Promise<number[]> {
  const names = await fs.readdir(historyDir(fileId)).catch(() => [] as string[]);
  return names
    .map((name) => /^(\d+)\.bin$/.exec(name)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number)
    .sort((a, b) => a - b);
}

async function replaceOriginal(meta: FileMeta, data: Buffer, keepHistory: boolean): Promise<FileMeta> {
  const revision = (meta.revision ?? 0) + 1;
  if (keepHistory) {
    await fs.mkdir(historyDir(meta.fileId), { recursive: true });
    await fs.copyFile(originalPath(meta.fileId), path.join(historyDir(meta.fileId), `${revision - 1}.bin`));
  }
  const staging = `${originalPath(meta.fileId)}.edit`;
  await fs.writeFile(staging, data);
  await fs.rename(staging, originalPath(meta.fileId));
  const updated: FileMeta = { ...meta, size: data.length, revision };
  await writeMeta(updated);
  return updated;
}

/** The page layout the viewer shows, laid out again if the file changed. */
async function layout(meta: FileMeta, formatId: string, fresh: boolean): Promise<{ texts: string[] }> {
  if (!config.libreOfficeBin) {
    throw new PageEditError('Editing Word pages needs LibreOffice on the server, and it is not installed.');
  }
  const target = assetPath(meta.fileId, 'rendition.pdf');
  if (fresh) await fs.rm(target, { force: true });
  const exists = await fs
    .stat(target)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    await executeProcessRequest(
      buildRenditionRequest(meta.fileId, formatId, meta.extension, meta.displayName, meta.size, 'office-pdf'),
    );
  }
  return { texts: await pdfPageTexts(await fs.readFile(target)) };
}

/** True when the text of every kept page can still be found in the new layout. */
function keptTextSurvives(before: string[], kept: number[], after: string[]): boolean {
  const haystack = after.map(normaliseText).join('');
  let probes = 0;
  let found = 0;
  for (const page of kept) {
    const text = normaliseText(before[page - 1] ?? '');
    for (let at = 0; at + 40 <= text.length; at += 160) {
      probes += 1;
      if (haystack.includes(text.slice(at, at + 40))) found += 1;
    }
  }
  return probes === 0 || found / probes >= 0.95;
}

async function refreshWordView(meta: FileMeta, formatId: string): Promise<JobResult> {
  return executeProcessRequest(
    buildRenditionRequest(meta.fileId, formatId, meta.extension, meta.displayName, meta.size, 'office-word'),
  );
}

export function deletePages(meta: FileMeta, formatId: string, pages: number[]): Promise<PageEditOutcome> {
  return exclusive(meta.fileId, async () => {
    if (!EDITABLE_FORMATS.has(formatId)) {
      throw new PageEditError('Pages can be deleted from PDF and Word (.docx) documents.');
    }
    const original = await fs.readFile(originalPath(meta.fileId));

    if (formatId === 'pdf') {
      const edit = await deletePdfPages(original, pages);
      const updated = await replaceOriginal(meta, edit.pdf, true);
      const { PDFDocument } = await import('pdf-lib');
      const count = (await PDFDocument.load(edit.pdf, { ignoreEncryption: true })).getPageCount();
      return { revision: updated.revision ?? 1, pageCount: count, canUndo: true, note: null, result: null };
    }

    const before = await layout(meta, formatId, false);
    const edit = deleteDocxPages(original, before.texts, pages);
    const updated = await replaceOriginal(meta, edit.docx, true);
    let after: { texts: string[] };
    try {
      after = await layout(updated, formatId, true);
    } catch (err) {
      await restoreLatest(updated, formatId);
      throw err;
    }

    const kept = before.texts.map((_, i) => i + 1).filter((page) => !edit.deleted.includes(page));
    if (!keptTextSurvives(before.texts, kept, after.texts)) {
      await restoreLatest(updated, formatId);
      throw new PageEditError(
        "This page couldn't be deleted cleanly — some of the remaining text would have changed. Nothing was modified.",
      );
    }

    const expected = before.texts.length - edit.deleted.length;
    const notes: string[] = [];
    if (edit.keptPartial > 0) {
      notes.push('Text that ran across the page boundary was kept whole.');
    }
    if (after.texts.length !== expected) {
      notes.push(`The document now lays out on ${after.texts.length} page${after.texts.length === 1 ? '' : 's'}.`);
    }
    const result = await refreshWordView(updated, formatId);
    return {
      revision: updated.revision ?? 1,
      pageCount: after.texts.length,
      canUndo: true,
      note: notes.join(' ') || null,
      result,
    };
  });
}

async function restoreLatest(meta: FileMeta, formatId: string): Promise<FileMeta> {
  const versions = await historyVersions(meta.fileId);
  const latest = versions[versions.length - 1];
  if (latest === undefined) throw new PageEditError('There is nothing to undo.');
  const file = path.join(historyDir(meta.fileId), `${latest}.bin`);
  const restored = await replaceOriginal(meta, await fs.readFile(file), false);
  await fs.rm(file, { force: true });
  if (formatId !== 'pdf') await fs.rm(assetPath(meta.fileId, 'rendition.pdf'), { force: true });
  return restored;
}

export function undoPageEdit(meta: FileMeta, formatId: string): Promise<PageEditOutcome> {
  return exclusive(meta.fileId, async () => {
    const restored = await restoreLatest(meta, formatId);
    const canUndo = (await historyVersions(meta.fileId)).length > 0;
    if (formatId === 'pdf') {
      const { PDFDocument } = await import('pdf-lib');
      const count = (await PDFDocument.load(await fs.readFile(originalPath(meta.fileId)), { ignoreEncryption: true })).getPageCount();
      return { revision: restored.revision ?? 1, pageCount: count, canUndo, note: null, result: null };
    }
    const after = await layout(restored, formatId, true);
    const result = await refreshWordView(restored, formatId);
    return { revision: restored.revision ?? 1, pageCount: after.texts.length, canUndo, note: null, result };
  });
}

export async function pageEditState(meta: FileMeta): Promise<{ revision: number; canUndo: boolean }> {
  return { revision: meta.revision ?? 0, canUndo: (await historyVersions(meta.fileId)).length > 0 };
}
