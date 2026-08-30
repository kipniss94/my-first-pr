/**
 * Pull the picture a CAD system already drew out of its own file.
 *
 * Every mainstream CAD format stores a rendered preview of the document so that
 * file browsers can show a thumbnail. That preview is an ordinary PNG, JPEG or
 * Windows DIB sitting inside the container, which means a proprietary file can
 * be *opened and looked at* without a licensed kernel — the honest limit being
 * that a picture is not geometry, so nothing can be measured on it.
 *
 * The scanners below validate structure rather than trusting a magic number, so
 * a stray `BM` in the middle of a binary blob is not mistaken for a bitmap.
 */

export type EmbeddedImageType = 'png' | 'jpeg' | 'bmp';

export interface EmbeddedImage {
  data: Buffer;
  type: EmbeddedImageType;
  extension: string;
  contentType: string;
  width: number;
  height: number;
  /** Where it came from, for the processing log only. */
  origin: string;
}

const CONTENT_TYPES: Record<EmbeddedImageType, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  bmp: 'image/bmp',
};

const EXTENSIONS: Record<EmbeddedImageType, string> = { png: 'png', jpeg: 'jpg', bmp: 'bmp' };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const BMP_SIGNATURE = Buffer.from([0x42, 0x4d]);

/** Anything past this is a rendering, not a thumbnail — and probably a mis-parse. */
const MAX_DIMENSION = 20000;
/** Ignore icon-sized artwork: it is decoration, not a document preview. */
const MIN_DIMENSION = 24;
/** Cap the number of candidates so a pathological file cannot stall the worker. */
const MAX_CANDIDATES = 64;
/** How far into a blob the header-less DIB probe looks. */
const DIB_PROBE_BYTES = 4 * 1024 * 1024;

function make(type: EmbeddedImageType, data: Buffer, width: number, height: number, origin: string): EmbeddedImage {
  return { data, type, extension: EXTENSIONS[type], contentType: CONTENT_TYPES[type], width, height, origin };
}

/* ---------------------------------- PNG ----------------------------------- */

function readPng(buffer: Buffer, start: number, origin: string): EmbeddedImage | null {
  if (start + 8 + 25 > buffer.length) return null;
  // The first chunk of a valid PNG is always a 13-byte IHDR.
  if (buffer.readUInt32BE(start + 8) !== 13) return null;
  if (buffer.subarray(start + 12, start + 16).toString('latin1') !== 'IHDR') return null;

  const width = buffer.readUInt32BE(start + 16);
  const height = buffer.readUInt32BE(start + 20);
  if (width === 0 || height === 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) return null;

  let cursor = start + 8;
  for (let chunk = 0; chunk < 4096; chunk += 1) {
    if (cursor + 8 > buffer.length) return null;
    const length = buffer.readUInt32BE(cursor);
    const type = buffer.subarray(cursor + 4, cursor + 8).toString('latin1');
    const next = cursor + 12 + length;
    if (length > buffer.length || next > buffer.length) return null;
    if (type === 'IEND') return make('png', buffer.subarray(start, next), width, height, origin);
    cursor = next;
  }
  return null;
}

/* ---------------------------------- JPEG ---------------------------------- */

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function readJpeg(buffer: Buffer, start: number, origin: string): EmbeddedImage | null {
  let cursor = start + 2;
  let width = 0;
  let height = 0;

  for (let segment = 0; segment < 8192; segment += 1) {
    if (cursor + 2 > buffer.length) return null;
    if (buffer[cursor] !== 0xff) return null;

    // Fill bytes are legal between segments.
    while (cursor + 1 < buffer.length && buffer[cursor + 1] === 0xff) cursor += 1;
    const marker = buffer[cursor + 1];
    cursor += 2;

    if (marker === 0xd9) {
      if (width < MIN_DIMENSION || height < MIN_DIMENSION) return null;
      return make('jpeg', buffer.subarray(start, cursor), width, height, origin);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    if (cursor + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(cursor);
    if (length < 2 || cursor + length > buffer.length) return null;

    if (SOF_MARKERS.has(marker)) {
      height = buffer.readUInt16BE(cursor + 3);
      width = buffer.readUInt16BE(cursor + 5);
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
    }

    cursor += length;

    if (marker === 0xda) {
      // Entropy-coded data: skip to the next real marker, stepping over stuffed
      // 0xFF00 bytes and restart markers, which are part of the scan.
      while (cursor + 1 < buffer.length) {
        if (buffer[cursor] === 0xff) {
          const next = buffer[cursor + 1];
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) break;
        }
        cursor += 1;
      }
    }
  }
  return null;
}

/* ------------------------------ BMP and DIB ------------------------------- */

const DIB_HEADER_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);
const BIT_COUNTS = new Set([1, 4, 8, 16, 24, 32]);

