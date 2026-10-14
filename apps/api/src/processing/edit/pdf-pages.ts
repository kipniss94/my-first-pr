/** Delete pages from a PDF, keeping everything else in it as it was. */

import { PDFDocument } from 'pdf-lib';
import { PageEditError } from './docx-pages.js';

export async function deletePdfPages(pdf: Uint8Array, pagesToDelete: number[]): Promise<{ pdf: Buffer; deleted: number[] }> {
  let document: PDFDocument;
  try {
    // Opening an encrypted file for structure only; its pages are copied as they are.
    document = await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    throw new PageEditError('This PDF could not be opened for editing.');
  }
  const total = document.getPageCount();
  const doomed = [...new Set(pagesToDelete)].filter((n) => Number.isInteger(n) && n >= 1 && n <= total).sort((a, b) => b - a);
  if (doomed.length === 0) throw new PageEditError('No such page in this document.');
  if (doomed.length >= total) throw new PageEditError('A document has to keep at least one page.');
  // Highest first, so the remaining indices stay valid.
  for (const page of doomed) document.removePage(page - 1);
  return { pdf: Buffer.from(await document.save()), deleted: doomed.reverse() };
}
