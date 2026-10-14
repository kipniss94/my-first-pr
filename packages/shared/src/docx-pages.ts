/**
 * Delete pages from a Word document — on the pages the person is looking at.
 *
 * A .docx has no pages: it is a stream of paragraphs and tables that a word
 * processor lays out. DocuView shows Word documents page by page with
 * docx-preview, so "page 2" has to mean docx-preview's page 2. This module
 * reproduces exactly how docx-preview splits a document (its `splitBySection`
 * and `groupByPageBreaks`):
 *
 *  - a page ends at the first page break in a top-level paragraph — an
 *    explicit `<w:br w:type="page"/>` or the `<w:lastRenderedPageBreak/>` Word
 *    leaves where it last broke the page — and the paragraph is split there;
 *  - a paragraph with "page break before" (its own or its style's) starts one;
 *  - a section ends at a paragraph carrying `w:sectPr`, but starts a new page
 *    only when the paper size or orientation changes;
 *  - breaks inside tables are ignored; content controls are looked into.
 *
 * Removing the blocks on the chosen pages is the easy half. The half Word
 * itself gets wrong — and why a page "deleted" in Word can stay in the file —
 * is sections: each one's page settings ride on its last paragraph (or, for the
 * last section, on the body), so emptying a section's content leaves it behind
 * as a blank page in its own orientation. Here an emptied section goes with its
 * settings, the previous section's settings move to the end of the body, a
 * section that keeps pages keeps its settings, and a page break left dangling
 * at either end of the document is dropped.
 *
 * A paragraph with content on both a kept and a deleted page is kept whole:
 * cutting it would change text the person did not select.
 *
 * Plain string processing, no DOM and no Node APIs, so the browser and the
 * server run the same code.
 */

export class DocxPageError extends Error {}

export interface DocxPageEdit {
  /** The edited `word/document.xml`. */
  documentXml: string;
  /** Pages removed, 1-based. */
  deleted: number[];
  pagesBefore: number;
  /** Pages the edited document lays out on, by the same rules. */
  pagesAfter: number;
  /** Paragraphs that ran onto a kept page and were kept whole. */
  keptPartial: number;
}

/* ------------------------------------------------------------------ XML -- */

const TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;

/** The direct children of an element's content, as strings. */
function children(xml: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = -1;
  for (const match of xml.matchAll(TAG)) {
    const at = match.index ?? 0;
    if (match[1] === '/') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        parts.push(xml.slice(start, at + match[0].length));
        start = -1;
      }
    } else if (match[4] === '/') {
      if (depth === 0) parts.push(match[0]);
    } else {
      if (depth === 0) start = at;
      depth += 1;
    }
  }
  if (depth !== 0) throw new DocxPageError('The document body could not be read.');
  return parts;
}

/** The content between an element's opening and closing tags. */
function inner(xml: string): string {
  const open = xml.indexOf('>');
  const close = xml.lastIndexOf('</');
  return open >= 0 && close > open ? xml.slice(open + 1, close) : '';
}

const nameOf = (xml: string) => /^<([\w:.-]+)/.exec(xml)?.[1] ?? '';
const hasContent = (xml: string) => /<w:t[\s>]|<w:drawing\b|<w:pict\b|<w:object\b|<w:tbl\b/.test(xml);
const isBreak = (xml: string) => /^<w:br\b[^>]*w:type="page"/.test(xml) || /^<w:lastRenderedPageBreak\b/.test(xml);
const truthy = (xml: string, tag: string) => new RegExp(`<${tag}(?:\\s*/>|\\s+w:val="(?:1|true|on)"\\s*/>)`).test(xml);

/* ------------------------------------------------------------ sections -- */

interface PageSize {
  width: string;
  height: string;
  orientation: string;
}

function pageSize(sectPr: string | null): PageSize | null {
  if (!sectPr) return null;
  const size = /<w:pgSz\b([^>]*)\/?>/.exec(sectPr)?.[1] ?? '';
  const attr = (name: string) => new RegExp(`w:${name}="([^"]*)"`).exec(size)?.[1] ?? '';
  return { width: attr('w'), height: attr('h'), orientation: attr('orient') };
}

