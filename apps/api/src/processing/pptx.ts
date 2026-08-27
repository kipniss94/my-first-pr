/**
 * A small OOXML PowerPoint reader.
 *
 * Two jobs:
 *  1. `readOutline` — titles and speaker notes. Cheap, always used, because the
 *     LibreOffice→PDF path renders pixels but loses the outline.
 *  2. `readSlides`  — a best-effort native renderer used only when LibreOffice
 *     is not installed. It covers text boxes, pictures and simple shapes; it is
 *     deliberately not a full PowerPoint implementation.
 */
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SlideData, SlideDocument, SlideParagraph, SlideRun, SlideShape } from '@docuview/shared';

/** English Metric Units per CSS pixel at 96 dpi. */
const EMU_PER_PX = 9525;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseAttributeValue: false,
  trimValues: false,
  isArray: (name) => ['sp', 'pic', 'graphicFrame', 'grpSp', 'p', 'r', 'br', 'sldId'].includes(name),
});

type Xml = Record<string, any>;

function parseXml(zip: AdmZip, entryName: string): Xml | null {
  const entry = zip.getEntry(entryName);
  if (!entry) return null;
  try {
    return parser.parse(entry.getData().toString('utf8')) as Xml;
  } catch {
    return null;
  }
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Resolve the `r:id` → target map for a part. */
function readRels(zip: AdmZip, partPath: string): Map<string, string> {
  const dir = path.posix.dirname(partPath);
  const relsPath = path.posix.join(dir, '_rels', `${path.posix.basename(partPath)}.rels`);
  const xml = parseXml(zip, relsPath);
  const map = new Map<string, string>();
  for (const rel of asArray(xml?.Relationships?.Relationship)) {
    const id = rel['@Id'];
    const target = rel['@Target'];
    if (!id || !target) continue;
    const resolved = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(dir, target));
    map.set(id, resolved);
  }
  return map;
}

/** Slide part paths in presentation order. */
function slidePaths(zip: AdmZip): string[] {
  const presentation = parseXml(zip, 'ppt/presentation.xml');
  const rels = readRels(zip, 'ppt/presentation.xml');
  const ids = asArray(presentation?.presentation?.sldIdLst?.sldId);
  const ordered = ids
    .map((entry: Xml) => rels.get(entry['@id'] ?? entry['@r:id'] ?? entry['@id']))
    .filter((value: string | undefined): value is string => Boolean(value));
  if (ordered.length > 0) return ordered;

  // Fall back to a name sort when the id list is unusable.
  return zip
    .getEntries()
    .map((e) => e.entryName)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0));
}

/* --------------------------------- text ---------------------------------- */

function textOfBody(body: Xml | undefined): string {
  if (!body) return '';
  const parts: string[] = [];
  for (const paragraph of asArray(body.p)) {
    const line: string[] = [];
    for (const run of asArray(paragraph.r)) {
      if (typeof run?.t === 'string') line.push(run.t);
      else if (run?.t !== undefined) line.push(String(run.t));
    }
    if (typeof paragraph.fld?.t === 'string') line.push(paragraph.fld.t);
    parts.push(line.join(''));
  }
  return parts.join('\n').trim();
}

function placeholderType(shape: Xml): { type: string | null; idx: string | null } {
  const ph = shape?.nvSpPr?.nvPr?.ph;
  if (!ph) return { type: null, idx: null };
  return { type: ph['@type'] ?? 'body', idx: ph['@idx'] ?? null };
}

/* -------------------------------- outline -------------------------------- */

export interface SlideOutlineEntry {
  index: number;
  title: string | null;
  notes: string | null;
}

