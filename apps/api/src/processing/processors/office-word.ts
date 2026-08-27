import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mammoth from 'mammoth';
import type { JobResult } from '@docuview/shared';
import { libreOfficeConvert } from '../libreoffice.js';
import { ProcessingError, type ProcessorContext } from '../context.js';

/** Formats LibreOffice must normalise into DOCX before mammoth can read them. */
const NEEDS_CONVERSION = new Set(['doc', 'rtf', 'odt']);

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/webp': 'webp',
  'image/tiff': 'png',
  'image/x-emf': 'png',
  'image/x-wmf': 'png',
};

export async function processWord(ctx: ProcessorContext): Promise<JobResult> {
  const { request } = ctx;
  await fs.mkdir(request.assetsDir, { recursive: true });

  if (request.formatId === 'txt' || request.formatId === 'csv') {
    return processPlainText(ctx);
  }

  ctx.progress('processing', 15);

  let docxPath = request.filePath;
  let workDir: string | null = null;
  const warnings: string[] = [];

  if (NEEDS_CONVERSION.has(request.formatId)) {
    workDir = path.join(os.tmpdir(), `docuview-word-${randomUUID()}`);
    // LibreOffice derives the output name from the input name, and our stored
    // file is called `original.bin`, so give it a properly suffixed copy first.
    const staged = path.join(workDir, `document.${request.formatId}`);
    await fs.mkdir(workDir, { recursive: true });
    await fs.copyFile(request.filePath, staged);
    ctx.progress('processing', 30);
    docxPath = await libreOfficeConvert({
      bin: request.options.libreOfficeBin,
      inputPath: staged,
      target: 'docx',
      outExtension: 'docx',
      outDir: path.join(workDir, 'out'),
      timeoutMs: Math.min(request.options.timeoutMs, 120_000),
    });
    warnings.push('Converted from a legacy format; some layout details may differ from the original.');
  }

  ctx.progress('processing', 55);

  try {
    let imageIndex = 0;
    const result = await mammoth.convertToHtml(
      { path: docxPath },
      {
        convertImage: mammoth.images.imgElement(async (image) => {
          const extension = IMAGE_EXTENSIONS[image.contentType] ?? 'png';
          const name = `word-image-${imageIndex++}.${extension}`;
          const buffer = await image.read('base64');
          await fs.writeFile(path.join(request.assetsDir, name), Buffer.from(buffer, 'base64'));
          const alt = (image as { altText?: string }).altText ?? '';
          return { src: `/api/v1/files/${request.fileId}/assets/${name}`, alt };
        }),
        styleMap: [
          "p[style-name='Title'] => h1.doc-title",
          "p[style-name='Subtitle'] => p.doc-subtitle",
          "p[style-name='Quote'] => blockquote",
        ],
      },
    );

    for (const message of result.messages.slice(0, 5)) {
      if (message.type === 'error') warnings.push(`Some content could not be converted: ${message.message}`);
    }
    if (result.messages.length > 5) {
      warnings.push(`${result.messages.length - 5} more conversion notes were omitted.`);
    }

    const html = sanitizeHtml(result.value);
    if (html.trim().length === 0) {
      warnings.push('This document appears to be empty, or its content is stored in an unsupported way.');
    }
    await fs.writeFile(path.join(request.assetsDir, 'document.html'), html, 'utf8');
    ctx.progress('preparing-geometry', 90);

    return {
      kind: 'office',
      viewer: 'office-word',
      source: `/api/v1/files/${request.fileId}/assets/document.html`,
      meta: {
        formatId: request.formatId,
        words: countWords(html),
        images: imageIndex,
        /** The Word viewer offers an exact page layout via this rendition. */
        pdfRendition: request.options.libreOfficeBin ? `/api/v1/files/${request.fileId}/rendition/pdf` : null,
        producer: 'mammoth',
      },
      warnings,
    };
  } catch (err) {
    if (err instanceof ProcessingError) throw err;
    throw new ProcessingError(
      'conversion_failed',
      "We couldn't read this document.",
      'The file may be corrupted or password protected.',
      false,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function processPlainText(ctx: ProcessorContext): Promise<JobResult> {
  const { request } = ctx;
  const MAX_TEXT_BYTES = 5 * 1024 * 1024;
  const warnings: string[] = [];
  const handle = await fs.open(request.filePath, 'r');
  let text: string;
  try {
    const length = Math.min(request.size, MAX_TEXT_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    text = buffer.toString('utf8');
    if (request.size > MAX_TEXT_BYTES) {
      warnings.push('Only the first 5 MB of this text file are shown.');
    }
  } finally {
    await handle.close();
  }

  const html = `<pre class="doc-plain">${escapeHtml(text)}</pre>`;
  await fs.writeFile(path.join(request.assetsDir, 'document.html'), html, 'utf8');

  return {
    kind: 'office',
    viewer: 'office-word',
    source: `/api/v1/files/${request.fileId}/assets/document.html`,
    meta: { formatId: request.formatId, words: countWords(text), images: 0, pdfRendition: null, producer: 'plain-text' },
    warnings,
  };
}

function countWords(html: string): number {
  return (html.replace(/<[^>]+>/g, ' ').match(/\S+/g) ?? []).length;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Belt-and-braces allowlist pass over generated HTML.
 *
 * mammoth already escapes document text, but this output is injected into the
 * page, so nothing script-shaped is allowed to reach the browser regardless of
 * what the upstream library does.
 */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta|base|form)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/(href|src)\s*=\s*"\s*javascript:[^"]*"/gi, '$1="#"')
    .replace(/(href|src)\s*=\s*'\s*javascript:[^']*'/gi, "$1='#'");
}
