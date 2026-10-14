/**
 * Delete pages from a Word document.
 *
 * A .docx has no pages: it is a stream of blocks — paragraphs and tables —
 * that the word processor lays out. "Delete page 2" therefore has to be turned
 * into "delete the blocks that land on page 2", and the layout that decides it
 * must be the one the person is looking at. In DocuView that is the PDF
 * LibreOffice renders for the page view, so every block is located by finding
 * its text on those rendered pages.
 *
 * Removing the blocks is the easy half. The half Word itself gets wrong — and
 * the reason a page "deleted" in Word can stay in the file — is sections. Each
 * section's page settings (size, orientation, margins, headers) live on the
 * last paragraph of that section, or for the final section at the end of the
 * body. Empty a section and its settings must go with it; otherwise the
 * section survives as a blank page in its own orientation. So:
 *
 *  - a section whose content is all deleted disappears, settings included;
 *  - if the final section empties, the previous section's settings move to the
 *    end of the body, so the remaining pages keep their own letterhead and
 *    margins;
 *  - a section that loses only its last paragraph keeps its settings, on an
 *    emptied copy of that paragraph;
 *  - a page break left dangling at the very end is removed.
 *
 * A block that straddles a kept and a deleted page is kept whole: cutting a
 * paragraph at a page boundary would change text the person did not select.
 */

import AdmZip from 'adm-zip';

export interface DocxPageEdit {
  docx: Buffer;
  /** Pages deleted, 1-based, as requested. */
  deleted: number[];
  /** Blocks that straddled a deleted page and were kept whole. */
  keptPartial: number;
  /** Blocks whose page could only be inferred from their neighbours. */
  inferred: number;
}

export class PageEditError extends Error {}

interface Block {
  xml: string;
  tag: string;
  text: string;
  hasContent: boolean;
  sectPr: string | null;
  pageBreakBefore: boolean;
  breakAfter: boolean;
  start: number;
  end: number;
  located: boolean;
  deleted: boolean;
}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITY[code] ?? whole;
  });
}

/** What can be compared between Word's text and the PDF's: no spacing, no case, no ligatures. */
export function normaliseText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\s­​-‍﻿]+/g, '')
    .toLowerCase();
}

/** Split the body into its top-level elements, by tracking tag depth. */
function splitBody(body: string): string[] {
  const parts: string[] = [];
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let depth = 0;
  let start = -1;
  for (const match of body.matchAll(tag)) {
    const at = match.index ?? 0;
    const closing = match[1] === '/';
    const selfClosing = match[4] === '/';
    if (closing) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        parts.push(body.slice(start, at + match[0].length));
        start = -1;
      }
    } else if (selfClosing) {
      if (depth === 0) parts.push(match[0]);
    } else {
      if (depth === 0) start = at;
      depth += 1;
    }
  }
  if (depth !== 0) throw new PageEditError('The document body could not be read.');
  return parts;
}

function describe(xml: string): Block {
  const tag = /^<([\w:.-]+)/.exec(xml)?.[1] ?? '';
  const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => decode(m[1])).join('');
  const pPr = tag === 'w:p' ? /<w:pPr\b[\s\S]*?<\/w:pPr>/.exec(xml)?.[0] ?? '' : '';
  const sectPr = /<w:sectPr\b[\s\S]*?<\/w:sectPr>|<w:sectPr\b[^>]*\/>/.exec(pPr)?.[0] ?? null;
  const pageBreakBefore = /<w:pageBreakBefore(?:\s*\/>|\s+w:val="(?:1|true|on)"\s*\/>)/.test(pPr);
  // A page break with nothing after it pushes whatever follows onto a new page.
  const lastBreak = xml.lastIndexOf('<w:br w:type="page"');
  const breakAfter = lastBreak >= 0 && !/<w:t[\s>]/.test(xml.slice(lastBreak));
  const hasContent = text.trim().length > 0 || /<w:drawing\b|<w:pict\b|<w:object\b|<w:tbl\b/.test(xml) || tag === 'w:tbl';
  return { xml, tag, text, hasContent, sectPr, pageBreakBefore, breakAfter, start: 0, end: 0, located: false, deleted: false };
}

/**
 * Put every block on a page. Text is searched forward through the rendered
 * pages; blocks with no searchable text follow their neighbours, moving to a
 * new page when a break says they must.
 */
function locate(blocks: Block[], pageTexts: string[]): number {
  const pages = pageTexts.map(normaliseText);
  let page = 0;
  let offset = 0;

  const find = (needle: string, fromPage: number, fromOffset: number) => {
    for (let p = fromPage; p < pages.length; p += 1) {
      const at = pages[p].indexOf(needle, p === fromPage ? fromOffset : 0);
      if (at >= 0) return { page: p, at };
    }
    return null;
  };

  for (const block of blocks) {
    const text = normaliseText(block.text);
    if (text.length < 4) continue;
    let head = find(text.slice(0, 24), page, offset);
    if (!head && text.length > 12) head = find(text.slice(0, 12), page, offset);
    if (!head) continue;
    const tailNeedle = text.slice(-24);
    const tail = text.length <= 24 ? { page: head.page, at: head.at } : find(tailNeedle, head.page, head.at);
    const endPage = tail ? tail.page : head.page;
    block.start = head.page + 1;
    block.end = endPage + 1;
    block.located = true;
    page = endPage;
    offset = tail ? tail.at + Math.min(tailNeedle.length, text.length) : head.at + 1;
  }

  // Sections that start on the same page as the previous one do not break.
  const continuous: boolean[] = [];
  let sectionStart = 0;
  blocks.forEach((block, i) => {
    const sectPr = block.sectPr ?? (block.tag === 'w:sectPr' ? block.xml : null);
    if (sectPr) {
      const isContinuous = /<w:type\s+w:val="continuous"/.test(sectPr);
      for (let k = sectionStart; k <= i; k += 1) continuous[k] = isContinuous;
      sectionStart = i + 1;
    }
  });

  let inferred = 0;
  let last = 1;
  blocks.forEach((block, i) => {
    if (block.located) {
      last = block.end;
      return;
    }
    const previous = blocks[i - 1];
    const newPage =
      block.pageBreakBefore ||
      (previous && previous.breakAfter) ||
      (previous && previous.sectPr !== null && !continuous[i]);
    let pageNumber = newPage ? last + 1 : last;
    const next = blocks.slice(i + 1).find((b) => b.located);
    if (next) pageNumber = Math.min(pageNumber, next.start);
    block.start = block.end = Math.max(1, pageNumber);
    last = block.end;
    if (block.tag !== 'w:sectPr') inferred += 1;
  });
  return inferred;
}

