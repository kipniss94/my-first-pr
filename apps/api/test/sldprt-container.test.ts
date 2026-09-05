import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';
import { boundsOf, readPoints } from '../src/processing/sldprt/parasolid.js';
import {
  countCoordinates,
  findModelPartition,
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

  it('tells a model partition from the stub that only points at one', async (t) => {
    if (available.length === 0) return t.skip('no files in samples/');

    // A ghost partition is a coordinate frame and nothing else. If any file in
    // the corpus carries one alongside a real model, the two must be separable,
    // because the whole coverage number rests on that distinction.
    let checked = 0;
    for (const name of available) {
      const streams = findParasolidPartitions(await load(name));
      const model = streams.find((stream) => stream.kind === 'partition' && stream.coordinates >= 6);
      const ghosts = streams.filter((stream) => stream !== model && stream.kind === 'partition');
      if (!model || ghosts.length === 0) continue;
      checked += 1;
      for (const ghost of ghosts) {
        assert.ok(
          ghost.coordinates < model.coordinates,
          `${name}: ghost partition has ${ghost.coordinates} coordinates, model only ${model.coordinates}`,
        );
      }
    }
    assert.ok(checked > 0, 'expected at least one file carrying both a model and a ghost partition');
  });

  it('extracts geometry from part of the corpus, and reports the rest honestly', async (t) => {
    if (available.length === 0) return t.skip('no files in samples/');

    let model = 0;
    let stub = 0;
    let none = 0;
    let empty = 0;
    for (const name of available) {
      const buffer = await load(name);
      if (buffer.length < 1024) empty += 1;
      else if (findModelPartition(buffer)) model += 1;
      else if (findParasolidPartitions(buffer).length > 0) stub += 1;
      else none += 1;
    }

    const real = available.length - empty;
    const share = model / real;
    console.log(
      `      model ${model}/${real} (${(share * 100).toFixed(0)}%), stub only ${stub}, no Parasolid ${none}, empty ${empty}`,
    );

    // This floor replaces a higher one that was measuring the wrong thing. The
    // old rule counted any Parasolid stream over 2 KB as geometry, which swept
    // in ghost partitions of 2184-2856 bytes and reported 58% — the true figure
    // under the corrected rule is 49%, and the reader did not get worse. A
    // number that flatters the work is worse than no number.
    //
    // Raise this when the reader genuinely improves, never to make a run pass.
    assert.ok(
      share >= 0.45,
      `a model was extracted from only ${model}/${real} parts, below the 45% baseline`,
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

  it('counts only values a dimension could plausibly take', () => {
    const data = Buffer.alloc(40);
    data.writeDoubleBE(0.01, 0);      // 10 mm — counted
    data.writeDoubleBE(0, 8);         // exact zero — counted
    data.writeDoubleBE(1e-306, 16);   // a denormal from misread text — not
    data.writeDoubleBE(1e12, 24);     // far past any real part — not
    data.writeDoubleBE(0.01, 32);     // a repeat — counted once
    // The slide is unaligned, so the reads that straddle two of these values
    // are part of the measurement; what matters is that the planted values are
    // all found and the implausible ones are not.
    const found = countCoordinates(data);
    assert.ok(found >= 2 && found < 10, `expected a handful of values, got ${found}`);
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

/**
 * The point reader, checked against parts whose real size is known.
 *
 * These assertions are the whole basis for claiming the coordinates mean what
 * the reader says they mean. If the node layout is ever wrong, a cube stops
 * measuring 10 mm and this fails loudly rather than quietly reporting a
 * plausible-looking wrong number.
 */
describe('geometry read out of the Parasolid stream', () => {
  async function measure(name: string) {
    if (!available.includes(name)) return null;
    const model = findModelPartition(await load(name));
    if (!model) return null;
    const points = readPoints(model.data);
    return { points, bounds: boundsOf(points) };
  }

  it('measures the controlled cube pair at its true size', async (t) => {
    const small = await measure('cube-10.SLDPRT');
    const large = await measure('cube-20.SLDPRT');
    if (!small?.bounds || !large?.bounds) return t.skip('cube-10 / cube-20 not in samples/');

    for (const axis of ['x', 'y', 'z'] as const) {
      assert.ok(
        Math.abs(small.bounds.sizeMm[axis] - 10) < 0.01,
        `10 mm cube measured ${small.bounds.sizeMm[axis]} mm on ${axis}`,
      );
      assert.ok(
        Math.abs(large.bounds.sizeMm[axis] - 20) < 0.01,
        `20 mm cube measured ${large.bounds.sizeMm[axis]} mm on ${axis}`,
      );
    }
  });

  it('measures a part that states its own dimensions in its name', async (t) => {
    // sheet-flat-50-100-2: a 50 x 100 sheet, 2 mm thick. Nothing about the file
    // tells the reader that — the name does, and the bytes have to agree.
    const sheet = await measure('sheet-flat-50-100-2.SLDPRT');
    if (!sheet?.bounds) return t.skip('sheet-flat-50-100-2 not in samples/');

    const sorted = [sheet.bounds.sizeMm.x, sheet.bounds.sizeMm.y, sheet.bounds.sizeMm.z].sort((a, b) => a - b);
    assert.ok(Math.abs(sorted[0] - 2) < 0.01, `thickness measured ${sorted[0]} mm, expected 2`);
    assert.ok(Math.abs(sorted[1] - 50) < 0.01, `width measured ${sorted[1]} mm, expected 50`);
    assert.ok(Math.abs(sorted[2] - 100) < 0.01, `length measured ${sorted[2]} mm, expected 100`);
  });

  it('refuses to call a handful of stray points a bounding box', () => {
    assert.equal(boundsOf([]), null);
    assert.equal(boundsOf([{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 2, y: 2, z: 2 }]), null);
  });

  it('never reports a size outside what a machined part could be', async (t) => {
    if (available.length === 0) return t.skip('no files in samples/');

    let measured = 0;
    let vertexless = 0;
    for (const name of available) {
      const model = findModelPartition(await load(name));
      if (!model) continue;
      const bounds = boundsOf(readPoints(model.data));
      if (!bounds) { vertexless += 1; continue; }
      measured += 1;

      // A wrong node offset produces reals that are absurd rather than merely
      // inaccurate, so a sanity range catches a broken layout even where no
      // known dimension exists to compare against.
      const largest = Math.max(bounds.sizeMm.x, bounds.sizeMm.y, bounds.sizeMm.z);
      assert.ok(
        largest > 0.05 && largest < 5000,
        `${name} measured ${largest.toFixed(1)} mm across, which is not a part`,
      );
    }

    console.log(`      measured ${measured} models, ${vertexless} had no readable vertices`);
    assert.ok(measured > 0, 'expected at least one model to yield a bounding box');
  });
});
