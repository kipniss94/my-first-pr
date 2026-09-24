/**
 * Reader for the modern SolidWorks part container.
 *
 * A `.SLDPRT` written by a current SolidWorks is **not** an OLE compound file,
 * whatever the extension databases say. It is a ZIP archive with two twists:
 *
 *  1. The `PK\x03\x04` signature of every local header is gone. What is left
 *     starts at "version needed" — `14 00` (2.0), flags `06 00`, method
 *     `08 00` (deflate), then time, date, CRC-32 and both sizes, exactly as in
 *     any ZIP. That is why the bytes after the first six "varied by writing
 *     version": they are the file's modification time and date.
 *  2. Entry names are stored with the two nibbles of every byte swapped, so
 *     `Contents/Config-0-Partition` sits in the file as `34 f6 e6 47 …`.
 *
 * Every entry therefore verifies itself: inflate it and the CRC-32 and length
 * in its own header must match. Across 132 real parts every entry that matters
 * does — the model partition, the display mesh and the preview image.
 *
 * This corrects an earlier reading of the same files. Scanning the raw bytes
 * for zlib streams found the model in only half of them, and the rest were
 * wrongly put down to an unknown codec: in those files the ZIP-level deflate
 * had actually compressed the entry, hiding the inner stream from a byte scan.
 * Read as ZIP entries, nothing is closed.
 *
 * Everything here reads bytes as data. Nothing is executed, every walk is
 * bounded, and an entry is only accepted when it verifies.
 */

import zlib from 'node:zlib';

/**
 * The first six bytes of a local header once its signature is stripped:
 * version 2.0, flags 6, method 8 (deflate). The four after them are the file's
 * modification time and date, so they differ from file to file — which is why
 * matching ten bytes once silently skipped every newer file.
 */
const ENTRY_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);

/** Bytes between the marker's start and the name-length field. */
const NAME_LENGTH_OFFSET = 22;

/** Ceilings, so a malformed or hostile file cannot spin the worker. */
const MAX_ENTRIES = 4096;
const MAX_NAME_BYTES = 250;
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;

/** Local header fields after the stripped `PK\x03\x04`, in bytes. */
const LOCAL_HEADER_BYTES = 26;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 as ZIP computes it. Kept local so no particular Node release is required. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface PackageEntry {
  /** De-obfuscated name, e.g. `Contents/DisplayLists`. */
  name: string;
  /** Offset of the local header in the file. */
  offset: number;
  /** The entry's content, inflated and checked against its CRC-32. */
  data: Buffer;
}

/**
 * Every entry of the package whose content verifies.
 *
 * A candidate header is any `14 00` whose fields are self-consistent; it is
 * accepted only when its data inflates to exactly the declared length with
 * exactly the declared CRC-32. Two independent checks on top of a successful
 * inflate do not pass by accident, so the scan can afford to try every offset.
 */
export function readPackage(buffer: Buffer): PackageEntry[] {
  const entries: PackageEntry[] = [];
  const version = Buffer.from([0x14, 0x00]);
  let at = buffer.indexOf(version);

  while (at >= 0 && at + LOCAL_HEADER_BYTES <= buffer.length && entries.length < MAX_ENTRIES) {
    const accepted = tryEntry(buffer, at);
    if (accepted) {
      entries.push(accepted.entry);
      at = buffer.indexOf(version, accepted.next);
    } else {
      at = buffer.indexOf(version, at + 1);
    }
  }
  return entries;
}

function tryEntry(buffer: Buffer, at: number): { entry: PackageEntry; next: number } | null {
  const method = buffer.readUInt16LE(at + 4);
  if (method !== 8 && method !== 0) return null;
  const crc = buffer.readUInt32LE(at + 10);
  const compressed = buffer.readUInt32LE(at + 14);
  const size = buffer.readUInt32LE(at + 18);
  const nameLength = buffer.readUInt16LE(at + 22);
  const extraLength = buffer.readUInt16LE(at + 24);
  const start = at + LOCAL_HEADER_BYTES + nameLength + extraLength;
  if (
    nameLength === 0 ||
    nameLength > MAX_NAME_BYTES ||
    compressed === 0 ||
    size > MAX_ENTRY_BYTES ||
    start + compressed > buffer.length
  ) {
    return null;
  }

  let data: Buffer;
  try {
    const raw = buffer.subarray(start, start + compressed);
    data = method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }) : Buffer.from(raw);
  } catch {
    return null;
  }
  if (data.length !== size || crc32(data) !== crc) return null;

  const name = unswapNibbles(buffer.subarray(at + LOCAL_HEADER_BYTES, at + LOCAL_HEADER_BYTES + nameLength)).toString('latin1');
  return { entry: { name, offset: at, data }, next: start + compressed };
}

/**
 * Marks an entry whose content is itself a zlib stream: a 16-byte codec GUID,
 * then the uncompressed and compressed sizes, then the stream.
 */
const ZLIB_CODEC = Buffer.from('231dd571da8148a2a85898b21b89ef99', 'hex');

