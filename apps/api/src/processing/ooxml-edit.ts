/**
 * Editing Word, Excel and PowerPoint files in place.
 *
 * The viewers show these documents through converters that lose the file's
 * structure, so edits cannot be made to what is on screen and saved back.
 * Instead the original package is opened here, the parts that hold text are
 * read into a small model the browser edits, and the browser's changes are
 * written into those same XML nodes. Nothing else in the file is touched:
 * styles, numbering, pictures and layout come back exactly as they went in.
 *
 * Changing a paragraph keeps the formatting of its runs: only the stretch of
 * text that differs is replaced, inside the run where it starts.
 */
import AdmZip from 'adm-zip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import path from 'node:path';
import type { DocumentEdits, DocxBlock, EditableDocument, EditableParagraph, PptxEditable, XlsxEditable } from '@docuview/shared';

type El = Element;

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PR = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';

export class EditError extends Error {}

/* ------------------------------- XML helpers ------------------------------ */

function parse(zip: AdmZip, name: string): Document | null {
  const entry = zip.getEntry(name);
  if (!entry) return null;
  return new DOMParser().parseFromString(entry.getData().toString('utf8'), 'text/xml');
}

function write(zip: AdmZip, name: string, doc: Document): void {
  zip.updateFile(name, Buffer.from(new XMLSerializer().serializeToString(doc), 'utf8'));
}

function children(node: Node, ns: string, local: string): El[] {
  const out: El[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && (child as El).namespaceURI === ns && (child as El).localName === local) out.push(child as El);
  }
  return out;
}

function child(node: Node, ns: string, local: string): El | null {
  return children(node, ns, local)[0] ?? null;
}

function all(node: Document | El, ns: string, local: string): El[] {
  return Array.from(node.getElementsByTagNameNS(ns, local) as unknown as ArrayLike<El>);
}

function attr(el: El | null, ns: string | null, local: string): string | null {
  if (!el) return null;
  return ns ? el.getAttributeNS(ns, local) || el.getAttribute(`${prefixOf(el, ns)}:${local}`) || null : el.getAttribute(local);
}

function prefixOf(el: El, ns: string): string {
  return el.lookupPrefix(ns) ?? (ns === W ? 'w' : ns === R ? 'r' : ns === A ? 'a' : 'p');
}

/** Relationship targets of a part, resolved to package paths. */
function relationships(zip: AdmZip, part: string): Map<string, { target: string; type: string; el: El; doc: Document; relsPath: string }> {
  const dir = path.posix.dirname(part);
  const relsPath = path.posix.join(dir, '_rels', `${path.posix.basename(part)}.rels`);
  const doc = parse(zip, relsPath);
  const out = new Map<string, { target: string; type: string; el: El; doc: Document; relsPath: string }>();
  if (!doc) return out;
  for (const el of all(doc, PR, 'Relationship')) {
    const id = el.getAttribute('Id');
    const target = el.getAttribute('Target');
    if (!id || !target || el.getAttribute('TargetMode') === 'External') continue;
    const resolved = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(dir, target));
    out.set(id, { target: resolved, type: el.getAttribute('Type') ?? '', el, doc, relsPath });
  }
  return out;
}

/** Drop a part, its relationships part and its content-type override. */
function removePart(zip: AdmZip, part: string): void {
  if (zip.getEntry(part)) zip.deleteFile(part);
  const rels = path.posix.join(path.posix.dirname(part), '_rels', `${path.posix.basename(part)}.rels`);
  if (zip.getEntry(rels)) zip.deleteFile(rels);
  const types = parse(zip, '[Content_Types].xml');
  if (!types) return;
  for (const override of all(types, CT, 'Override')) {
    if (override.getAttribute('PartName') === `/${part}`) override.parentNode?.removeChild(override);
  }
  write(zip, '[Content_Types].xml', types);
}

/* ------------------------------ text in runs ------------------------------ */

interface Segment {
  node: El;
  text: string;
  /** A text node we may change; tabs and breaks are only removed. */
  editable: boolean;
}

/**
 * The text of a paragraph as its run pieces, in order. Paragraphs nested in
 * it (text boxes) are theirs, not its; deleted text and field codes are not
 * text at all.
 */