function differs(a: PageSize | null | undefined, b: PageSize | null | undefined): boolean {
  if (!a || !b) return false;
  return a.orientation !== b.orientation || a.width !== b.width || a.height !== b.height;
}

/**
 * Paragraph styles that start a page, the way docx-preview resolves them.
 *
 * Its inheritance has two quirks that decide real page numbers, so they are
 * reproduced rather than corrected: a style inherits "page break before" only
 * if it has paragraph properties of its own, and the parent's value then
 * overrides the child's; styles are merged in file order, one parent each.
 */
function breakingStyles(stylesXml: string | null): Set<string> {
  const result = new Set<string>();
  if (!stylesXml) return result;
  const styles: { id: string; hasPPr: boolean; breaks: boolean | undefined; basedOn: string | null }[] = [];
  for (const match of stylesXml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const body = match[2];
    const pPr = /<w:pPr\b[\s\S]*?<\/w:pPr>|<w:pPr\s*\/>/.exec(body)?.[0] ?? null;
    const own = pPr ? /<w:pageBreakBefore\b[^>]*\/>/.exec(pPr)?.[0] : undefined;
    styles.push({
      id: match[1],
      hasPPr: pPr !== null,
      breaks: own === undefined ? undefined : !/w:val="(?:0|false|off)"/.test(own),
      basedOn: /<w:basedOn\s+w:val="([^"]+)"/.exec(body)?.[1] ?? null,
    });
  }
  const byId = new Map(styles.map((style) => [style.id, style]));
  for (const style of styles) {
    const base = style.basedOn ? byId.get(style.basedOn) : undefined;
    if (base && style.hasPPr && base.hasPPr && base.breaks !== undefined) style.breaks = base.breaks;
  }
  for (const style of styles) if (style.breaks) result.add(style.id);
  return result;
}

/* ------------------------------------------------------------- layout -- */

interface Block {
  xml: string;
  tag: string;
  sectPr: string | null;
  content: boolean;
  deleted: boolean;
  /** Pages this block has content on (or simply sits on, when it has none). */
  pages: number[];
  /**
   * Where a top-level paragraph is split across two pages, the page of each
   * half and the break between them — so a page can be deleted from the
   * middle of a paragraph that runs onto it.
   */
  split: { breakItem: number; breakChild: number; before: number; after: number } | null;
}

interface Part {
  block: number;
  content: boolean;
}

interface Group {
  size: PageSize | null | undefined;
  pageBreak: boolean;
  parts: Part[];
}

/** One body element's paragraphs, as docx-preview sees them (content controls opened). */
function paragraphsOf(xml: string): string[] {
  const tag = nameOf(xml);
  if (tag === 'w:p') return [xml];
  if (tag === 'w:sdt') {
    const content = /<w:sdtContent\b[^>]*>([\s\S]*)<\/w:sdtContent>/.exec(xml)?.[1] ?? '';
    return children(content).flatMap(paragraphsOf);
  }
  return [];
}

/**
 * docx-preview's pagination of the body. Returns, per page, the blocks with
 * content there; also marks each block with its pages.
 */
