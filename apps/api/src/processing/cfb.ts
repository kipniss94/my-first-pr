/**
 * Minimal reader for Compound File Binary containers (OLE2 / "structured
 * storage"), the wrapper SolidWorks, Inventor and Revit put their documents in.
 *
 * We only need to enumerate streams and pull a few of them out, so this is a
 * deliberately small reader rather than a dependency: it walks the FAT, the
 * mini FAT and the directory tree, and refuses anything that looks malformed.
 *
 * Everything here parses *data*, never executes it. Every chain walk is bounded
 * so a hostile or truncated file cannot spin the processing worker.
 */

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

/** Sanity ceilings. A real document is nowhere near any of these. */
const MAX_DIRECTORY_ENTRIES = 20000;
const MAX_CHAIN_SECTORS = 1 << 22;

export interface CfbEntry {
  /** Stream or storage name, already decoded from UTF-16LE. */
  name: string;
  /** Full path from the root, `/` separated, e.g. `Preview/PreviewPNG`. */
  path: string;
  /** 1 = storage (directory), 2 = stream, 5 = root storage. */
  type: number;
  size: number;
  startSector: number;
}

export interface CfbFile {
  entries: CfbEntry[];
  /** Read a stream's bytes. Returns an empty buffer for storages. */
  read(entry: CfbEntry): Buffer;
}

export function isCompoundFile(head: Buffer): boolean {
  if (head.length < SIGNATURE.length) return false;
  return SIGNATURE.every((byte, index) => head[index] === byte);
}

/**
 * Parse a compound file held entirely in memory.
 *
 * Returns `null` rather than throwing when the container is not a CFB or is
 * damaged beyond use — callers fall back to a raw byte scan, which still finds
 * an embedded preview in most damaged files.
 */