function segmentsOf(paragraph: El, ns: string): Segment[] {
  const out: Segment[] = [];
  const visit = (node: Node) => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      const el = c as El;
      if (el.namespaceURI === ns && el.localName === 'p') continue;
      if (el.namespaceURI === ns && el.localName === 't') {
        out.push({ node: el, text: el.textContent ?? '', editable: true });
        continue;
      }
      if (ns === W && el.namespaceURI === W && el.localName === 'tab' && el.parentNode && (el.parentNode as El).localName === 'r') {
        out.push({ node: el, text: '\t', editable: false });
        continue;
      }
      if (el.namespaceURI === ns && (el.localName === 'br' || el.localName === 'cr') && attr(el, ns, 'type') !== 'page') {
        out.push({ node: el, text: '\n', editable: false });
        continue;
      }
      if (ns === W && el.namespaceURI === W && (el.localName === 'delText' || el.localName === 'instrText' || el.localName === 'pPr' || el.localName === 'rPr')) continue;
      if (ns === A && el.namespaceURI === A && (el.localName === 'pPr' || el.localName === 'rPr' || el.localName === 'endParaRPr')) continue;
      visit(el);
    }
  };
  visit(paragraph);
  return out;
}

function textOf(paragraph: El, ns: string): string {
  return segmentsOf(paragraph, ns)
    .map((segment) => segment.text)
    .join('');
}

function setText(el: El, text: string): void {
  while (el.firstChild) el.removeChild(el.firstChild);
  el.appendChild(el.ownerDocument.createTextNode(text));
  if (el.namespaceURI === W) el.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
}

/**
 * Change a paragraph's text to `next`, touching only what differs: the
 * common start and end stay in their runs, the middle is cut out of the
 * runs it spanned and the new text goes into the run where it began.
 */
function replaceParagraphText(paragraph: El, ns: string, next: string): void {
  const segments = segmentsOf(paragraph, ns);
  const old = segments.map((segment) => segment.text).join('');
  if (old === next) return;
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start += 1;
  let end = 0;
  while (end < old.length - start && end < next.length - start && old[old.length - 1 - end] === next[next.length - 1 - end]) end += 1;
  const cutTo = old.length - end;
  const insert = next.slice(start, next.length - end);

  // Where the new text goes: the first text piece holding `start` — at a
  // boundary, the one before it, as typing carries on the preceding format.
  let offset = 0;
  let host: { segment: Segment; at: number } | null = null;
  for (const segment of segments) {
    const from = offset;
    const to = offset + segment.text.length;
    offset = to;
    if (segment.editable && start >= from && start <= to) {
      host = { segment, at: start - from };
      break;
    }
  }
  if (!host) {
    // Inserting at a tab or break, or into an empty paragraph: the nearest text before, else a new run.
    let before: Segment | null = null;
    offset = 0;
    for (const segment of segments) {
      if (offset + segment.text.length > start) break;
      if (segment.editable) before = segment;
      offset += segment.text.length;
    }
    if (before) host = { segment: before, at: before.text.length };
  }

  // Cut [start, cutTo) out of every segment it crosses.
  offset = 0;
  const removals: El[] = [];
  for (const segment of segments) {
    const from = offset;
    const to = offset + segment.text.length;
    offset = to;
    const a = Math.max(start, from);
    const b = Math.min(cutTo, to);
    if (b <= a) continue;
    if (!segment.editable) {
      removals.push(segment.node);
      continue;
    }
    segment.text = segment.text.slice(0, a - from) + segment.text.slice(b - from);
  }
  if (host) {
    host.segment.text = host.segment.text.slice(0, host.at) + insert + host.segment.text.slice(host.at);
  }
  for (const segment of segments) if (segment.editable) setText(segment.node, segment.text);
  for (const node of removals) node.parentNode?.removeChild(node);

  if (!host && insert.length > 0) appendRun(paragraph, ns, insert);
}

/** A new run with `text` at the end of a paragraph (before PowerPoint's end-of-paragraph properties). */
function appendRun(paragraph: El, ns: string, text: string): void {
  const doc = paragraph.ownerDocument;
  const prefix = paragraph.prefix ? `${paragraph.prefix}:` : '';
  const run = doc.createElementNS(ns, `${prefix}r`);
  if (ns === A) run.appendChild(doc.createElementNS(ns, `${prefix}rPr`)).setAttribute('lang', 'ru-RU');
  const t = doc.createElementNS(ns, `${prefix}t`);
  run.appendChild(t);
  setText(t, text);
  const end = ns === A ? child(paragraph, A, 'endParaRPr') : null;
  if (end) paragraph.insertBefore(run, end);
  else paragraph.appendChild(run);
}

/* ---------------------------------- Word ---------------------------------- */