function stripSectPr(paragraph: string): string {
  return paragraph.replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>|<w:sectPr\b[^>]*\/>/, '');
}

/** The paragraph with its content removed but its properties — and section settings — intact. */
function emptied(paragraph: string): string {
  const open = /^<w:p\b[^>]*>/.exec(paragraph)?.[0] ?? '<w:p>';
  const pPr = /<w:pPr\b[\s\S]*?<\/w:pPr>/.exec(paragraph)?.[0] ?? '';
  return `${open}${pPr}</w:p>`;
}

export function deleteDocxPages(docx: Buffer, pageTexts: string[], pagesToDelete: number[]): DocxPageEdit {
  const total = pageTexts.length;
  const doomed = new Set(pagesToDelete.filter((n) => Number.isInteger(n) && n >= 1 && n <= total));
  if (doomed.size === 0) throw new PageEditError('No such page in this document.');
  if (doomed.size >= total) throw new PageEditError('A document has to keep at least one page.');

  const zip = new AdmZip(docx);
  const entry = zip.getEntry('word/document.xml');
  if (!entry) throw new PageEditError('This is not a Word document.');
  const xml = entry.getData().toString('utf8');

  const bodyOpen = xml.indexOf('<w:body>');
  const bodyClose = xml.lastIndexOf('</w:body>');
  if (bodyOpen < 0 || bodyClose < 0) throw new PageEditError('The document body could not be read.');
  const blocks = splitBody(xml.slice(bodyOpen + '<w:body>'.length, bodyClose)).map(describe);

  const inferred = locate(blocks, pageTexts);

  let keptPartial = 0;
  for (const block of blocks) {
    if (block.tag === 'w:sectPr') continue;
    let all = true;
    let any = false;
    for (let p = block.start; p <= block.end; p += 1) {
      if (doomed.has(p)) any = true;
      else all = false;
    }
    block.deleted = all;
    if (any && !all) keptPartial += 1;
  }

  // Sections: the blocks up to and including each paragraph carrying a sectPr,
  // and finally the blocks before the body's own sectPr.
  const sections: number[][] = [];
  let current: number[] = [];
  blocks.forEach((block, i) => {
    current.push(i);
    if (block.sectPr || block.tag === 'w:sectPr') {
      sections.push(current);
      current = [];
    }
  });
  if (current.length) sections.push(current);

  const finalIndex = blocks.findIndex((b) => b.tag === 'w:sectPr');
  for (const section of sections) {
    const holderIndex = section[section.length - 1];
    const holder = blocks[holderIndex];
    if (holder.tag === 'w:sectPr') continue;
    const survivors = section.filter((i) => i !== holderIndex && !blocks[i].deleted);
    if (holder.deleted && survivors.length > 0) {
      // The section keeps pages, so it keeps its settings.
      holder.deleted = false;
      holder.xml = emptied(holder.xml);
      holder.hasContent = false;
    }
  }

  if (finalIndex >= 0) {
    const lastSection = sections.find((s) => s.includes(finalIndex)) ?? [];
    const left = lastSection.filter((i) => i !== finalIndex && !blocks[i].deleted);
    if (left.length === 0) {
      // The final section is gone: the closest surviving section becomes the
      // last one, and its settings move to the end of the body.
      const previousHolder = [...sections]
        .reverse()
        .map((s) => s[s.length - 1])
        .find((i) => i !== finalIndex && blocks[i].sectPr && !blocks[i].deleted);
      if (previousHolder === undefined) throw new PageEditError('A document has to keep at least one page.');
      const holder = blocks[previousHolder];
      blocks[finalIndex].xml = holder.sectPr as string;
      // Its empty filler paragraph only existed to carry the break.
      if (!holder.hasContent) holder.deleted = true;
      else holder.xml = stripSectPr(holder.xml);
      holder.sectPr = null;
    }
  }

  // A page break with nothing after it would leave a blank last page.
  const lastKept = [...blocks].reverse().find((b) => !b.deleted && b.tag !== 'w:sectPr');
  if (lastKept && lastKept.breakAfter) {
    const at = lastKept.xml.lastIndexOf('<w:br w:type="page"');
    const end = lastKept.xml.indexOf('>', at) + 1;
    lastKept.xml = lastKept.xml.slice(0, at) + lastKept.xml.slice(end);
  }

  const body = blocks.filter((b) => !b.deleted).map((b) => b.xml).join('');
  const updated = xml.slice(0, bodyOpen + '<w:body>'.length) + body + xml.slice(bodyClose);
  zip.updateFile('word/document.xml', Buffer.from(updated, 'utf8'));

  return { docx: zip.toBuffer(), deleted: [...doomed].sort((a, b) => a - b), keptPartial, inferred };
}
