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

/**
 * Marks the start of an entry record.
 *
 * Only the first six bytes are constant. The four that follow vary with the
 * writing version — `09 b7 ad 1a` on one generation, `19 b7 7d 1a` on another —
 * so matching all ten silently skipped every newer file, and the reader then
 * reported them as "not a SolidWorks package" while quietly holding their
 * geometry.
 */
const ENTRY_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);

/** Bytes between the marker's start and the name-length field. */
const NAME_LENGTH_OFFSET = 22;

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
export function findParasolidPartitions(buffer: Buffer): ParasolidPartition[] {
  return readPayloads(buffer)
    .filter((payload) => isParasolid(payload.data))
    .map((payload) => {
      const header = payload.data.subarray(0, 160).toString('latin1');
      return {
        data: payload.data,
        version: /version\s+(\d+)/.exec(header)?.[1] ?? null,
        kind: /TRANSMIT FILE\s+\(([^)]+)\)/.exec(header)?.[1] ?? null,
        coordinates: countCoordinates(payload.data),
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
export function findModelPartition(buffer: Buffer): ParasolidPartition | null {
  const best = findParasolidPartitions(buffer).find(
    (partition) => partition.kind === 'partition' && partition.coordinates >= MIN_MODEL_COORDINATES,
  );
  return best ?? null;
}