function paragraphStyle(paragraph: El): EditableParagraph['style'] {
  const pPr = child(paragraph, W, 'pPr');
  const style = (attr(child(pPr ?? paragraph, W, 'pStyle'), W, 'val') ?? '').toLowerCase();
  if (pPr && child(pPr, W, 'numPr')) return 'list';
  if (/^title|^заголовок$/.test(style)) return 'title';
  const level = /heading\s*([1-9])|^([1-9])$|заголовок\s*([1-9])/.exec(style);
  const n = level ? Number(level[1] ?? level[2] ?? level[3]) : 0;
  if (n === 1) return 'heading1';
  if (n === 2) return 'heading2';
  if (n >= 3) return 'heading3';
  if (/list/.test(style)) return 'list';
  return 'body';
}

/** Page breaks inside a block: Word's own layout marks when present, else explicit breaks. */
function breaksIn(block: El, layout: boolean): { before: number; after: number } {
  if (layout) return { before: 0, after: all(block, W, 'lastRenderedPageBreak').length };
  let before = 0;
  let after = 0;
  const paragraphs = block.localName === 'p' ? [block] : all(block, W, 'p');
  paragraphs.forEach((paragraph, k) => {
    const pPr = child(paragraph, W, 'pPr');
    const breakBefore = pPr ? child(pPr, W, 'pageBreakBefore') : null;
    if (breakBefore && attr(breakBefore, W, 'val') !== '0' && attr(breakBefore, W, 'val') !== 'false') {
      if (k === 0) before += 1;
      else after += 1;
    }
    for (const br of all(paragraph, W, 'br')) if (attr(br, W, 'type') === 'page') after += 1;
    const sect = pPr ? child(pPr, W, 'sectPr') : null;
    if (sect && attr(child(sect, W, 'type'), W, 'val') !== 'continuous') after += 1;
  });
  return { before, after };
}

function readDocx(zip: AdmZip): EditableDocument {
  const doc = parse(zip, 'word/document.xml');
  const body = doc ? child(doc.documentElement, W, 'body') : null;
  if (!doc || !body) throw new EditError('This Word file has no document body.');
  const allParagraphs = all(doc, W, 'p');
  const idOf = new Map(allParagraphs.map((p, k) => [p, k]));
  const editable = (p: El): EditableParagraph => ({ id: idOf.get(p) ?? -1, text: textOf(p, W), style: paragraphStyle(p) });
  const layout = all(doc, W, 'lastRenderedPageBreak').length > 0;
  const hasBreaks = layout || allParagraphs.some((p) => breaksIn(p, false).after + breaksIn(p, false).before > 0);

  const blocks: DocxBlock[] = [];
  let page = 1;
  let index = 0;
  for (let node = body.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== 1) continue;
    const el = node as El;
    const block = index++;
    if (el.namespaceURI === W && el.localName === 'sectPr') continue;
    const { before, after } = breaksIn(el, layout);
    page += before;
    if (el.namespaceURI === W && el.localName === 'p') {
      const pPr = child(el, W, 'pPr');
      blocks.push({ type: 'paragraph', block, page, paragraph: editable(el), locked: Boolean(pPr && child(pPr, W, 'sectPr')) });
    } else if (el.namespaceURI === W && el.localName === 'tbl') {
      const rows = children(el, W, 'tr').map((tr) => children(tr, W, 'tc').map((tc) => children(tc, W, 'p').map(editable)));
      blocks.push({ type: 'table', block, page, rows });
    } else {
      const paragraphs = all(el, W, 'p').map(editable);
      if (paragraphs.length > 0) blocks.push({ type: 'group', block, page, paragraphs });
    }
    page += after;
  }
  const last = blocks[blocks.length - 1];
  return { kind: 'docx', blocks, pages: last ? last.page : 1, pagesFrom: layout ? 'layout' : hasBreaks ? 'breaks' : 'none' };
}

