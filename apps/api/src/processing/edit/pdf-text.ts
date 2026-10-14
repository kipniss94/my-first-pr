/**
 * The text of every page of a PDF, as pdf.js reads it.
 *
 * Used to find out which page each block of a Word document landed on: the
 * page layout the viewer shows is a PDF rendered by LibreOffice, and "delete
 * page 2" has to mean the page 2 the person is looking at.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let pdfjsPromise: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      // In Node pdf.js runs its "worker" in-process; it only needs to know where it is.
      const require = createRequire(import.meta.url);
      pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

export async function pdfPageTexts(data: Uint8Array): Promise<string[]> {
  const pdfjs = await loadPdfJs();
  const document = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: false })
    .promise;
  try {
    const pages: string[] = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(''));
      page.cleanup();
    }
    return pages;
  } finally {
    await document.destroy();
  }
}