function layout(blocks: Block[], breaking: Set<string>, finalSectPr: string | null): number {
  let current: Group = { size: null, pageBreak: false, parts: [] };
  const groups: Group[] = [current];
  const splitGroups = new Map<number, { breakItem: number; breakChild: number; beforeGroup: Group; afterGroup: Group }>();
  const open = () => {
    current = { size: null, pageBreak: false, parts: [] };
    groups.push(current);
  };

  blocks.forEach((block, index) => {
    if (block.tag === 'w:sectPr') return;
    const paragraphs = paragraphsOf(block.xml);
    if (paragraphs.length === 0) {
      current.parts.push({ block: index, content: block.content });
      return;
    }
    for (const paragraph of paragraphs) {
      const pPr = /<w:pPr\b[\s\S]*?<\/w:pPr>/.exec(paragraph)?.[0] ?? '';
      const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(pPr)?.[1];
      if (truthy(pPr, 'w:pageBreakBefore') || (style && breaking.has(style))) {
        current.pageBreak = true;
        open();
      }

      const items = children(inner(paragraph)).filter((child) => nameOf(child) !== 'w:pPr');
      let breakItem = -1;
      let breakChild = -1;
      for (let i = 0; i < items.length && breakItem < 0; i += 1) {
        if (nameOf(items[i]) !== 'w:r') continue;
        const runChildren = children(inner(items[i])).filter((child) => nameOf(child) !== 'w:rPr');
        const at = runChildren.findIndex(isBreak);
        if (at >= 0) {
          breakItem = i;
          breakChild = at;
        }
      }

      const sectPr = /<w:sectPr\b[\s\S]*?<\/w:sectPr>|<w:sectPr\b[^>]*\/>/.exec(pPr)?.[0] ?? null;
      if (breakItem < 0) {
        current.parts.push({ block: index, content: hasContent(paragraph) });
        if (sectPr) {
          current.size = pageSize(sectPr);
          open();
        }
        continue;
      }

      // Split at the break, as docx-preview does: what precedes it stays on
      // this page, the rest starts the next one.
      const runChildren = children(inner(items[breakItem])).filter((child) => nameOf(child) !== 'w:rPr');
      const splits = breakItem < items.length - 1 || breakChild < runChildren.length - 1;
      const before = items.slice(0, breakItem).join('') + runChildren.slice(0, breakChild).join('');
      const after = items.slice(breakItem + 1).join('') + runChildren.slice(breakChild).join('');
      current.parts.push({ block: index, content: splits ? hasContent(before) : hasContent(paragraph) });
      const beforeGroup = current;
      current.size = pageSize(sectPr);
      current.pageBreak = true;
      open();
      if (splits) {
        current.parts.push({ block: index, content: hasContent(after) });
        if (paragraphs.length === 1 && !sectPr && hasContent(before) && hasContent(after)) {
          splitGroups.set(index, { breakItem, breakChild, beforeGroup, afterGroup: current });
        }
      }
    }
  });

  // Groups without settings take the next section's; the last, the body's.
  let following: PageSize | null = pageSize(finalSectPr);
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    if (!groups[i].size) groups[i].size = following;
    else following = groups[i].size as PageSize;
  }

  const pages: Group[][] = [[]];
  let previous: PageSize | null | undefined;
  for (const group of groups) {
    pages[pages.length - 1].push(group);
    if (group.pageBreak || differs(previous, group.size)) pages.push([]);
    previous = group.size;
  }
  const nonEmpty = pages.filter((page) => page.length > 0);

  for (const block of blocks) block.pages = [];
  const seen = new Map<number, number[]>();
  nonEmpty.forEach((page, pageIndex) => {
    for (const group of page) {
      for (const part of group.parts) {
        const block = blocks[part.block];
        if (part.content) block.pages.push(pageIndex + 1);
        const anywhere = seen.get(part.block) ?? [];
        anywhere.push(pageIndex + 1);
        seen.set(part.block, anywhere);
      }
    }
  });
  blocks.forEach((block, index) => {
    if (block.pages.length === 0) block.pages = (seen.get(index) ?? []).slice(0, 1);
  });
  const pageOf = new Map<Group, number>();
  nonEmpty.forEach((page, pageIndex) => page.forEach((group) => pageOf.set(group, pageIndex + 1)));
  for (const [index, split] of splitGroups) {
    const before = pageOf.get(split.beforeGroup);
    const after = pageOf.get(split.afterGroup);
    if (before && after && before !== after) {
      blocks[index].split = { breakItem: split.breakItem, breakChild: split.breakChild, before, after };
    }
  }
  return nonEmpty.length;
}

/* ------------------------------------------------------------- editing -- */

/**
 * One half of a paragraph split by a page break: the text before the break
 * (when the page after it is deleted) or from the break on (when the page
 * before it is). The break itself stays with the second half, where it still
 * separates that half from the page before.
 */