function editDocx(zip: AdmZip, edits: NonNullable<DocumentEdits['docx']>): void {
  const doc = parse(zip, 'word/document.xml');
  const body = doc ? child(doc.documentElement, W, 'body') : null;
  if (!doc || !body) throw new EditError('This Word file has no document body.');
  const allParagraphs = all(doc, W, 'p');
  for (const { id, text } of edits.paragraphs ?? []) {
    const paragraph = allParagraphs[id];
    if (paragraph && typeof text === 'string') replaceParagraphText(paragraph, W, text);
  }
  const doomed = new Set(edits.deleteBlocks ?? []);
  if (doomed.size > 0) {
    const blocks: El[] = [];
    for (let node = body.firstChild; node; node = node.nextSibling) if (node.nodeType === 1) blocks.push(node as El);
    blocks.forEach((block, k) => {
      if (!doomed.has(k) || block.localName === 'sectPr') return;
      const pPr = block.localName === 'p' ? child(block, W, 'pPr') : null;
      if (pPr && child(pPr, W, 'sectPr')) {
        // Carries a section's page setup: keep the paragraph, drop its text.
        replaceParagraphText(block, W, '');
        return;
      }
      body.removeChild(block);
    });
    // A body must end with a paragraph before its section properties.
    const remaining = children(body, W, 'p').length + children(body, W, 'tbl').length;
    if (remaining === 0) {
      const empty = doc.createElementNS(W, `${body.prefix ? `${body.prefix}:` : ''}p`);
      const sect = child(body, W, 'sectPr');
      if (sect) body.insertBefore(empty, sect);
      else body.appendChild(empty);
    }
  }
  write(zip, 'word/document.xml', doc);
}

/* ---------------------------------- Excel --------------------------------- */

interface SheetEntry {
  name: string;
  el: El;
  relId: string;
  part: string;
  hidden: boolean;
}

function workbookSheets(zip: AdmZip): { workbook: Document; sheets: SheetEntry[] } {
  const workbook = parse(zip, 'xl/workbook.xml');
  if (!workbook) throw new EditError('This Excel file has no workbook part.');
  const rels = relationships(zip, 'xl/workbook.xml');
  const sheets: SheetEntry[] = [];
  for (const el of all(workbook, S, 'sheet')) {
    const relId = attr(el, R, 'id') ?? '';
    const part = rels.get(relId)?.target;
    if (!part) continue;
    sheets.push({ name: el.getAttribute('name') ?? '', el, relId, part, hidden: el.getAttribute('state') === 'veryHidden' });
  }
  return { workbook, sheets };
}

function readXlsx(zip: AdmZip): XlsxEditable {
  return { kind: 'xlsx', sheets: workbookSheets(zip).sheets.filter((s) => !s.hidden).map((s) => s.name) };
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref.toUpperCase())?.[0] ?? 'A';
  let n = 0;
  for (const char of letters) n = n * 26 + (char.charCodeAt(0) - 64);
  return n;
}

function setCell(doc: Document, ref: string, value: string): void {
  const sheetData = all(doc, S, 'sheetData')[0];
  if (!sheetData) return;
  const prefix = sheetData.prefix ? `${sheetData.prefix}:` : '';
  const rowNumber = Number(/\d+$/.exec(ref)?.[0] ?? 0);
  if (!rowNumber) return;
  // The row, in order.
  let row = children(sheetData, S, 'row').find((r) => Number(r.getAttribute('r')) === rowNumber) ?? null;
  if (!row) {
    row = doc.createElementNS(S, `${prefix}row`);
    row.setAttribute('r', String(rowNumber));
    const after = children(sheetData, S, 'row').find((r) => Number(r.getAttribute('r')) > rowNumber) ?? null;
    sheetData.insertBefore(row, after);
  }
  // The cell, in order.
  const column = columnIndex(ref);
  let cell = children(row, S, 'c').find((c) => (c.getAttribute('r') ?? '').toUpperCase() === ref.toUpperCase()) ?? null;
  if (!cell) {
    cell = doc.createElementNS(S, `${prefix}c`);
    cell.setAttribute('r', ref.toUpperCase());
    const after = children(row, S, 'c').find((c) => columnIndex(c.getAttribute('r') ?? 'A') > column) ?? null;
    row.insertBefore(cell, after);
  }
  // A typed-in value replaces whatever the cell held, formula included.
  for (const old of [...children(cell, S, 'f'), ...children(cell, S, 'v'), ...children(cell, S, 'is')]) cell.removeChild(old);
  cell.removeAttribute('t');
  if (value === '') return;
  const numeric = /^[-+]?(\d+([.,]\d*)?|[.,]\d+)([eE][-+]?\d+)?$/.test(value.trim());
  if (numeric) {
    const v = doc.createElementNS(S, `${prefix}v`);
    v.appendChild(doc.createTextNode(String(Number(value.trim().replace(',', '.')))));
    cell.appendChild(v);
    return;
  }
  cell.setAttribute('t', 'inlineStr');
  const is = doc.createElementNS(S, `${prefix}is`);
  const t = doc.createElementNS(S, `${prefix}t`);
  t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
  t.appendChild(doc.createTextNode(value));
  is.appendChild(t);
  cell.appendChild(is);
}

