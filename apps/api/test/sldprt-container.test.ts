import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';
import {
  findParasolidPartitions,
  isParasolid,
  isSolidWorksPackage,
  listEntries,
  readPayloads,
  unswapNibbles,
} from '../src/processing/sldprt/container.js';

/**
 * These run against real SolidWorks files in `samples/`, which are the user's
 * own parts and are deliberately not committed. When the folder is empty the
 * suite skips rather than failing, so a clean checkout still passes — but the
 * skip is loud, because a green run that checked nothing is worse than a red
 * one.
 */

const samples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../samples');

let available: string[] = [];

before(async () => {
  try {
    available = (await fs.readdir(samples)).filter((name) => name.toLowerCase().endsWith('.sldprt'));
  } catch {
    available = [];
  }
});

async function load(name: string): Promise<Buffer> {
  return fs.readFile(path.join(samples, name));
}

describe('SolidWorks package container', () => {
  it('undoes the nibble swap that hides entry names', () => {
    // `Contents/` exactly as it appears in a real file.
    const stored = Buffer.from([0x34, 0xf6, 0xe6, 0x47, 0x56, 0xe6, 0x47, 0x37, 0xf2]);
    assert.equal(unswapNibbles(stored).toString('latin1'), 'Contents/');
    // The transform is its own inverse.
    assert.deepEqual(unswapNibbles(unswapNibbles(stored)), stored);
  });

  it('recognises a modern part as a package rather than a compound file', async (t) => {
    if (available.length === 0) return t.skip('no files in samples/ — see samples/README.md');
    const buffer = await load(available[0]);
    assert.equal(isSolidWorksPackage(buffer), true);
    // The old assumption, stated so its failure stays visible: these are NOT
    // OLE compound files, which is why the compound-file reader found nothing.
    assert.notDeepEqual(buffer.subarray(0, 8), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  });

  it('lists the package parts an OPC-shaped container should have', async (t) => {
    if (available.length === 0) return t.skip('no files in samples/');
    const names = listEntries(await load(available[0])).map((entry) => entry.name);
    for (const expected of ['Contents/Config-0-Partition', 'docProps/core.xml', '_rels/.rels']) {
      assert.ok(
        names.some((name) => name.includes(expected)),
        `expected an entry containing ${expected}, got ${names.slice(0, 12).join(', ')}`,
      );
    }
  });

  it('extracts geometry from most of the corpus, and reports the rest honestly', async (t) => {
    if (available.length === 0) return t.skip('no files in samples/');

    const opaque: string[] = [];
    let reached = 0;
    for (const name of available) {
      const partitions = findParasolidPartitions(await load(name));
      // Above 2 KB is a model partition; the small ones are bookkeeping.
      if (partitions.some((partition) => partition.data.length > 2048)) reached += 1;
      else opaque.push(name);
    }

    const share = reached / available.length;
    console.log(`      geometry reached in ${reached}/${available.length} files (${(share * 100).toFixed(0)}%)`);

    // Not every file yields: some SolidWorks packages keep every payload behind
    // a codec we cannot open. That is a real limit, so the test tracks the
    // proportion rather than pretending the failures do not exist.
    //
    // The floor is the measured baseline (79/137 parts, 58%), minus a little
    // room. It exists to catch a regression, not to certify a target: raise it
    // when the reader genuinely improves.
    assert.ok(
      share >= 0.55,
      `geometry reached in only ${reached}/${available.length} files, below the 55% baseline; opaque: ${opaque.slice(0, 5).join(', ')}`,
    );
  });

  it('accepts a payload only when it verifies against its own declared sizes', async (t) => {
    if (available.length === 0) return t.skip('no files in samples/');
    const buffer = await load(available[0]);
    const payloads = readPayloads(buffer);
    assert.ok(payloads.length > 0, 'expected at least one verified payload');
    for (const payload of payloads) {
      assert.equal(buffer.readUInt32LE(payload.offset - 8), payload.data.length);
      assert.equal(buffer.readUInt32LE(payload.offset - 4), payload.compressedBytes);
    }
  });

  it('does not mistake arbitrary data for a Parasolid stream', () => {
    assert.equal(isParasolid(Buffer.alloc(256, 0x50)), false);
    assert.equal(isParasolid(Buffer.from('PS but nothing else at all'.repeat(4))), false);
  });
});

/**
 * The controlled pairs are the proof that the extracted bytes really are the
 * model. If a 10 mm cube becomes 20 mm, the coordinate has to move with it.
 */
describe('geometry in the Parasolid partition', () => {
  /** Parasolid stores its reals big-endian; little-endian finds nothing. */
  function containsBigEndianDouble(data: Buffer, value: number): boolean {
    const needle = Buffer.allocUnsafe(8);
    needle.writeDoubleBE(value);
    return data.includes(needle);
  }

  async function partition(name: string): Promise<Buffer | null> {
    if (!available.includes(name)) return null;
    const found = findParasolidPartitions(await load(name));
    return found[0]?.data ?? null;
  }

  it('holds the cube edge, and it doubles when the model does', async (t) => {
    const small = await partition('cube-10.SLDPRT');
    const large = await partition('cube-20.SLDPRT');
    if (!small || !large) return t.skip('cube-10 / cube-20 not in samples/');

    // Metres: SolidWorks works in SI internally. The cube is modelled about its
    // own centre on two axes and from zero on the third, so a 10 mm cube stores
    // 0.01 and ±0.005 — not 0.01 on every axis.
    assert.ok(containsBigEndianDouble(small, 0.01), '10 mm cube should store 0.01');
    assert.ok(containsBigEndianDouble(small, 0.005), '10 mm cube should store 0.005');
    assert.ok(containsBigEndianDouble(small, -0.005), '10 mm cube should store -0.005');

    assert.ok(containsBigEndianDouble(large, 0.02), '20 mm cube should store 0.02');
    assert.ok(containsBigEndianDouble(large, -0.01), '20 mm cube should store -0.01');

    // Each value must be absent from the other part, or the matches above would
    // prove nothing: it is the *exchange* of values that identifies them as the
    // edge length rather than as constants that happen to be lying around.
    assert.ok(!containsBigEndianDouble(small, 0.02), '10 mm cube must not contain 0.02');
    assert.ok(!containsBigEndianDouble(large, 0.005), '20 mm cube must not contain 0.005');
  });

  it('holds a cylinder radius and height', async (t) => {
    const data = await partition('cylinder-d50-h100.SLDPRT');
    if (!data) return t.skip('cylinder-d50-h100 not in samples/');
    assert.ok(containsBigEndianDouble(data, 0.025), 'diameter 50 mm should store radius 0.025');
    assert.ok(containsBigEndianDouble(data, 0.1), 'height 100 mm should store 0.1');
  });
});