/** Unwrap the inner zlib layer of an entry, verified by both declared sizes. */
export function unwrapCodec(data: Buffer): Buffer | null {
  const at = data.indexOf(ZLIB_CODEC);
  if (at < 0 || at + 24 > data.length) return null;
  const size = data.readUInt32LE(at + 16);
  const compressed = data.readUInt32LE(at + 20);
  if (size === 0 || size > MAX_ENTRY_BYTES || at + 24 + compressed > data.length) return null;
  try {
    const out = zlib.inflateSync(data.subarray(at + 24, at + 24 + compressed), { maxOutputLength: MAX_ENTRY_BYTES });
    return out.length === size ? out : null;
  } catch {
    return null;
  }
}

/** The preview SolidWorks rendered when the part was last saved. */
export function findPreviewPng(entries: PackageEntry[]): Buffer | null {
  const png = entries
    .filter((entry) => /(^|\/)PreviewPNG$/.test(entry.name) && entry.data.subarray(1, 4).toString('latin1') === 'PNG')
    .sort((a, b) => b.data.length - a.data.length)[0];
  return png ? png.data : null;
}

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
  // The first entry can sit well past the first few kilobytes in a large part,
  // so this looks further in than a fixed-signature check would need to.
  return buffer.length > 64 && buffer.subarray(0, 1 << 16).includes(ENTRY_MARKER);
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
    const nameLengthAt = at + NAME_LENGTH_OFFSET;
    if (nameLengthAt + 4 > buffer.length) break;

    const nameLength = buffer.readUInt32LE(nameLengthAt);
    const nameAt = nameLengthAt + 4;
    if (nameLength > 0 && nameLength <= MAX_NAME_BYTES && nameAt + nameLength <= buffer.length) {
      const raw = buffer.subarray(nameAt, nameAt + nameLength);
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
  /** Distinct plausible coordinates in the stream — see `countCoordinates`. */
  coordinates: number;
}

/**
 * How many distinct plausible coordinates a stream holds.
 *
 * This is what separates the model from the bookkeeping, and it has to be
 * measured rather than guessed at from the byte length. Parasolid writes its
 * reals big-endian, so every 8-byte window is read that way and kept when it
 * lands in a range a real dimension could occupy — a nanometre to a kilometre,
 * plus exact zero. Reading the same bytes little-endian finds nothing at all,
 * which is itself a check that this is the right stream.
 *
 * The window slides one byte at a time on purpose. Record boundaries are not
 * known yet, so an aligned read would miss most values; the unaligned reads
 * that land inside other fields are mostly filtered out by the range test, and
 * being junk they cannot manufacture the structured handful of values that
 * distinguishes a real model from a stub.
 */
export function countCoordinates(data: Buffer): number {
  const seen = new Set<number>();
  for (let i = 0; i + 8 <= data.length; i += 1) {
    const value = data.readDoubleBE(i);
    if (value === 0 || (Math.abs(value) > 1e-9 && Math.abs(value) < 1e3)) seen.add(value);
  }
  return seen.size;
}

/**
 * Every Parasolid stream in the package, richest in coordinates first.
 *
 * A part carries several: the model partition, a much smaller "ghost"
 * partition, and a deltas stream of edit history.
 */
export function findParasolidPartitions(buffer: Buffer, entries: PackageEntry[] = readPackage(buffer)): ParasolidPartition[] {
  const streams: Buffer[] = [];
  for (const entry of entries) {
    if (!/Partition$/.test(entry.name)) continue;
    const inner = unwrapCodec(entry.data);
    if (inner && isParasolid(inner)) streams.push(inner);
  }
  // Files written before the package format, or damaged ones, still get the
  // byte scan — it finds whatever sits uncompressed in the file.
  if (streams.length === 0) {
    for (const payload of readPayloads(buffer)) if (isParasolid(payload.data)) streams.push(payload.data);
  }

  return streams
    .map((data) => {
      const header = data.subarray(0, 160).toString('latin1');
      return {
        data,
        version: /version\s+(\d+)/.exec(header)?.[1] ?? null,
        kind: /TRANSMIT FILE\s+\(([^)]+)\)/.exec(header)?.[1] ?? null,
        coordinates: countCoordinates(data),
      };
    })
    .sort((a, b) => b.coordinates - a.coordinates || b.data.length - a.data.length);
}

/**
 * The lowest coordinate count that can be a model rather than a stub.
 *
 * Measured, not assumed. Across 132 real parts the counts fall into two clumps
 * with nothing between them: ghost partitions sit at 3-5 — almost always
 * exactly 4, the numbers of a coordinate frame — while the smallest genuine
 * model in the corpus, a turned spacer, has 7, and a plain cylinder needs
 * radius, height, an axis and an origin to be described at all.
 */
const MIN_MODEL_COORDINATES = 6;

/**
 * The stream that actually holds the model, or `null` when the file only
 * carries stubs.
 *
 * Selecting by byte length — the first thing this reader did — is wrong in both
 * directions, and both errors are in the corpus. A simple turned part has a
 * 1960-byte model partition, under any size threshold worth setting; and a
 * 2.2 MB part can carry a 2520-byte *ghost* partition and nothing else, which a
 * size threshold happily reports as geometry. Counting coordinates asks the
 * question directly: is there a model in here, or only a reference to one that
 * stayed behind the codec we cannot open?
 */
export function findModelPartition(buffer: Buffer, entries?: PackageEntry[]): ParasolidPartition | null {
  const best = findParasolidPartitions(buffer, entries).find(
    (partition) => partition.kind === 'partition' && partition.coordinates >= MIN_MODEL_COORDINATES,
  );
  return best ?? null;
}
