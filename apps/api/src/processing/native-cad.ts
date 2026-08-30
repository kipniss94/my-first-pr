/**
 * Read what a proprietary CAD file is willing to tell us without its kernel.
 *
 * SolidWorks, Inventor, Revit and friends wrap their documents in a compound
 * file and, alongside the closed geometry streams, store two standard things:
 * an OLE property set (title, author, company, revision, custom properties) and
 * a rendered preview image. Both are documented and both are useful, so a
 * `.SLDPRT` can be opened and inspected immediately instead of being turned
 * away at the door.
 *
 * What this cannot do is reconstruct geometry: the solid model itself is a
 * closed format. Full 3D needs the converter hook in `converter.ts`.
 */

import { isCompoundFile, readCompoundFile, type CfbEntry } from './cfb.js';
import { bestImage, findEmbeddedImages, type EmbeddedImage } from './embedded.js';

export type NativeCadRole = 'part' | 'assembly' | 'drawing' | 'unknown';

export interface NativeCadProperty {
  name: string;
  value: string;
}

export interface NativeCadInfo {
  /** Product the file belongs to, e.g. `SolidWorks`. */
  application: string;
  /** Version string when the file states one, e.g. `SolidWorks 2021`. */
  version: string | null;
  role: NativeCadRole;
  preview: EmbeddedImage | null;
  properties: NativeCadProperty[];
  /** File names this document references, for assemblies and drawings. */
  references: string[];
  /** Notes for the processing log. */
  detail: string[];
}

/* ----------------------------- format families ---------------------------- */

interface Family {
  application: string;
  /** Extensions of the files this family's assemblies reference. */
  referenceExtensions: string[];
  role(extension: string): NativeCadRole;
}

const FAMILIES: Record<string, Family> = {
  sldprt: {
    application: 'SolidWorks',
    referenceExtensions: ['sldprt', 'sldasm'],
    role: (ext) => (ext === 'sldasm' ? 'assembly' : ext === 'slddrw' ? 'drawing' : 'part'),
  },
  inventor: {
    application: 'Autodesk Inventor',
    referenceExtensions: ['ipt', 'iam'],
    role: (ext) => (ext === 'iam' ? 'assembly' : 'part'),
  },
  catia: {
    application: 'CATIA',
    referenceExtensions: ['catpart', 'catproduct'],
    role: (ext) => (ext === 'catproduct' ? 'assembly' : 'part'),
  },
  rvt: {
    application: 'Autodesk Revit',
    referenceExtensions: ['rvt', 'rfa'],
    role: () => 'unknown',
  },
  jt: {
    application: 'JT',
    referenceExtensions: ['jt'],
    role: () => 'unknown',
  },
  parasolid: {
    application: 'Parasolid',
    referenceExtensions: [],
    role: () => 'part',
  },
};

function familyFor(formatId: string): Family {
  return FAMILIES[formatId] ?? { application: 'CAD', referenceExtensions: [], role: () => 'unknown' };
}

/* ---------------------------- OLE property sets ---------------------------- */

const SUMMARY_NAMES: Record<number, string> = {
  2: 'Title',
  3: 'Subject',
  4: 'Author',
  5: 'Keywords',
  6: 'Comments',
  8: 'Last saved by',
  9: 'Revision',
  12: 'Created',
  13: 'Last saved',
  18: 'Created with',
};

const DOC_SUMMARY_NAMES: Record<number, string> = {
  2: 'Category',
  14: 'Manager',
  15: 'Company',
};

const CODEPAGE_LABELS: Record<number, string> = {
  1200: 'utf-16le',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  10000: 'macintosh',
  65001: 'utf-8',
};

function decodeAnsi(bytes: Buffer, codepage: number): string {
  const label = CODEPAGE_LABELS[codepage];
  if (label && label !== 'utf-16le') {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      /* Node without full ICU: fall through to latin1. */
    }
  }
  return bytes.toString('latin1');
}

