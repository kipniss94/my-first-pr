/**
 * Builders for the containers the native-CAD reader has to cope with.
 *
 * A synthetic compound file is the only way to exercise that reader here: real
 * SolidWorks and Inventor documents cannot be redistributed, so both the unit
 * tests and the generated fixtures are written by hand against the published
 * compound file and property set layouts.
 *
 * Plain JavaScript, like the other fixture builders in this folder, so the
 * fixture script and the API tests can share exactly one implementation.
 */

import zlib from 'node:zlib';

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const FATSECT = 0xfffffffd;

const SECTOR_SIZE = 512;
const MINI_SECTOR_SIZE = 64;
const MINI_CUTOFF = 4096;

/**
 * Write a version-3 compound file containing the given streams, all directly
 * under the root storage. Small streams land in the mini stream, larger ones in
 * ordinary sectors, so both read paths get exercised.
 */
export function buildCompoundFile(streams) {
  const mini = streams.filter((s) => s.data.length > 0 && s.data.length < MINI_CUTOFF);
  const regular = streams.filter((s) => !mini.includes(s));

  /* ---- mini stream: every entry padded to a whole mini sector ------------ */
  const miniChunks = [];
  const miniStart = new Map();
  const miniSectorsFor = new Map();
  let miniSector = 0;
  for (const stream of mini) {
    const sectors = Math.ceil(stream.data.length / MINI_SECTOR_SIZE);
    miniStart.set(stream.name, miniSector);
    miniSectorsFor.set(stream.name, sectors);
    const padded = Buffer.alloc(sectors * MINI_SECTOR_SIZE);
    stream.data.copy(padded);
    miniChunks.push(padded);
    miniSector += sectors;
  }
  const miniStream = Buffer.concat(miniChunks);

  /* ---- sector layout ----------------------------------------------------- */
  // 0: FAT, 1: directory, 2: mini FAT, 3+: mini stream, then regular streams.
  const miniStreamSectors = Math.ceil(miniStream.length / SECTOR_SIZE);
  const directorySectors = Math.ceil((streams.length + 1) / 4) || 1;

  let next = 1;
  const directoryStart = next;
  next += directorySectors;
  const miniFatStart = next;
  next += 1;
  const miniStreamStart = miniStreamSectors > 0 ? next : ENDOFCHAIN;
  next += miniStreamSectors;

  const regularStart = new Map();
  const regularSectors = new Map();
  for (const stream of regular) {
    const sectors = Math.max(1, Math.ceil(stream.data.length / SECTOR_SIZE));
    regularStart.set(stream.name, next);
    regularSectors.set(stream.name, sectors);
    next += sectors;
  }
  const totalSectors = next;

  /* ---- the FAT ----------------------------------------------------------- */
  const fat = new Array(SECTOR_SIZE / 4).fill(FREESECT);
  fat[0] = FATSECT;
  const link = (start, count) => {
    for (let i = 0; i < count; i += 1) fat[start + i] = i === count - 1 ? ENDOFCHAIN : start + i + 1;
  };
  link(directoryStart, directorySectors);
  fat[miniFatStart] = ENDOFCHAIN;
  if (miniStreamSectors > 0) link(miniStreamStart, miniStreamSectors);
  for (const stream of regular) link(regularStart.get(stream.name), regularSectors.get(stream.name));

  /* ---- the mini FAT ------------------------------------------------------ */
  const miniFat = new Array(SECTOR_SIZE / 4).fill(FREESECT);
  for (const stream of mini) {
    const start = miniStart.get(stream.name);
    const count = miniSectorsFor.get(stream.name);
    for (let i = 0; i < count; i += 1) miniFat[start + i] = i === count - 1 ? ENDOFCHAIN : start + i + 1;
  }

  /* ---- the directory ----------------------------------------------------- */
  const directory = Buffer.alloc(directorySectors * SECTOR_SIZE);
  const writeEntry = (index, name, type, startSector, size, child, right) => {
    const base = index * 128;
    // Names are UTF-16 and NUL-terminated; the length counts the terminator.
    const encoded = Buffer.concat([Buffer.from(name, 'utf16le'), Buffer.alloc(2)]);
    encoded.copy(directory, base, 0, Math.min(encoded.length, 64));
    directory.writeUInt16LE(Math.min(encoded.length, 64), base + 64);
    directory.writeUInt8(type, base + 66);
    directory.writeUInt8(1, base + 67); // black
    directory.writeUInt32LE(FREESECT, base + 68); // left sibling
    directory.writeUInt32LE(right, base + 72);
    directory.writeUInt32LE(child, base + 76);
    directory.writeUInt32LE(startSector, base + 116);
    directory.writeUInt32LE(size, base + 120);
    directory.writeUInt32LE(0, base + 124);
  };

  // Unused slots must read as unallocated.
  for (let i = streams.length + 1; i < directorySectors * 4; i += 1) {
    directory.writeUInt32LE(FREESECT, i * 128 + 68);
    directory.writeUInt32LE(FREESECT, i * 128 + 72);
    directory.writeUInt32LE(FREESECT, i * 128 + 76);
  }

  writeEntry(0, 'Root Entry', 5, miniStreamStart, miniStream.length, streams.length > 0 ? 1 : FREESECT, FREESECT);
  streams.forEach((stream, index) => {
    const slot = index + 1;
    const isMini = mini.includes(stream);
    const start = isMini ? miniStart.get(stream.name) : regularStart.get(stream.name) ?? ENDOFCHAIN;
    // Chain the children as right siblings: a degenerate but legal tree.
    const right = slot < streams.length ? slot + 1 : FREESECT;
    writeEntry(slot, stream.name, 2, stream.data.length > 0 ? start : ENDOFCHAIN, stream.data.length, FREESECT, right);
  });

  /* ---- assemble ---------------------------------------------------------- */
  const header = Buffer.alloc(SECTOR_SIZE);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x003e, 24);
  header.writeUInt16LE(3, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(0, 40); // directory sector count is 0 for v3
  header.writeUInt32LE(1, 44); // one FAT sector
  header.writeUInt32LE(directoryStart, 48);
  header.writeUInt32LE(MINI_CUTOFF, 56);
  header.writeUInt32LE(miniFatStart, 60);
  header.writeUInt32LE(1, 64);
  header.writeUInt32LE(ENDOFCHAIN, 68);
  header.writeUInt32LE(0, 72);
  header.writeUInt32LE(0, 76); // DIFAT[0] -> FAT sector 0
  for (let i = 1; i < 109; i += 1) header.writeUInt32LE(FREESECT, 76 + i * 4);

  const body = Buffer.alloc(totalSectors * SECTOR_SIZE);
  const writeSector = (sector, data) => {
    data.copy(body, sector * SECTOR_SIZE, 0, Math.min(data.length, (totalSectors - sector) * SECTOR_SIZE));
  };

  const fatSector = Buffer.alloc(SECTOR_SIZE);
  fat.forEach((value, index) => fatSector.writeUInt32LE(value >>> 0, index * 4));
  writeSector(0, fatSector);

  writeSector(directoryStart, directory);

  const miniFatSector = Buffer.alloc(SECTOR_SIZE);
  miniFat.forEach((value, index) => miniFatSector.writeUInt32LE(value >>> 0, index * 4));
  writeSector(miniFatStart, miniFatSector);

  if (miniStreamSectors > 0) writeSector(miniStreamStart, miniStream);
  for (const stream of regular) writeSector(regularStart.get(stream.name), stream.data);

  return Buffer.concat([header, body]);
}