/** Excel rebuilds its calculation chain; a stale one makes it "repair" the file. */
function dropCalcChain(zip: AdmZip): void {
  if (!zip.getEntry('xl/calcChain.xml')) return;
  removePart(zip, 'xl/calcChain.xml');
  const rels = relationships(zip, 'xl/workbook.xml');
  for (const rel of rels.values()) {
    if (rel.target === 'xl/calcChain.xml') {
      rel.el.parentNode?.removeChild(rel.el);
      write(zip, rel.relsPath, rel.doc);
    }
  }
}

function editXlsx(zip: AdmZip, edits: NonNullable<DocumentEdits['xlsx']>): void {
  const { workbook, sheets } = workbookSheets(zip);
  const byName = new Map(sheets.map((sheet) => [sheet.name, sheet]));

  const cellsBySheet = new Map<string, { ref: string; value: string }[]>();
  for (const cell of edits.cells ?? []) {
    if (!/^[A-Za-z]{1,3}\d{1,7}$/.test(cell.ref)) continue;
    cellsBySheet.set(cell.sheet, [...(cellsBySheet.get(cell.sheet) ?? []), cell]);
  }
  for (const [name, cells] of cellsBySheet) {
    const sheet = byName.get(name);
    const doc = sheet ? parse(zip, sheet.part) : null;
    if (!sheet || !doc) continue;
    for (const { ref, value } of cells) setCell(doc, ref, String(value ?? ''));
    write(zip, sheet.part, doc);
  }
  if (cellsBySheet.size > 0) dropCalcChain(zip);

  const doomed = (edits.deleteSheets ?? []).filter((name) => byName.has(name));
  if (doomed.length > 0) {
    if (doomed.length >= sheets.length) throw new EditError('A workbook must keep at least one sheet.');
    const order = sheets.map((sheet) => sheet.name);
    const rels = relationships(zip, 'xl/workbook.xml');
    for (const name of doomed) {
      const sheet = byName.get(name) as SheetEntry;
      const position = order.indexOf(name);
      sheet.el.parentNode?.removeChild(sheet.el);
      const rel = rels.get(sheet.relId);
      if (rel) rel.el.parentNode?.removeChild(rel.el);
      removePart(zip, sheet.part);
      // Names scoped to it go; later sheets' scopes move down by one.
      for (const definedName of all(workbook, S, 'definedName')) {
        const local = definedName.getAttribute('localSheetId');
        const text = definedName.textContent ?? '';
        const quoted = `'${name.replace(/'/g, "''")}'!`;
        if ((local !== null && Number(local) === position) || text.includes(quoted) || text.includes(`${name}!`)) {
          definedName.parentNode?.removeChild(definedName);
        } else if (local !== null && Number(local) > position) {
          definedName.setAttribute('localSheetId', String(Number(local) - 1));
        }
      }
      order.splice(position, 1);
    }
    const anyRels = [...rels.values()][0];
    if (anyRels) write(zip, anyRels.relsPath, anyRels.doc);
    for (const view of all(workbook, S, 'workbookView')) {
      view.setAttribute('activeTab', '0');
      view.removeAttribute('firstSheet');
    }
  }
  write(zip, 'xl/workbook.xml', workbook);
}

/* ------------------------------- PowerPoint ------------------------------- */

function slideParts(zip: AdmZip): { presentation: Document; entries: { el: El; relId: string; part: string }[] } {
  const presentation = parse(zip, 'ppt/presentation.xml');
  if (!presentation) throw new EditError('This PowerPoint file has no presentation part.');
  const rels = relationships(zip, 'ppt/presentation.xml');
  const entries: { el: El; relId: string; part: string }[] = [];
  for (const el of all(presentation, P, 'sldId')) {
    const relId = attr(el, R, 'id') ?? '';
    const part = rels.get(relId)?.target;
    if (part) entries.push({ el, relId, part });
  }
  return { presentation, entries };
}

function textShapes(doc: Document): { id: string; name: string; paragraphs: El[]; placeholder: string | null }[] {
  return all(doc, P, 'sp').flatMap((sp) => {
    const nv = child(sp, P, 'nvSpPr');
    const cNvPr = nv ? child(nv, P, 'cNvPr') : null;
    const txBody = child(sp, P, 'txBody');
    if (!cNvPr || !txBody) return [];
    const nvPr = nv ? child(nv, P, 'nvPr') : null;
    const ph = nvPr ? child(nvPr, P, 'ph') : null;
    return [{ id: cNvPr.getAttribute('id') ?? '', name: cNvPr.getAttribute('name') ?? '', paragraphs: children(txBody, A, 'p'), placeholder: ph ? ph.getAttribute('type') ?? 'body' : null }];
  });
}