/** Windows FILETIME (100 ns ticks since 1601) as an ISO date, or null. */
function filetime(low: number, high: number): string | null {
  const ticks = high * 4294967296 + low;
  if (ticks <= 0) return null;
  const ms = ticks / 10000 - 11644473600000;
  if (!Number.isFinite(ms) || ms < 0 || ms > 4102444800000) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

interface PropertyValue {
  text: string | null;
  /** Raw bytes for VT_CF thumbnails. */
  blob: Buffer | null;
}

function readPropertyValue(buffer: Buffer, at: number, codepage: number): PropertyValue {
  if (at + 4 > buffer.length) return { text: null, blob: null };
  const type = buffer.readUInt32LE(at);
  const body = at + 4;

  switch (type) {
    case 0x02: // VT_I2
      return body + 2 <= buffer.length ? { text: String(buffer.readInt16LE(body)), blob: null } : { text: null, blob: null };
    case 0x03: // VT_I4
    case 0x16: // VT_INT
      return body + 4 <= buffer.length ? { text: String(buffer.readInt32LE(body)), blob: null } : { text: null, blob: null };
    case 0x05: // VT_R8
      return body + 8 <= buffer.length ? { text: String(buffer.readDoubleLE(body)), blob: null } : { text: null, blob: null };
    case 0x0b: // VT_BOOL
      return body + 2 <= buffer.length
        ? { text: buffer.readInt16LE(body) === 0 ? 'No' : 'Yes', blob: null }
        : { text: null, blob: null };
    case 0x1e: {
      // VT_LPSTR: length in bytes, in the section's code page.
      if (body + 4 > buffer.length) break;
      const length = buffer.readUInt32LE(body);
      if (length > buffer.length - body - 4) break;
      const raw = buffer.subarray(body + 4, body + 4 + length);
      const end = raw.indexOf(0);
      return { text: decodeAnsi(end >= 0 ? raw.subarray(0, end) : raw, codepage), blob: null };
    }
    case 0x1f: {
      // VT_LPWSTR: length in UTF-16 code units.
      if (body + 4 > buffer.length) break;
      const units = buffer.readUInt32LE(body);
      const bytes = units * 2;
      if (bytes > buffer.length - body - 4) break;
      const text = buffer.subarray(body + 4, body + 4 + bytes).toString('utf16le');
      return { text: text.replace(/\u0000+$/, ''), blob: null };
    }
    case 0x40: {
      // VT_FILETIME
      if (body + 8 > buffer.length) break;
      return { text: filetime(buffer.readUInt32LE(body), buffer.readUInt32LE(body + 4)), blob: null };
    }
    case 0x41: // VT_BLOB
    case 0x47: {
      // VT_CF: a clipboard blob, which is how thumbnails are stored.
      if (body + 4 > buffer.length) break;
      const length = buffer.readUInt32LE(body);
      if (length > buffer.length - body - 4) break;
      return { text: null, blob: buffer.subarray(body + 4, body + 4 + length) };
    }
    default:
      break;
  }
  return { text: null, blob: null };
}

interface PropertySection {
  properties: Map<number, PropertyValue>;
  /** User-defined names, present in the custom-properties section. */
  dictionary: Map<number, string>;
  codepage: number;
}

function readPropertySections(stream: Buffer): PropertySection[] {
  if (stream.length < 48 || stream.readUInt16LE(0) !== 0xfffe) return [];
  const sectionCount = Math.min(stream.readUInt32LE(24), 4);
  const sections: PropertySection[] = [];

  for (let index = 0; index < sectionCount; index += 1) {
    const headerAt = 28 + index * 20;
    if (headerAt + 20 > stream.length) break;
    const start = stream.readUInt32LE(headerAt + 16);
    if (start + 8 > stream.length) continue;

    const count = Math.min(stream.readUInt32LE(start + 4), 4096);
    const properties = new Map<number, PropertyValue>();
    const offsets = new Map<number, number>();

    for (let i = 0; i < count; i += 1) {
      const pairAt = start + 8 + i * 8;
      if (pairAt + 8 > stream.length) break;
      offsets.set(stream.readUInt32LE(pairAt), start + stream.readUInt32LE(pairAt + 4));
    }

    // The code page governs how every VT_LPSTR in the section decodes, so read
    // it before anything else.
    let codepage = 1252;
    const codepageAt = offsets.get(1);
    if (codepageAt !== undefined && codepageAt + 6 <= stream.length) {
      const value = stream.readInt16LE(codepageAt + 4);
      codepage = value < 0 ? value + 65536 : value;
    }

    const dictionary = new Map<number, string>();
    const dictionaryAt = offsets.get(0);
    if (dictionaryAt !== undefined && dictionaryAt + 4 <= stream.length) {
      const entries = Math.min(stream.readUInt32LE(dictionaryAt), 4096);
      let cursor = dictionaryAt + 4;
      for (let i = 0; i < entries && cursor + 8 <= stream.length; i += 1) {
        const id = stream.readUInt32LE(cursor);
        const length = stream.readUInt32LE(cursor + 4);
        cursor += 8;
        if (codepage === 1200) {
          const bytes = length * 2;
          if (cursor + bytes > stream.length) break;
          dictionary.set(id, stream.subarray(cursor, cursor + bytes).toString('utf16le').replace(/\u0000+$/, ''));
          // Unicode dictionary entries are padded to a 4-byte boundary.
          cursor += bytes + ((4 - (bytes % 4)) % 4);
        } else {
          if (cursor + length > stream.length) break;
          const raw = stream.subarray(cursor, cursor + length);
          const end = raw.indexOf(0);
          dictionary.set(id, decodeAnsi(end >= 0 ? raw.subarray(0, end) : raw, codepage));
          cursor += length;
        }
      }
    }

    for (const [id, at] of offsets) {
      if (id === 0 || id === 1) continue;
      properties.set(id, readPropertyValue(stream, at, codepage));
    }
    sections.push({ properties, dictionary, codepage });
  }

  return sections;
}

/* ------------------------- assembly reference names ------------------------ */

/**
 * Component file names an assembly refers to.
 *
 * The paths are stored as ordinary strings in the container, so we look for
 * anything that ends in one of the family's own extensions, in both the UTF-16
 * and the 8-bit encodings the writers use, and keep the base names.
 */
export function extractReferences(text: string, extensions: string[]): string[] {
  if (extensions.length === 0) return [];
  const suffix = new RegExp(String.raw`\.(?:${extensions.join('|')})\b`, 'gi');
  const seen = new Map<string, string>();
  let previousEnd = 0;

  for (const match of text.matchAll(suffix)) {
    const end = (match.index ?? 0) + match[0].length;

    // Walk backwards from the extension to the start of the name. Stopping at
    // the previous match keeps two adjacent references from being swallowed
    // into one, which is what a greedy forward match does.
    const floor = Math.max(previousEnd, end - MAX_REFERENCE_LENGTH);
    let start = match.index ?? 0;
    while (start > floor && NAME_CHARACTER.test(text[start - 1])) start -= 1;
    previousEnd = end;

    // A path separator means everything before it was a directory.
    const raw = text.slice(start, end);
    const name = (raw.split(/[\\/:]/).pop() ?? '').trim().replace(/^[^\w]+/, '');
    if (name.length < 5 || name.length > 180) continue;

    const key = name.toLowerCase();
    if (!seen.has(key)) seen.set(key, name);
    if (seen.size >= MAX_REFERENCES) break;
  }
  return [...seen.values()];
}

/** Characters a component file name may contain, per the walk above. */
const NAME_CHARACTER = /[\w \-.()[\]{}#+&,'~@$%!=]/;
const MAX_REFERENCE_LENGTH = 200;
const MAX_REFERENCES = 500;

/** Both string encodings a compound file mixes, flattened for searching. */
function searchableText(buffer: Buffer): string {
  const utf16 = buffer.toString('utf16le');
  const latin = buffer.toString('latin1');
  return `${utf16}\n${latin}`;
}

/* ---------------------------------- main ---------------------------------- */

const APPLICATION_VERSION = /\b(SolidWorks|SOLIDWORKS|Autodesk Inventor|Inventor|CATIA|Revit|NX|Creo|Pro\/ENGINEER|Siemens)\b[^\S\r\n]*(V?\d{1,4}(?:\.\d{1,3})?)?/;

export function inspectNativeCad(buffer: Buffer, formatId: string, extension: string): NativeCadInfo {
  const family = familyFor(formatId);
  const detail: string[] = [];
  const properties: NativeCadProperty[] = [];
  let preview: EmbeddedImage | null = null;
  let references: string[] = [];
  let version: string | null = null;

  const addProperty = (name: string, value: string | null | undefined): void => {
    const trimmed = value?.trim();
    if (!trimmed || properties.length >= 40) return;
    if (properties.some((p) => p.name === name)) return;
    properties.push({ name, value: trimmed.slice(0, 300) });
  };

  if (isCompoundFile(buffer)) {
    const cfb = readCompoundFile(buffer);
    if (cfb) {
      detail.push(`cfb:${cfb.entries.length} entries`);
      const streams = cfb.entries.filter((e) => e.type === 2);

      /* -- property sets ---------------------------------------------------- */
      const summary = streams.find((e) => e.name.endsWith('SummaryInformation') && !e.name.includes('Document'));
      const docSummary = streams.find((e) => e.name.includes('DocumentSummaryInformation'));

      if (summary) {
        for (const section of readPropertySections(cfb.read(summary))) {
          for (const [id, name] of Object.entries(SUMMARY_NAMES)) {
            addProperty(name, section.properties.get(Number(id))?.text);
          }
          const thumbnail = section.properties.get(17)?.blob;
          if (thumbnail && thumbnail.length > 64) {
            preview = bestImage(findEmbeddedImages(thumbnail, 'SummaryInformation thumbnail'));
            if (preview) detail.push(`preview:summary ${preview.width}x${preview.height} ${preview.type}`);
          }
        }
      }

      if (docSummary) {
        const sections = readPropertySections(cfb.read(docSummary));
        for (const [index, section] of sections.entries()) {
          if (index === 0) {
            for (const [id, name] of Object.entries(DOC_SUMMARY_NAMES)) {
              addProperty(name, section.properties.get(Number(id))?.text);
            }
          } else {
            // Section 2 holds the document's custom properties — material,
            // mass, drawing number and whatever else the engineer defined.
            for (const [id, value] of section.properties) {
              const name = section.dictionary.get(id);
              if (name && value.text) addProperty(name, value.text);
            }
          }
        }
      }

      /* -- preview ---------------------------------------------------------- */
      if (!preview) {
        const named = streams
          .filter((e) => /preview|thumbnail|bitmap|image/i.test(e.name) && e.size > 128)
          .sort((a, b) => b.size - a.size);
        preview = firstPreview(cfb, named);
        if (preview) detail.push(`preview:stream ${preview.origin} ${preview.width}x${preview.height}`);
      }
      if (!preview) {
        // Some writers put the preview in an unhelpfully named stream, so fall
        // back to the largest streams rather than giving up.
        const candidates = streams.filter((e) => e.size > 2048).sort((a, b) => b.size - a.size).slice(0, 24);
        preview = firstPreview(cfb, candidates);
        if (preview) detail.push(`preview:scan ${preview.origin} ${preview.width}x${preview.height}`);
      }

      /* -- version and references ------------------------------------------- */
      const textStreams = streams.filter((e) => e.size > 0 && e.size < 4 * 1024 * 1024).slice(0, 200);
      let haystack = '';
      for (const entry of textStreams) {
        if (haystack.length > 8 * 1024 * 1024) break;
        haystack += searchableText(cfb.read(entry));
      }
      version = detectVersion(haystack);
      references = extractReferences(haystack, family.referenceExtensions);
    } else {
      detail.push('cfb:unreadable');
    }
  }

  if (!preview) {
    // Not a compound file (CATIA, JT) or an unreadable one: the preview is
    // still an ordinary image somewhere in the bytes.
    preview = bestImage(findEmbeddedImages(buffer, 'raw'));
    if (preview) detail.push(`preview:raw ${preview.width}x${preview.height} ${preview.type}`);
  }
  if (!version || references.length === 0) {
    const text = searchableText(buffer.subarray(0, Math.min(buffer.length, 8 * 1024 * 1024)));
    version ??= detectVersion(text);
    if (references.length === 0) references = extractReferences(text, family.referenceExtensions);
  }

  const role = family.role(extension);
  // A part file names itself; that is not a component reference.
  const selfNames = new Set([extension]);
  references = references.filter((name) => role === 'assembly' || !selfNames.has(name.split('.').pop()?.toLowerCase() ?? ''));

  return {
    application: family.application,
    version,
    role,
    preview,
    properties,
    references: role === 'assembly' ? references : [],
    detail,
  };
}

function firstPreview(cfb: { read(entry: CfbEntry): Buffer }, entries: CfbEntry[]): EmbeddedImage | null {
  const found: EmbeddedImage[] = [];
  for (const entry of entries) {
    const image = bestImage(findEmbeddedImages(cfb.read(entry), entry.path));
    if (image) found.push(image);
  }
  return bestImage(found);
}

function detectVersion(text: string): string | null {
  const match = APPLICATION_VERSION.exec(text);
  if (!match) return null;
  const product = match[1].replace('SOLIDWORKS', 'SolidWorks');
  return match[2] ? `${product} ${match[2]}` : product;
}
