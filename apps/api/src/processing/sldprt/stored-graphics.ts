/**
 * The graphics an assembly keeps of its own parts.
 *
 * Besides naming its part files, a SolidWorks assembly saved in recent
 * versions keeps each part's display mesh — the same triangles the part file
 * holds, in the part's own coordinates — under `FaceTessellations/`. So a
 * part whose file is not at hand (a Toolbox fastener from the author's
 * library, say) can still be drawn where the assembly puts it.
 *
 * `FaceTessellations/Directory` lists every part occurrence: its path in the
 * tree, each instance named `name-N@parent`, joined by `/`; then 8 bytes
 * naming the part's geometry and, for an occurrence after the first of that
 * geometry, 8 more of its own; then the stream holding the mesh and the
 * block in it, or an empty name and −1 when an earlier occurrence of the
 * same geometry has it. A stream (`000-000-271`…) is blocks one after
 * another: the block's number, the geometry's 8 bytes, the face count, and
 * the faces in the display-list layout (`display-list.ts`).
 */

import { unwrapCodec, type PackageEntry } from './container.js';
import { decodeFaces, type DisplayFace } from './display-list.js';

export interface StoredGraphics {
  /** The faces of the part placed at this path of instance names, or null. */
  facesAt(path: string[]): DisplayFace[] | null;
  /** How many occurrences the directory lists. */
  occurrences: number;
}

function cstring(data: Buffer, at: number): { text: string; end: number } | null {
  if (at + 4 > data.length || data[at] !== 0xff || data[at + 1] !== 0xfe || data[at + 2] !== 0xff) return null;
  let length = data[at + 3];
  let start = at + 4;
  if (length === 0xff) {
    if (start + 2 > data.length) return null;
    length = data.readUInt16LE(start);
    start += 2;
  }
  const end = start + length * 2;
  return end <= data.length ? { text: data.subarray(start, end).toString('utf16le'), end } : null;
}

/** A directory path as a list of instance names, `@parent` dropped. */
export function instancePath(text: string): string[] {
  return text.split('/').map((segment) => segment.replace(/@[^@]*$/, ''));
}

const MARK = Buffer.from([0xff, 0xfe, 0xff]);

/** Paths compared without case or spaces: the tree and the directory space names differently. */
const pathKey = (path: string[]) => path.join('/').toLowerCase().replace(/\s+/g, '');

export function readStoredGraphics(entries: PackageEntry[]): StoredGraphics | null {
  const entry = entries.find((e) => e.name === 'FaceTessellations/Directory');
  if (!entry) return null;
  const directory = unwrapCodec(entry.data) ?? entry.data;

  // Occurrences: path → geometry; geometry → stream and block.
  const geometryOf = new Map<string, string>();
  const blockOf = new Map<string, { stream: string; block: number }>();
  for (let at = directory.indexOf(MARK); at >= 0; ) {
    const path = cstring(directory, at);
    if (!path || !path.text.includes('@')) {
      at = directory.indexOf(MARK, at + 1);
      continue;
    }
    // The stream name comes within a few dozen bytes, behind the geometry's 8 (and maybe 8 more).
    const streamAt = directory.indexOf(MARK, path.end);
    const stream = streamAt >= 0 && streamAt - path.end <= 64 ? cstring(directory, streamAt) : null;
    if (!stream || stream.end + 4 > directory.length) {
      at = directory.indexOf(MARK, path.end);
      continue;
    }
    const zero = (from: number) => directory.subarray(from, from + 8).every((b) => b === 0);
    // Two hashes when the 8 bytes before the last 8 are not padding.
    const second = streamAt - 16 >= path.end && !zero(streamAt - 16) && !zero(streamAt - 8);
    const geometry = directory.subarray(second ? streamAt - 16 : streamAt - 8, second ? streamAt - 8 : streamAt).toString('hex');
    const block = directory.readInt32LE(stream.end);
    if (!/^0+$/.test(geometry)) {
      geometryOf.set(pathKey(instancePath(path.text)), geometry);
      if (stream.text && block >= 0 && !blockOf.has(geometry)) blockOf.set(geometry, { stream: stream.text, block });
    }
    at = directory.indexOf(MARK, stream.end);
  }
  if (blockOf.size === 0) return null;

  // Streams, decoded once each, their faces split by block.
  const decoded = new Map<string, Map<string, DisplayFace[]>>();
  const blocksIn = (stream: string): Map<string, DisplayFace[]> => {
    const cached = decoded.get(stream);
    if (cached) return cached;
    const blocks = new Map<string, DisplayFace[]>();
    decoded.set(stream, blocks);
    const raw = entries.find((e) => e.name === `FaceTessellations/${stream}`)?.data;
    if (!raw) return blocks;
    const data = unwrapCodec(raw) ?? raw;
    const { faces, spans } = decodeFaces(data);
    // A block's header — its number, geometry and face count — stands right
    // before its first face's id and strip count.
    const wanted = new Map<string, number>();
    for (const [geometry, where] of blockOf) if (where.stream === stream) wanted.set(geometry, where.block);
    spans.forEach((span, k) => {
      const at = span.at - 8 - 16;
      if (at < 0) return;
      const geometry = data.subarray(at + 4, at + 12).toString('hex');
      if (wanted.get(geometry) !== data.readInt32LE(at) || blocks.has(geometry)) return;
      blocks.set(geometry, faces.slice(k, k + data.readUInt32LE(at + 12)));
    });
    return blocks;
  };

  return {
    occurrences: geometryOf.size,
    facesAt(path: string[]) {
      const geometry = geometryOf.get(pathKey(path));
      const where = geometry ? blockOf.get(geometry) : undefined;
      if (!geometry || !where) return null;
      const faces = blocksIn(where.stream).get(geometry);
      return faces && faces.length > 0 ? faces : null;
    },
  };
}