export function readCompoundFile(buffer: Buffer): CfbFile | null {
  if (!isCompoundFile(buffer) || buffer.length < 512) return null;

  const sectorShift = buffer.readUInt16LE(30);
  const miniSectorShift = buffer.readUInt16LE(32);
  if (sectorShift !== 9 && sectorShift !== 12) return null;
  if (miniSectorShift !== 6) return null;

  const sectorSize = 1 << sectorShift;
  const miniSectorSize = 1 << miniSectorShift;
  const miniCutoff = buffer.readUInt32LE(56);

  const sectorOffset = (sector: number): number => (sector + 1) * sectorSize;
  const sectorCount = Math.max(0, Math.floor(buffer.length / sectorSize) - 1);

  const readSector = (sector: number): Buffer | null => {
    if (sector < 0 || sector >= sectorCount) return null;
    const start = sectorOffset(sector);
    if (start + sectorSize > buffer.length) return null;
    return buffer.subarray(start, start + sectorSize);
  };

  /* ------------------------------- the FAT -------------------------------- */

  // The DIFAT lists the sectors that hold the FAT. Its first 109 entries live in
  // the header; the rest form their own chain.
  const difat: number[] = [];
  for (let i = 0; i < 109; i += 1) {
    const sector = buffer.readUInt32LE(76 + i * 4);
    if (sector === FREESECT || sector === ENDOFCHAIN) break;
    difat.push(sector);
  }

  let difatSector = buffer.readUInt32LE(68);
  const difatSectorCount = buffer.readUInt32LE(72);
  const entriesPerDifat = sectorSize / 4 - 1;
  for (let i = 0; i < difatSectorCount && difatSector !== ENDOFCHAIN && difatSector !== FREESECT; i += 1) {
    const sector = readSector(difatSector);
    if (!sector) break;
    for (let slot = 0; slot < entriesPerDifat; slot += 1) {
      const value = sector.readUInt32LE(slot * 4);
      if (value === FREESECT || value === ENDOFCHAIN) continue;
      difat.push(value);
    }
    difatSector = sector.readUInt32LE(entriesPerDifat * 4);
  }

  const fat: number[] = [];
  for (const sector of difat) {
    const data = readSector(sector);
    if (!data) continue;
    for (let slot = 0; slot < sectorSize / 4; slot += 1) fat.push(data.readUInt32LE(slot * 4));
  }
  if (fat.length === 0) return null;

  /** Follow a sector chain, guarding against loops and runaway lengths. */
  const chain = (start: number, table: number[]): number[] => {
    const sectors: number[] = [];
    const seen = new Set<number>();
    let current = start;
    while (current !== ENDOFCHAIN && current !== FREESECT && sectors.length < MAX_CHAIN_SECTORS) {
      if (current < 0 || current >= table.length || seen.has(current)) break;
      seen.add(current);
      sectors.push(current);
      current = table[current];
    }
    return sectors;
  };

  const readChain = (start: number, size: number): Buffer => {
    const sectors = chain(start, fat);
    const parts: Buffer[] = [];
    let remaining = size;
    for (const sector of sectors) {
      if (remaining <= 0) break;
      const data = readSector(sector);
      if (!data) break;
      const take = Math.min(remaining, sectorSize);
      parts.push(data.subarray(0, take));
      remaining -= take;
    }
    return Buffer.concat(parts);
  };

  /* ---------------------------- the directory ----------------------------- */

  const directoryBytes = readChain(buffer.readUInt32LE(48), MAX_DIRECTORY_ENTRIES * 128);
  const entryCount = Math.min(Math.floor(directoryBytes.length / 128), MAX_DIRECTORY_ENTRIES);
  if (entryCount === 0) return null;

  interface RawEntry extends CfbEntry {
    left: number;
    right: number;
    child: number;
  }

  const raw: RawEntry[] = [];
  for (let i = 0; i < entryCount; i += 1) {
    const base = i * 128;
    const nameLength = directoryBytes.readUInt16LE(base + 64);
    const nameBytes = Math.max(0, Math.min(64, nameLength) - 2);
    const name = directoryBytes.subarray(base, base + nameBytes).toString('utf16le');
    const high = directoryBytes.readUInt32LE(base + 124);
    const low = directoryBytes.readUInt32LE(base + 120);
    // v3 leaves the high half undefined; clamp instead of trusting it.
    const size = sectorShift === 9 ? low : high * 0x100000000 + low;
    raw.push({
      name,
      path: name,
      type: directoryBytes.readUInt8(base + 66),
      size: Math.min(size, buffer.length),
      startSector: directoryBytes.readUInt32LE(base + 116),
      left: directoryBytes.readUInt32LE(base + 68),
      right: directoryBytes.readUInt32LE(base + 72),
      child: directoryBytes.readUInt32LE(base + 76),
    });
  }

  const root = raw[0];
  if (!root || root.type !== 5) return null;

  /* ------------------------- the mini stream ------------------------------ */

  const miniFatBytes = readChain(buffer.readUInt32LE(60), buffer.readUInt32LE(64) * sectorSize);
  const miniFat: number[] = [];
  for (let slot = 0; slot + 4 <= miniFatBytes.length; slot += 4) miniFat.push(miniFatBytes.readUInt32LE(slot));
  const miniStream = readChain(root.startSector, root.size);

  const readMini = (start: number, size: number): Buffer => {
    const sectors = chain(start, miniFat);
    const parts: Buffer[] = [];
    let remaining = size;
    for (const sector of sectors) {
      if (remaining <= 0) break;
      const offset = sector * miniSectorSize;
      if (offset >= miniStream.length) break;
      const take = Math.min(remaining, miniSectorSize, miniStream.length - offset);
      parts.push(miniStream.subarray(offset, offset + take));
      remaining -= take;
    }
    return Buffer.concat(parts);
  };

  /* ----------------------- walk the red-black tree ------------------------ */

  const entries: CfbEntry[] = [];
  const visited = new Set<number>();

  const walkSiblings = (index: number, prefix: string): void => {
    // The directory is a red-black tree per storage; an iterative stack keeps a
    // deep or corrupted tree from blowing the call stack.
    const stack = [index];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined || current === FREESECT || current >= raw.length || visited.has(current)) continue;
      visited.add(current);
      const entry = raw[current];
      if (entry.type !== 1 && entry.type !== 2) continue;

      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      entries.push({ name: entry.name, path, type: entry.type, size: entry.size, startSector: entry.startSector });

      stack.push(entry.left, entry.right);
      if (entry.child !== FREESECT && entry.child < raw.length) walkSiblings(entry.child, path);
    }
  };

  if (root.child !== FREESECT && root.child < raw.length) walkSiblings(root.child, '');

  const read = (entry: CfbEntry): Buffer => {
    if (entry.type !== 2 || entry.size === 0) return Buffer.alloc(0);
    return entry.size < miniCutoff ? readMini(entry.startSector, entry.size) : readChain(entry.startSector, entry.size);
  };

  return { entries, read };
}