/* ------------------------------ property sets ------------------------------ */

/** A `SummaryInformation` stream holding the given properties. */
export function buildSummaryInformation(properties) {
  const fmtid = Buffer.from('e0859ff2f94f6810ab9108002b27b3d9', 'hex');

  const values = [];
  const ids = [];

  // The code page always comes first so string properties decode correctly.
  ids.push(1);
  const codepage = Buffer.alloc(8);
  codepage.writeUInt32LE(0x02, 0);
  codepage.writeInt16LE(1252, 4);
  values.push(codepage);

  for (const property of properties) {
    ids.push(property.id);
    if (typeof property.value === 'string') {
      const text = Buffer.concat([Buffer.from(property.value, 'latin1'), Buffer.alloc(1)]);
      const padded = Buffer.alloc(8 + Math.ceil(text.length / 4) * 4);
      padded.writeUInt32LE(0x1e, 0);
      padded.writeUInt32LE(text.length, 4);
      text.copy(padded, 8);
      values.push(padded);
    } else {
      // VT_CF: size, clipboard format tag, then the payload.
      const payload = property.value;
      const body = Buffer.alloc(8 + 4 + Math.ceil(payload.length / 4) * 4);
      body.writeUInt32LE(0x47, 0);
      body.writeUInt32LE(4 + payload.length, 4);
      body.writeUInt32LE(8, 8); // CF_DIB
      payload.copy(body, 12);
      values.push(body);
    }
  }

  const headerBytes = 8 + ids.length * 8;
  const offsets = [];
  let cursor = headerBytes;
  for (const value of values) {
    offsets.push(cursor);
    cursor += value.length;
  }

  const section = Buffer.alloc(cursor);
  section.writeUInt32LE(cursor, 0);
  section.writeUInt32LE(ids.length, 4);
  ids.forEach((id, index) => {
    section.writeUInt32LE(id, 8 + index * 8);
    section.writeUInt32LE(offsets[index], 12 + index * 8);
  });
  values.forEach((value, index) => value.copy(section, offsets[index]));

  const head = Buffer.alloc(48);
  head.writeUInt16LE(0xfffe, 0);
  head.writeUInt16LE(0, 2);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(1, 24);
  fmtid.copy(head, 28);
  head.writeUInt32LE(48, 44);

  return Buffer.concat([head, section]);
}

/* --------------------------------- images ---------------------------------- */

/** A bare BITMAPINFOHEADER bitmap, the shape a clipboard thumbnail takes. */
export function buildDib(width, height) {
  const rowSize = Math.floor((width * 24 + 31) / 32) * 4;
  const pixels = rowSize * height;
  const dib = Buffer.alloc(40 + pixels);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(width, 4);
  dib.writeInt32LE(height, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(24, 14);
  dib.writeUInt32LE(0, 16);
  dib.writeUInt32LE(pixels, 20);
  dib.fill(0x80, 40);
  return dib;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real, decodable greyscale PNG — structure and CRCs included. */
export function buildPng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(0, 9); // greyscale
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0; // filter: none
    raw.fill(((y * 255) / height) & 0xff, y * (width + 1) + 1, (y + 1) * (width + 1));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