/** Bytes a DIB occupies, or 0 when the header does not describe a real bitmap. */
function dibLength(buffer: Buffer, start: number): { bytes: number; width: number; height: number; pixels: number } | null {
  if (start + 40 > buffer.length) return null;
  const headerSize = buffer.readUInt32LE(start);
  if (!DIB_HEADER_SIZES.has(headerSize) || headerSize < 40) return null;

  const width = buffer.readInt32LE(start + 4);
  const height = Math.abs(buffer.readInt32LE(start + 8));
  const planes = buffer.readUInt16LE(start + 12);
  const bitCount = buffer.readUInt16LE(start + 14);
  const compression = buffer.readUInt32LE(start + 16);

  if (planes !== 1 || !BIT_COUNTS.has(bitCount)) return null;
  if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
  // Only uncompressed and bitfield DIBs; anything else would need a decoder.
  if (compression !== 0 && compression !== 3) return null;

  let paletteEntries = buffer.readUInt32LE(start + 32);
  if (bitCount <= 8 && paletteEntries === 0) paletteEntries = 1 << bitCount;
  if (bitCount > 8) paletteEntries = Math.min(paletteEntries, 256);

  const masks = compression === 3 && headerSize === 40 ? 12 : 0;
  const rowSize = Math.floor((width * bitCount + 31) / 32) * 4;
  const pixels = rowSize * height;
  const offset = headerSize + paletteEntries * 4 + masks;
  const bytes = offset + pixels;

  if (start + bytes > buffer.length) return null;
  return { bytes, width, height, pixels: offset };
}

function readBmp(buffer: Buffer, start: number, origin: string): EmbeddedImage | null {
  if (start + 26 > buffer.length) return null;
  const fileSize = buffer.readUInt32LE(start + 2);
  const reserved = buffer.readUInt32LE(start + 6);
  const dataOffset = buffer.readUInt32LE(start + 10);
  if (reserved !== 0) return null;
  if (fileSize < 26 || start + fileSize > buffer.length) return null;
  if (dataOffset < 26 || dataOffset >= fileSize) return null;

  const dib = dibLength(buffer, start + 14);
  if (!dib) return null;
  return make('bmp', buffer.subarray(start, start + fileSize), dib.width, dib.height, origin);
}

/**
 * A bare device-independent bitmap, the shape Windows clipboard thumbnails take
 * inside `\x05SummaryInformation`. It has no `BM` file header, so we build one.
 */
function readDib(buffer: Buffer, start: number, origin: string): EmbeddedImage | null {
  const dib = dibLength(buffer, start);
  if (!dib) return null;
  if (dib.width < MIN_DIMENSION || dib.height < MIN_DIMENSION) return null;

  const header = Buffer.alloc(14);
  header.write('BM', 0, 'latin1');
  header.writeUInt32LE(14 + dib.bytes, 2);
  header.writeUInt32LE(0, 6);
  header.writeUInt32LE(14 + dib.pixels, 10);
  const data = Buffer.concat([header, buffer.subarray(start, start + dib.bytes)]);
  return make('bmp', data, dib.width, dib.height, origin);
}

/* --------------------------------- scanning -------------------------------- */

/**
 * Collect every self-consistent image embedded in a blob.
 *
 * Signatures are located with `indexOf` (a memchr-backed search) and only then
 * validated, so scanning a 100 MB part file costs a single linear pass per
 * format rather than a byte-by-byte parse.
 */
export function findEmbeddedImages(buffer: Buffer, origin = 'file'): EmbeddedImage[] {
  const found: EmbeddedImage[] = [];

  const sweep = (
    signature: Buffer,
    reader: (buffer: Buffer, start: number, origin: string) => EmbeddedImage | null,
  ): void => {
    let from = 0;
    while (found.length < MAX_CANDIDATES) {
      const at = buffer.indexOf(signature, from);
      if (at < 0) break;
      const image = reader(buffer, at, origin);
      if (image && image.width >= MIN_DIMENSION && image.height >= MIN_DIMENSION) {
        found.push(image);
        from = at + image.data.byteLength;
      } else {
        from = at + 1;
      }
    }
  };

  sweep(PNG_SIGNATURE, readPng);
  sweep(JPEG_SIGNATURE, readJpeg);
  sweep(BMP_SIGNATURE, readBmp);

  // Bare DIBs have no signature to search for, so probe the alignment-friendly
  // offsets where a clipboard blob normally starts. Property streams put the
  // thumbnail near their front, so a bounded probe is enough and keeps the cost
  // of this fallback off a large part file.
  if (found.length === 0) {
    const limit = Math.min(buffer.length, DIB_PROBE_BYTES);
    for (let at = 0; at + 40 <= limit; at += 4) {
      const image = readDib(buffer, at, `${origin} (DIB)`);
      if (image) {
        found.push(image);
        break;
      }
    }
  }

  return found;
}

/** The most useful preview in a set: biggest picture, then biggest file. */
export function bestImage(images: EmbeddedImage[]): EmbeddedImage | null {
  let best: EmbeddedImage | null = null;
  for (const image of images) {
    if (!best) {
      best = image;
      continue;
    }
    const area = image.width * image.height;
    const bestArea = best.width * best.height;
    if (area > bestArea || (area === bestArea && image.data.byteLength > best.data.byteLength)) best = image;
  }
  return best;
}