function paragraphHalf(paragraph: string, split: { breakItem: number; breakChild: number }, keep: 'before' | 'after'): string {
  const open = /^<w:p\b[^>]*>/.exec(paragraph)?.[0] ?? '<w:p>';
  const all = children(inner(paragraph));
  const pPr = all.find((child) => nameOf(child) === 'w:pPr') ?? '';
  const items = all.filter((child) => nameOf(child) !== 'w:pPr');
  const run = items[split.breakItem];
  const runOpen = /^<w:r\b[^>]*>/.exec(run)?.[0] ?? '<w:r>';
  const runAll = children(inner(run));
  const rPr = runAll.find((child) => nameOf(child) === 'w:rPr') ?? '';
  const runChildren = runAll.filter((child) => nameOf(child) !== 'w:rPr');
  if (keep === 'before') {
    const head = runChildren.slice(0, split.breakChild);
    const partial = head.length ? `${runOpen}${rPr}${head.join('')}</w:r>` : '';
    return `${open}${pPr}${items.slice(0, split.breakItem).join('')}${partial}</w:p>`;
  }
  const tailRun = `${runOpen}${rPr}${runChildren.slice(split.breakChild).join('')}</w:r>`;
  return `${open}${pPr}${tailRun}${items.slice(split.breakItem + 1).join('')}</w:p>`;
}

/** Page-break markers before a paragraph's first content. */
function stripLeadingBreaks(xml: string): string {
  return xml.replace(/^([\s\S]*?)(<w:t[\s>]|<w:drawing\b|$)/, (_all, lead: string, rest: string) =>
    lead.replace(/<w:lastRenderedPageBreak\s*\/>|<w:br\b[^>]*w:type="page"[^>]*\/>/g, '') + rest,
  );
}

/** A manual page break with no content after it. */
function endsWithPageBreak(xml: string): boolean {
  const at = xml.lastIndexOf('<w:br w:type="page"');
  return at >= 0 && !/<w:t[\s>]|<w:drawing\b/.test(xml.slice(at));
}

