'use client';

import { eraseRuns } from './pdf-erase';

/**
 * Writing changes into a PDF, in the browser.
 *
 * A PDF has no paragraphs to edit: its text is glyphs placed one run at a
 * time, often in a font subset holding only the letters used. So a changed
 * run's glyphs are taken out of the page (see pdf-erase) and the new text
 * written in its place, on the same baseline, at the same size and angle, in
 * Liberation Sans (which has Cyrillic). Where the old glyphs cannot all be
 * found — text in a form XObject, a font without widths — what is left is
 * covered with white instead. Deleted pages are removed from the file.
 * Everything else — drawings, pictures, other text — is copied as it was.
 */

export interface PdfTextEdit {
  /** 1-based page. */
  page: number;
  /** Text run position from PDF.js: [a, b, c, d, e, f] in the page's own units. */
  transform: number[];
  /** The run's advance width, page units. */
  width: number;
  original: string;
  text: string;
}

export interface PdfEdits {
  texts: PdfTextEdit[];
  /** 1-based pages to remove. */
  deletePages: number[];
}

let fontBytes: Promise<ArrayBuffer> | null = null;

export async function applyPdfEdits(original: ArrayBuffer, edits: PdfEdits): Promise<Blob> {
  const [lib, fontkit, standardFonts] = await Promise.all([import('pdf-lib'), import('@pdf-lib/fontkit'), import('@pdf-lib/standard-fonts')]);
  const { PDFDocument, rgb, degrees } = lib;
  let doc;
  try {
    doc = await PDFDocument.load(original, { updateMetadata: false });
  } catch {
    throw new Error('This PDF is protected against changes, so it cannot be edited here.');
  }
  const pages = doc.getPages();
  if (edits.deletePages.length >= pages.length) throw new Error('A PDF must keep at least one page.');

  if (edits.texts.length > 0) {
    doc.registerFontkit(fontkit.default ?? fontkit);
    fontBytes ??= fetch('/fonts/LiberationSans-Regular.ttf').then((response) => {
      if (!response.ok) throw new Error('The font for edited text could not be loaded.');
      return response.arrayBuffer();
    });
    const font = await doc.embedFont(await fontBytes, { subset: true });
    // The old glyphs out first, page by page; whatever could not be found is covered.
    const gone = new Set<PdfTextEdit>();
    const byPage = new Map<number, PdfTextEdit[]>();
    for (const edit of edits.texts) byPage.set(edit.page, [...(byPage.get(edit.page) ?? []), edit]);
    for (const [number, pageEdits] of byPage) {
      const page = pages[number - 1];
      if (!page) continue;
      try {
        const erased = eraseRuns(
          lib,
          standardFonts,
          doc,
          page,
          pageEdits.map((edit) => ({ transform: edit.transform, width: edit.width, text: edit.original })),
        );
        pageEdits.forEach((edit, k) => {
          if (erased[k] >= edit.original.replace(/\s/g, '').length) gone.add(edit);
        });
      } catch {
        // A content stream that does not read: covering still works.
      }
    }
    for (const edit of edits.texts) {
      const page = pages[edit.page - 1];
      if (!page) continue;
      const [a, b, c, d, e, f] = edit.transform;
      const size = Math.hypot(c, d) || Math.hypot(a, b) || 10;
      const angle = (Math.atan2(b, a) * 180) / Math.PI;
      const cos = Math.cos((angle * Math.PI) / 180);
      const sin = Math.sin((angle * Math.PI) / 180);
      if (!gone.has(edit)) {
        // Cover the old run: from a little below the baseline to above the capitals.
        const descent = size * 0.25;
        const coverWidth = Math.max(edit.width, size * 0.3) + size * 0.1;
        page.drawRectangle({
          x: e + descent * sin - size * 0.05 * cos,
          y: f - descent * cos - size * 0.05 * sin,
          width: coverWidth,
          height: size * 1.2,
          rotate: degrees(angle),
          color: rgb(1, 1, 1),
        });
      }
      if (edit.text.length === 0) continue;
      // Longer text than the run had: shrink it to fit, down to seven tenths.
      const natural = font.widthOfTextAtSize(edit.text, size);
      const fitted = natural > edit.width * 1.05 && edit.width > 0 ? Math.max(size * 0.7, size * (edit.width / natural)) : size;
      page.drawText(edit.text, { x: e, y: f, size: fitted, font, rotate: degrees(angle), color: rgb(0, 0, 0) });
    }
  }

  for (const page of [...edits.deletePages].sort((x, y) => y - x)) doc.removePage(page - 1);
  const bytes = await doc.save();
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}