export async function readOutline(filePath: string): Promise<SlideOutlineEntry[]> {
  const zip = new AdmZip(filePath);
  const slides = slidePaths(zip);
  const outline: SlideOutlineEntry[] = [];

  slides.forEach((slidePath, index) => {
    const xml = parseXml(zip, slidePath);
    const shapes = collectShapes(xml?.sld?.cSld?.spTree);
    let title: string | null = null;
    let firstText: string | null = null;

    for (const shape of shapes.sp) {
      const text = textOfBody(shape.txBody);
      if (!text) continue;
      const ph = placeholderType(shape);
      if (!title && ph.type && /^(title|ctrTitle)$/i.test(ph.type)) title = text.split('\n')[0];
      if (!firstText) firstText = text.split('\n')[0];
    }

    let notes: string | null = null;
    const slideRels = readRels(zip, slidePath);
    for (const target of slideRels.values()) {
      if (target.includes('notesSlide')) {
        const notesXml = parseXml(zip, target);
        const notesShapes = collectShapes(notesXml?.notes?.cSld?.spTree);
        const texts = notesShapes.sp
          .filter((shape) => placeholderType(shape).type !== 'sldImg')
          .map((shape) => textOfBody(shape.txBody))
          .filter(Boolean);
        notes = texts.join('\n\n').trim() || null;
        break;
      }
    }

    outline.push({ index: index + 1, title: title ?? firstText ?? null, notes });
  });

  return outline;
}

/* ---------------------------- native rendering ---------------------------- */

interface CollectedShapes {
  sp: Xml[];
  pic: Xml[];
}

/** Flatten group shapes so nested content is not lost. */
function collectShapes(spTree: Xml | undefined, depth = 0): CollectedShapes {
  const out: CollectedShapes = { sp: [], pic: [] };
  if (!spTree || depth > 12) return out;
  out.sp.push(...asArray(spTree.sp));
  out.pic.push(...asArray(spTree.pic));
  for (const group of asArray(spTree.grpSp)) {
    const nested = collectShapes(group, depth + 1);
    out.sp.push(...nested.sp);
    out.pic.push(...nested.pic);
  }
  return out;
}

interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}

function readFrame(spPr: Xml | undefined): Frame | null {
  const xfrm = spPr?.xfrm;
  const off = xfrm?.off;
  const ext = xfrm?.ext;
  if (!off || !ext) return null;
  const x = Number(off['@x']);
  const y = Number(off['@y']);
  const w = Number(ext['@cx']);
  const h = Number(ext['@cy']);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  return {
    x: x / EMU_PER_PX,
    y: y / EMU_PER_PX,
    w: w / EMU_PER_PX,
    h: h / EMU_PER_PX,
    rot: Number(xfrm['@rot'] ?? 0) / 60000,
  };
}

/** Placeholder geometry inherited from the slide layout. */
function layoutFrames(zip: AdmZip, slidePath: string): Map<string, Frame> {
  const frames = new Map<string, Frame>();
  const rels = readRels(zip, slidePath);
  const layoutPath = [...rels.values()].find((target) => target.includes('slideLayout'));
  if (!layoutPath) return frames;
  const layout = parseXml(zip, layoutPath);
  for (const shape of collectShapes(layout?.sldLayout?.cSld?.spTree).sp) {
    const frame = readFrame(shape.spPr);
    if (!frame) continue;
    const ph = placeholderType(shape);
    if (ph.type) frames.set(`${ph.type}:${ph.idx ?? ''}`, frame);
    if (ph.idx) frames.set(`idx:${ph.idx}`, frame);
  }
  return frames;
}

function srgb(node: Xml | undefined): string | undefined {
  const value = node?.solidFill?.srgbClr?.['@val'];
  return typeof value === 'string' ? `#${value}` : undefined;
}

function readParagraphs(body: Xml | undefined): SlideParagraph[] {
  if (!body) return [];
  const paragraphs: SlideParagraph[] = [];
  const bodyDefaults = body.lstStyle?.lvl1pPr;

  for (const paragraph of asArray(body.p)) {
    const pPr = paragraph.pPr ?? {};
    const align = ({ l: 'left', ctr: 'center', r: 'right', just: 'justify' } as const)[
      pPr['@algn'] as 'l' | 'ctr' | 'r' | 'just'
    ];
    const runs: SlideRun[] = [];
    for (const run of asArray(paragraph.r)) {
      const text = typeof run?.t === 'string' ? run.t : run?.t !== undefined ? String(run.t) : '';
      if (text === '') continue;
      const rPr = run.rPr ?? {};
      const size = Number(rPr['@sz']);
      runs.push({
        text,
        bold: rPr['@b'] === '1' || rPr['@b'] === 'true',
        italic: rPr['@i'] === '1' || rPr['@i'] === 'true',
        underline: typeof rPr['@u'] === 'string' && rPr['@u'] !== 'none',
        size: Number.isFinite(size) ? size / 100 : undefined,
        color: srgb(rPr) ?? srgb(bodyDefaults?.defRPr),
        font: rPr.latin?.['@typeface'],
      });
    }
    if (runs.length === 0 && !paragraph.pPr) continue;
    paragraphs.push({
      align: align ?? 'left',
      bullet: pPr.buNone === undefined && (pPr.buChar !== undefined || pPr.buAutoNum !== undefined),
      level: Number(pPr['@lvl'] ?? 0) || 0,
      runs,
    });
  }
  return paragraphs;
}

