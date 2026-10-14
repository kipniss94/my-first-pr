"use client";

import { deleteDocxPages, type DocxPageEdit } from "@docuview/shared";

const DOCX_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * A copy of a Word document without the given pages — pages as the page view
 * shows them. Everything happens in the browser; the original on the server
 * is never touched, as with every other edit in DocuView.
 */
export async function docxWithoutPages(
  original: ArrayBuffer,
  pages: number[],
): Promise<{ blob: Blob; edit: DocxPageEdit }> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(original);
  const document = zip.file("word/document.xml");
  if (!document) throw new Error("This is not a Word document.");
  const styles = zip.file("word/styles.xml");
  const edit = deleteDocxPages(
    await document.async("string"),
    styles ? await styles.async("string") : null,
    pages,
  );
  zip.file("word/document.xml", edit.documentXml);
  const blob = await zip.generateAsync({
    type: "blob",
    mimeType: DOCX_TYPE,
    compression: "DEFLATE",
  });
  return { blob, edit };
}
