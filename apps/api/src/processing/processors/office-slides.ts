import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { JobResult } from '@docuview/shared';
import { libreOfficeConvert } from '../libreoffice.js';
import { readOutline, readSlides, writeMedia, type SlideOutlineEntry } from '../pptx.js';
import { ProcessingError, type ProcessorContext } from '../context.js';

/**
 * Presentations take the LibreOffice→PDF route because slide layout is the
 * whole point of the format and no JavaScript library reproduces it faithfully.
 * The outline (titles + speaker notes) is read straight from the OOXML so the
 * side panel stays useful, and a native renderer covers hosts without
 * LibreOffice.
 */
export async function processSlides(ctx: ProcessorContext): Promise<JobResult> {
  const { request } = ctx;
  await fs.mkdir(request.assetsDir, { recursive: true });

  let outline: SlideOutlineEntry[] = [];
  if (request.formatId === 'pptx') {
    try {
      outline = await readOutline(request.filePath);
    } catch (err) {
      ctx.log('warn', `could not read pptx outline: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (request.options.libreOfficeBin) {
    return renderWithLibreOffice(ctx, outline);
  }

  if (request.formatId !== 'pptx') {
    throw new ProcessingError(
      'engine_missing',
      'This presentation format needs LibreOffice on the server, and it is not installed.',
      'Install LibreOffice, run the app with Docker, or save the file as PPTX.',
      false,
      'no LibreOffice and format is not pptx',
    );
  }

  return renderNatively(ctx);
}

async function renderWithLibreOffice(ctx: ProcessorContext, outline: SlideOutlineEntry[]): Promise<JobResult> {
  const { request } = ctx;
  ctx.progress('processing', 25);

  const workDir = path.join(os.tmpdir(), `docuview-slides-${randomUUID()}`);
  const staged = path.join(workDir, `deck.${request.formatId}`);
  await fs.mkdir(workDir, { recursive: true });
  await fs.copyFile(request.filePath, staged);

  try {
    const pdfPath = await libreOfficeConvert({
      bin: request.options.libreOfficeBin,
      inputPath: staged,
      target: 'pdf:impress_pdf_Export',
      outExtension: 'pdf',
      outDir: path.join(workDir, 'out'),
      timeoutMs: Math.min(request.options.timeoutMs, 150_000),
    });
    ctx.progress('preparing-geometry', 80);

    const target = path.join(request.assetsDir, 'slides.pdf');
    await fs.copyFile(pdfPath, target);
    const stat = await fs.stat(target);

    return {
      kind: 'office',
      viewer: 'office-slides',
      source: `/api/v1/files/${request.fileId}/assets/slides.pdf`,
      meta: {
        formatId: request.formatId,
        mode: 'rendered',
        outline,
        slideCount: outline.length || null,
        bytes: stat.size,
        producer: 'LibreOffice Impress',
      },
      warnings: [],
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function renderNatively(ctx: ProcessorContext): Promise<JobResult> {
  const { request } = ctx;
  ctx.progress('processing', 40);

  const { document, media } = await readSlides(
    request.filePath,
    `/api/v1/files/${request.fileId}/assets`,
  );
  await writeMedia(media, request.assetsDir);
  ctx.progress('preparing-geometry', 85);

  if (document.slides.length === 0) {
    throw new ProcessingError(
      'empty_document',
      'We could not read any slides from this presentation.',
      'Installing LibreOffice on the server enables the high-fidelity renderer.',
      false,
      'native pptx renderer produced no slides',
    );
  }

  await fs.writeFile(path.join(request.assetsDir, 'slides.json'), JSON.stringify(document));

  return {
    kind: 'office',
    viewer: 'office-slides',
    source: `/api/v1/files/${request.fileId}/assets/slides.json`,
    meta: {
      formatId: request.formatId,
      mode: 'native',
      slideCount: document.slides.length,
      outline: document.slides.map((slide) => ({ index: slide.index, title: slide.title, notes: slide.notes })),
      producer: document.producer,
    },
    warnings: [
      'LibreOffice is not installed on this server, so slides are drawn by a simplified built-in renderer. Text, images and basic shapes are shown; charts, tables and effects are not.',
      ...document.warnings,
    ],
  };
}