function readPptx(zip: AdmZip): PptxEditable {
  const { entries } = slideParts(zip);
  return {
    kind: 'pptx',
    slides: entries.map(({ part }, index) => {
      const doc = parse(zip, part);
      const shapes = doc ? textShapes(doc) : [];
      const titleShape = shapes.find((shape) => shape.placeholder === 'title' || shape.placeholder === 'ctrTitle');
      return {
        index,
        title: titleShape ? titleShape.paragraphs.map((p) => textOf(p, A)).join(' ').trim() || null : null,
        shapes: shapes.map((shape) => ({ id: shape.id, name: shape.name, paragraphs: shape.paragraphs.map((p) => textOf(p, A)) })),
      };
    }),
  };
}

function editPptx(zip: AdmZip, edits: NonNullable<DocumentEdits['pptx']>): void {
  const { presentation, entries } = slideParts(zip);
  const bySlide = new Map<number, { shape: string; paragraph: number; text: string }[]>();
  for (const edit of edits.texts ?? []) bySlide.set(edit.slide, [...(bySlide.get(edit.slide) ?? []), edit]);
  for (const [slide, list] of bySlide) {
    const entry = entries[slide];
    const doc = entry ? parse(zip, entry.part) : null;
    if (!entry || !doc) continue;
    const shapes = textShapes(doc);
    for (const edit of list) {
      const paragraph = shapes.find((shape) => shape.id === edit.shape)?.paragraphs[edit.paragraph];
      if (paragraph && typeof edit.text === 'string') replaceParagraphText(paragraph, A, edit.text);
    }
    write(zip, entry.part, doc);
  }

  const doomed = new Set((edits.deleteSlides ?? []).filter((k) => k >= 0 && k < entries.length));
  if (doomed.size > 0) {
    if (doomed.size >= entries.length) throw new EditError('A presentation must keep at least one slide.');
    const rels = relationships(zip, 'ppt/presentation.xml');
    for (const k of doomed) {
      const entry = entries[k];
      entry.el.parentNode?.removeChild(entry.el);
      const rel = rels.get(entry.relId);
      if (rel) rel.el.parentNode?.removeChild(rel.el);
      // Custom shows list it too.
      for (const listed of all(presentation, P, 'sld')) {
        if (attr(listed, R, 'id') === entry.relId) listed.parentNode?.removeChild(listed);
      }
      // Its speaker notes go with it.
      for (const own of relationships(zip, entry.part).values()) {
        if (own.type.endsWith('/notesSlide')) removePart(zip, own.target);
      }
      removePart(zip, entry.part);
    }
    const anyRels = [...rels.values()][0];
    if (anyRels) write(zip, anyRels.relsPath, anyRels.doc);
    write(zip, 'ppt/presentation.xml', presentation);
  }
}

/* --------------------------------- entries -------------------------------- */

export type EditableKind = 'docx' | 'xlsx' | 'pptx';

export function editableKind(extension: string): EditableKind | null {
  const e = extension.toLowerCase();
  if (e === 'docx' || e === 'docm') return 'docx';
  if (e === 'xlsx' || e === 'xlsm') return 'xlsx';
  if (e === 'pptx' || e === 'pptm') return 'pptx';
  return null;
}

function open(buffer: Buffer): AdmZip {
  try {
    return new AdmZip(buffer);
  } catch {
    throw new EditError('This file is not a readable Office package.');
  }
}

export function readEditable(buffer: Buffer, kind: EditableKind): EditableDocument {
  const zip = open(buffer);
  if (kind === 'docx') return readDocx(zip);
  if (kind === 'xlsx') return readXlsx(zip);
  return readPptx(zip);
}

export function applyEdits(buffer: Buffer, kind: EditableKind, edits: DocumentEdits): Buffer {
  const zip = open(buffer);
  if (kind === 'docx' && edits.docx) editDocx(zip, edits.docx);
  if (kind === 'xlsx' && edits.xlsx) editXlsx(zip, edits.xlsx);
  if (kind === 'pptx' && edits.pptx) editPptx(zip, edits.pptx);
  return zip.toBuffer();
}