export interface NativeRenderResult {
  document: SlideDocument;
  /** Media files to write into the asset directory: name → bytes. */
  media: Map<string, Buffer>;
}

export async function readSlides(filePath: string, assetUrlPrefix: string): Promise<NativeRenderResult> {
  const zip = new AdmZip(filePath);
  const presentation = parseXml(zip, 'ppt/presentation.xml');
  const size = presentation?.presentation?.sldSz;
  const width = Number(size?.['@cx'] ?? 12192000) / EMU_PER_PX;
  const height = Number(size?.['@cy'] ?? 6858000) / EMU_PER_PX;

  const warnings: string[] = [];
  const media = new Map<string, Buffer>();
  const slides: SlideData[] = [];
  const outline = await readOutline(filePath);

  slidePaths(zip).forEach((slidePath, index) => {
    const xml = parseXml(zip, slidePath);
    if (!xml) {
      warnings.push(`Slide ${index + 1} could not be read and was skipped.`);
      return;
    }
    const rels = readRels(zip, slidePath);
    const inherited = layoutFrames(zip, slidePath);
    const tree = collectShapes(xml.sld?.cSld?.spTree);
    const shapes: SlideShape[] = [];

    for (const shape of tree.sp) {
      const ph = placeholderType(shape);
      const frame =
        readFrame(shape.spPr) ??
        inherited.get(`${ph.type ?? ''}:${ph.idx ?? ''}`) ??
        (ph.idx ? inherited.get(`idx:${ph.idx}`) : undefined) ??
        (ph.type ? inherited.get(`${ph.type}:`) : undefined);
      if (!frame) continue;
      const paragraphs = readParagraphs(shape.txBody);
      const fill = srgb(shape.spPr);
      if (paragraphs.length === 0 && !fill) continue;
      shapes.push({
        type: paragraphs.length > 0 ? 'text' : 'rect',
        x: frame.x,
        y: frame.y,
        w: frame.w,
        h: frame.h,
        rot: frame.rot || undefined,
        fill,
        paragraphs: paragraphs.length > 0 ? paragraphs : undefined,
      });
    }

    for (const picture of tree.pic) {
      const frame = readFrame(picture.spPr);
      if (!frame) continue;
      const embedId = picture.blipFill?.blip?.['@embed'];
      const target = embedId ? rels.get(embedId) : undefined;
      if (!target) continue;
      const entry = zip.getEntry(target);
      if (!entry) continue;
      const safeName = `slide-media-${media.size}${path.extname(target).toLowerCase() || '.png'}`;
      if (!/\.(png|jpe?g|gif|bmp|webp|svg)$/i.test(safeName)) {
        warnings.push('A picture in an unsupported image format was skipped.');
        continue;
      }
      media.set(safeName, entry.getData());
      shapes.push({
        type: 'image',
        x: frame.x,
        y: frame.y,
        w: frame.w,
        h: frame.h,
        rot: frame.rot || undefined,
        src: `${assetUrlPrefix}/${safeName}`,
      });
    }

    if (asArray(xml.sld?.cSld?.spTree?.graphicFrame).length > 0) {
      warnings.push(`Slide ${index + 1} contains a table or chart that this fallback renderer cannot draw.`);
    }

    slides.push({
      index: index + 1,
      title: outline[index]?.title ?? null,
      notes: outline[index]?.notes ?? null,
      shapes,
    });
  });

  if (slides.length === 0) {
    warnings.push('No slides could be read from this presentation.');
  }

  return {
    document: { width, height, slides, producer: 'docuview-pptx (fallback renderer)', warnings },
    media,
  };
}

export async function writeMedia(media: Map<string, Buffer>, assetsDir: string): Promise<void> {
  await fs.mkdir(assetsDir, { recursive: true });
  for (const [name, buffer] of media) {
    await fs.writeFile(path.join(assetsDir, name), buffer);
  }
}
