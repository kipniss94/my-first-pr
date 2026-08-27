import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { JobResult } from '@docuview/shared';
import { libreOfficeConvert } from '../libreoffice.js';
import { type ProcessorContext } from '../context.js';

/** LibreOffice export filter per document family. */
const FILTERS: Record<string, string> = {
  doc: 'pdf:writer_pdf_Export',
  docx: 'pdf:writer_pdf_Export',
  odt: 'pdf:writer_pdf_Export',
  rtf: 'pdf:writer_pdf_Export',
  txt: 'pdf:writer_pdf_Export',
  xls: 'pdf:calc_pdf_Export',
  xlsx: 'pdf:calc_pdf_Export',
  ods: 'pdf:calc_pdf_Export',
  csv: 'pdf:calc_pdf_Export',
};

/**
 * On-demand "exact page layout" rendition.
 *
 * Word and Excel open through the fast structural readers; this runs only when
 * the user explicitly asks for the printed layout, so the common path stays
 * quick.
 */
export async function processOfficePdf(ctx: ProcessorContext): Promise<JobResult> {
  const { request } = ctx;
  ctx.progress('processing', 30);

  const workDir = path.join(os.tmpdir(), `docuview-pdf-${randomUUID()}`);
  const staged = path.join(workDir, `document.${request.extension || request.formatId}`);
  await fs.mkdir(workDir, { recursive: true });
  await fs.copyFile(request.filePath, staged);

  try {
    const pdfPath = await libreOfficeConvert({
      bin: request.options.libreOfficeBin,
      inputPath: staged,
      target: FILTERS[request.formatId] ?? 'pdf',
      outExtension: 'pdf',
      outDir: path.join(workDir, 'out'),
      timeoutMs: Math.min(request.options.timeoutMs, 150_000),
    });
    await fs.mkdir(request.assetsDir, { recursive: true });
    const target = path.join(request.assetsDir, 'rendition.pdf');
    await fs.copyFile(pdfPath, target);
    ctx.progress('preparing-geometry', 95);

    return {
      kind: 'pdf',
      viewer: 'pdf',
      source: `/api/v1/files/${request.fileId}/assets/rendition.pdf`,
      meta: { formatId: request.formatId, rendition: true, producer: 'LibreOffice' },
      warnings: [],
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
