/**
 * Reader for the modern SolidWorks part container.
 *
 * A `.SLDPRT` written by a current SolidWorks is **not** an OLE compound file,
 * whatever the extension databases say. It is a package of its own with the
 * same conceptual shape as OOXML — `[Content_Types].xml`, `_rels/.rels`,
 * `docProps/*.xml`, and a `Contents/` tree — but with two twists:
 *
 *  1. Entry names are stored with the two nibbles of every byte swapped, so
 *     `Contents/Config-0-Partition` sits in the file as
 *     `34 f6 e6 47 …`. Swapping them back is the whole de-obfuscation.
 *  2. Only some payloads are plain zlib. The rest of the file has an entropy of
 *     about 7.9 bits per byte and two files of the same trivial part share no
 *     32-byte run, so the bulk is compressed or encrypted by some other means
 *     that this reader does not attempt to guess at.
 *
 * What matters is that the parts we need *are* the plain zlib ones: the
 * Parasolid partitions that hold the model's actual geometry.
 *
 * Everything here reads bytes as data. Nothing is executed, every walk is
 * bounded, and a payload is only accepted when it verifies against its own
 * declared sizes.
 */

import zlib from 'node:zlib';

/** Marks the start of an entry record. Present in every file examined. */
const ENTRY_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00, 0x09, 0xb7, 0xad, 0x1a]);

/** Ceilings, so a malformed or hostile file cannot spin the worker. */
const MAX_ENTRIES = 4096;
const MAX_NAME_BYTES = 250;
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;

export interface SldprtEntry {
  /** De-obfuscated name, e.g. `Contents/Config-0-Partition`. */
  name: string;
  /** Offset of the entry's marker in the file. */
  offset: number;
}

export interface SldprtPayload {
  /** Offset of the zlib header in the file. */
  offset: number;
  data: Buffer;
  compressedBytes: number;
}

/** Undo the nibble swap that obfuscates entry names. */
export function unswapNibbles(bytes: Buffer): Buffer {
  const out = Buffer.allocUnsafe(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    out[i] = ((byte & 0x0f) << 4) | (byte >> 4);
  }
  return out;
}

/**
 * A modern SolidWorks part or assembly, as opposed to the compound-file kind.
 *
 * Checked by finding the entry marker near the front rather than by a fixed
 * signature: the first bytes vary from file to file.
 */
export function isSolidWorksPackage(buffer: Buffer): boolean {
  return buffer.length > 64 && buffer.subarray(0, 4096).includes(ENTRY_MARKER);
}

/**
 * List the entries named in the package.
 *
 * The name is length-prefixed 16 bytes after the marker. Records near the end
 * of the file form a directory whose layout differs, so names read there can be
 * fragments — callers should treat this as a catalogue, not a guarantee.
 */
export function listEntries(buffer: Buffer): SldprtEntry[] {
  const entries: SldprtEntry[] = [];
  let at = buffer.indexOf(ENTRY_MARKER);

  while (at >= 0 && entries.length < MAX_ENTRIES) {
    const header = at + ENTRY_MARKER.length;
    if (header + 16 > buffer.length) break;

    const nameLength = buffer.readUInt32LE(header + 12);
    if (nameLength > 0 && nameLength <= MAX_NAME_BYTES && header + 16 + nameLength <= buffer.length) {
      const raw = buffer.subarray(header + 16, header + 16 + nameLength);
      entries.push({ name: unswapNibbles(raw).toString('latin1'), offset: at });
    }
    at = buffer.indexOf(ENTRY_MARKER, at + 1);
  }
  return entries;
}

/**
 * Every zlib payload in the package, found by self-verification.
 *
 * Each payload is preceded by its uncompressed and compressed sizes as two
 * little-endian 32-bit words. Requiring *both* to match what the stream
 * actually produces is what makes this reliable: a chance alignment satisfying
 * two independent numbers at once does not happen in practice. That matters,
 * because the record layout varies between entry kinds — pairing a payload to
 * its name by offset arithmetic gets it wrong on about a quarter of files,
 * while this check has not produced a false positive on any.
 */
export function readPayloads(buffer: Buffer): SldprtPayload[] {
  const payloads: SldprtPayload[] = [];
  let at = 8;

  while (at < buffer.length - 2 && payloads.length < MAX_ENTRIES) {
    const cmf = buffer[at];
    const flg = buffer[at + 1];
    // zlib header: deflate with a valid check value.
    if ((cmf & 0x0f) !== 8 || (((cmf << 8) | flg) % 31) !== 0) {
      at += 1;
      continue;
    }

    const declaredUncompressed = buffer.readUInt32LE(at - 8);
    const declaredCompressed = buffer.readUInt32LE(at - 4);
    if (
      declaredUncompressed === 0 ||
      declaredUncompressed > MAX_PAYLOAD_BYTES ||
      declaredCompressed === 0 ||
      declaredCompressed > buffer.length - at
    ) {
      at += 1;
      continue;
    }

    let data: Buffer;
    try {
      data = zlib.inflateSync(buffer.subarray(at, at + declaredCompressed));
    } catch {
      at += 1;
      continue;
    }

    if (data.length !== declaredUncompressed) {
      at += 1;
      continue;
    }

    payloads.push({ offset: at, data, compressedBytes: declaredCompressed });
    at += declaredCompressed;
  }

  return payloads;
}

/** A Parasolid transmit file begins with `PS` and says so in plain text. */
export function isParasolid(data: Buffer): boolean {
  if (data.length < 64 || data[0] !== 0x50 || data[1] !== 0x53) return false;
  return data.subarray(0, 128).toString('latin1').includes('TRANSMIT FILE');
}

export interface ParasolidPartition {
  data: Buffer;
  /** Modeller version quoted in the header, e.g. `3501210`. */
  version: string | null;
  /** `partition`, `deltas`, or whatever the header declares. */
  kind: string | null;
}

/**
 * The model's geometry.
 *
 * A part carries several Parasolid streams — the model partition, a much
 * smaller "ghost" partition and a deltas stream. The largest is the one with
 * the geometry in it; the others are bookkeeping.
 */
export function findParasolidPartitions(buffer: Buffer): ParasolidPartition[] {
  return readPayloads(buffer)
    .filter((payload) => isParasolid(payload.data))
    .map((payload) => {
      const header = payload.data.subarray(0, 160).toString('latin1');
      return {
        data: payload.data,
        version: /version\s+(\d+)/.exec(header)?.[1] ?? null,
        kind: /TRANSMIT FILE\s+\(([^)]+)\)/.exec(header)?.[1] ?? null,
      };
    })
    .sort((a, b) => b.data.length - a.data.length);
}