function dropTrailingPageBreak(xml: string): string {
  const at = xml.lastIndexOf('<w:br w:type="page"');
  const end = xml.indexOf('>', at) + 1;
  return xml.slice(0, at) + xml.slice(end);
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

function readBody(documentXml: string): { head: string; blocks: Block[]; tail: string } {
  const open = documentXml.indexOf('<w:body>');
  const close = documentXml.lastIndexOf('</w:body>');
  if (open < 0 || close < 0) throw new DocxPageError('This is not a Word document.');
  const blocks = children(documentXml.slice(open + '<w:body>'.length, close)).map((xml): Block => {
    const tag = nameOf(xml);
    const pPr = tag === 'w:p' ? /<w:pPr\b[\s\S]*?<\/w:pPr>/.exec(xml)?.[0] ?? '' : '';
    return {
      xml,
      tag,
      sectPr: /<w:sectPr\b[\s\S]*?<\/w:sectPr>|<w:sectPr\b[^>]*\/>/.exec(pPr)?.[0] ?? null,
      content: tag === 'w:tbl' || hasContent(xml),
      deleted: false,
      pages: [],
      split: null,
    };
  });
  return { head: documentXml.slice(0, open + '<w:body>'.length), blocks, tail: documentXml.slice(close) };
}

/** How many pages docx-preview lays this document out on. */
export function countDocxPages(documentXml: string, stylesXml: string | null): number {
  const { blocks } = readBody(documentXml);
  const final = blocks.find((block) => block.tag === 'w:sectPr');
  return layout(blocks, breakingStyles(stylesXml), final?.xml ?? null);
}

export function deleteDocxPages(documentXml: string, stylesXml: string | null, pagesToDelete: number[]): DocxPageEdit {
  const { head, blocks, tail } = readBody(documentXml);
  const breaking = breakingStyles(stylesXml);
  const finalIndex = blocks.findIndex((block) => block.tag === 'w:sectPr');
  const total = layout(blocks, breaking, finalIndex >= 0 ? blocks[finalIndex].xml : null);

  const doomed = new Set(pagesToDelete.filter((n) => Number.isInteger(n) && n >= 1 && n <= total));
  if (doomed.size === 0) throw new DocxPageError('No such page in this document.');
  if (doomed.size >= total) throw new DocxPageError('A document has to keep at least one page.');

  let keptPartial = 0;
  for (const block of blocks) {
    if (block.tag === 'w:sectPr' || block.pages.length === 0) continue;
    if (block.split) {
      const beforeGone = doomed.has(block.split.before);
      const afterGone = doomed.has(block.split.after);
      if (beforeGone && afterGone) block.deleted = true;
      else if (beforeGone) block.xml = paragraphHalf(block.xml, block.split, 'after');
      else if (afterGone) block.xml = paragraphHalf(block.xml, block.split, 'before');
      continue;
    }
    const all = block.pages.every((page) => doomed.has(page));
    const any = block.pages.some((page) => doomed.has(page));
    block.deleted = all;
    if (any && !all) keptPartial += 1;
  }

  // Sections: up to and including each paragraph that carries settings.
  const sections: number[][] = [];
  let section: number[] = [];
  blocks.forEach((block, index) => {
    section.push(index);
    if (block.sectPr || block.tag === 'w:sectPr') {
      sections.push(section);
      section = [];
    }
  });
  if (section.length) sections.push(section);

  for (const members of sections) {
    const holderIndex = members[members.length - 1];
    const holder = blocks[holderIndex];
    if (holder.tag === 'w:sectPr' || !holder.sectPr) continue;
    const survivors = members.filter((i) => i !== holderIndex && !blocks[i].deleted);
    if (holder.deleted && survivors.length > 0) {
      // The section keeps pages, so it keeps its settings.
      holder.deleted = false;
      holder.xml = emptied(holder.xml);
      holder.content = false;
    }
  }

  if (finalIndex >= 0) {
    const last = sections.find((members) => members.includes(finalIndex)) ?? [];
    const left = last.filter((i) => i !== finalIndex && !blocks[i].deleted && blocks[i].content);
    const anyLeft = last.some((i) => i !== finalIndex && !blocks[i].deleted);
    if (left.length === 0) {
      // The final section is gone: the closest surviving section becomes the
      // last, and its settings move to the end of the body.
      const previousHolder = [...sections]
        .reverse()
        .map((members) => members[members.length - 1])
        .find((i) => i !== finalIndex && blocks[i].sectPr && !blocks[i].deleted);
      if (previousHolder !== undefined) {
        const holder = blocks[previousHolder];
        blocks[finalIndex].xml = holder.sectPr as string;
        if (!holder.content) holder.deleted = true;
        else holder.xml = stripSectPr(holder.xml);
        holder.sectPr = null;
        // Empty leftovers of the vanished section would otherwise be laid
        // out in its place.
        for (const i of last) if (i !== finalIndex && !blocks[i].content) blocks[i].deleted = true;
      } else if (!anyLeft) {
        throw new DocxPageError('A document has to keep at least one page.');
      }
    }
  }

  const kept = blocks.filter((block) => !block.deleted);

  // Nothing may push the first page down.
  const first = kept.find((block) => block.tag === 'w:p' || block.tag === 'w:sdt');
  if (first) first.xml = stripLeadingBreaks(first.xml);

  // Where pages were taken out, the kept page before may end with a manual
  // page break and the kept page after begin with Word's marker of where it
  // last broke the page: together they would lay out as an empty page.
  let previous: Block | null = null;
  let previousIndex = -1;
  blocks.forEach((block, index) => {
    if (block.deleted || block.tag === 'w:sectPr') return;
    if (previous && index !== previousIndex + 1 && endsWithPageBreak(previous.xml)) {
      const pPr = /<w:pPr\b[\s\S]*?<\/w:pPr>/.exec(block.xml)?.[0] ?? '';
      const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(pPr)?.[1];
      if (truthy(pPr, 'w:pageBreakBefore') || (style && breaking.has(style))) previous.xml = dropTrailingPageBreak(previous.xml);
      else block.xml = stripLeadingBreaks(block.xml);
    }
    previous = block;
    previousIndex = index;
  });

  // Nor leave a blank page at the end.
  const lastKept = [...kept].reverse().find((block) => block.tag !== 'w:sectPr');
  if (lastKept && endsWithPageBreak(lastKept.xml)) lastKept.xml = dropTrailingPageBreak(lastKept.xml);

  const edited = head + kept.map((block) => block.xml).join('') + tail;
  return {
    documentXml: edited,
    deleted: [...doomed].sort((a, b) => a - b),
    pagesBefore: total,
    pagesAfter: countDocxPages(edited, stylesXml),
    keptPartial,
  };
}
