import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';
import { findBrepSource, meshFromBrep } from '../src/processing/sldprt/brep-mesh.js';
import { readPackage, unwrapCodec } from '../src/processing/sldprt/container.js';
import { findDisplayMesh, measureMesh, toIndexedMesh, type IndexedMesh } from '../src/processing/sldprt/display-list.js';

/**
 * Parts saved without a display mesh are drawn from their exact B-rep, read
 * out of the Parasolid stream and triangulated here. That has to be right the
 * same way the display mesh is: every face present, the mesh closed, every
 * triangle facing out — so it is checked by volume against parts whose volume
 * is known, and against SolidWorks' own display mesh of every sample part.
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

async function brepOf(name: string) {
  const entries = readPackage(await fs.readFile(path.join(samples, name)));
  const { source } = findBrepSource(entries);
  return { entries, source, built: source ? meshFromBrep(source.model) : null };
}

/** Edges used by one triangle only, and edges used twice the same way round. */
function defects(mesh: IndexedMesh): { open: number; misoriented: number } {
  const p = mesh.positions;
  const ids = new Map<string, number>();
  const weld: number[] = [];
  for (let i = 0; i < p.length; i += 3) {
    const key = `${Math.round(p[i] * 1e3)},${Math.round(p[i + 1] * 1e3)},${Math.round(p[i + 2] * 1e3)}`;
    if (!ids.has(key)) ids.set(key, ids.size);
    weld.push(ids.get(key) as number);
  }
  const directed = new Map<string, number>();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [weld[mesh.indices[t]], weld[mesh.indices[t + 1]], weld[mesh.indices[t + 2]]];
    if (a === b || b === c || c === a) continue;
    for (const [x, y] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      directed.set(`${x}>${y}`, (directed.get(`${x}>${y}`) ?? 0) + 1);
    }
  }
  let open = 0;
  let misoriented = 0;
  for (const [edge, count] of directed) {
    const [x, y] = edge.split('>');
    const back = directed.get(`${y}>${x}`) ?? 0;
    if (count > 1) misoriented += 1;
    else if (back === 0) open += 1;
  }
  return { open, misoriented };
}

describe('codec streams', () => {
  it('joins a stream stored as several blocks, and stops where the blocks do', () => {
    const guid = Buffer.from('231dd571da8148a2a85898b21b89ef99', 'hex');
    const parts = [Buffer.alloc(4096, 7), Buffer.from('the second, shorter block')];
    const blocks = parts.map((part) => {
      const deflated = zlib.deflateSync(part);
      const sizes = Buffer.alloc(8);
      sizes.writeUInt32LE(part.length, 0);
      sizes.writeUInt32LE(deflated.length, 4);
      return Buffer.concat([sizes, deflated]);
    });
    const trailing = Buffer.from([0x10, 0, 0, 0, ...guid]);
    const out = unwrapCodec(Buffer.concat([Buffer.alloc(4), guid, ...blocks, trailing]));
    assert.ok(out);
    assert.deepEqual(out, Buffer.concat(parts));
  });
});

describe('B-rep of a SolidWorks part', () => {
  it('reads the topology of a cube: 6 faces, 12 edges, 8 vertices', async (t) => {
    if (!available.includes('cube-10.SLDPRT')) return t.skip('cube-10.SLDPRT not in samples/');
    const { source } = await brepOf('cube-10.SLDPRT');
    assert.ok(source, 'no Parasolid stream with faces');
    const count = (type: number) => source.model.byType.get(type)?.length ?? 0;
    assert.deepEqual(
      { bodies: count(12), faces: count(14), loops: count(15), edges: count(16), fins: count(17), vertices: count(18), planes: count(50) },
      { bodies: 1, faces: 6, loops: 6, edges: 12, fins: 24, vertices: 8, planes: 6 },
    );
  });

  it('triangulates parts of known volume to that volume', async (t) => {
    const cases: [string, number, number][] = [
      // name, expected mm³, tolerance: flat parts are exact, curved ones are facets
      ['cube-10.SLDPRT', 1000, 1e-6],
      ['cube-20.SLDPRT', 8000, 1e-6],
      ['sheet-flat-50-100-2.SLDPRT', 10000, 1e-6],
      ['cylinder-d50-h100.SLDPRT', Math.PI * 25 * 25 * 100, 0.005],
      ['cylinder-d50-h50.SLDPRT', Math.PI * 25 * 25 * 50, 0.005],
      ['hole-d20.SLDPRT', 50 * 50 * 50 - Math.PI * 10 * 10 * 50, 0.005],
    ];
    let checked = 0;
    for (const [name, expected, tolerance] of cases) {
      if (!available.includes(name)) continue;
      const { built } = await brepOf(name);
      assert.ok(built, `${name}: no mesh`);
      checked += 1;
      const { volume } = measureMesh(built.mesh);
      assert.ok(Math.abs(volume - expected) / expected < tolerance, `${name}: volume ${volume.toFixed(1)} mm³, expected ${expected.toFixed(1)}`);
    }
    if (checked === 0) return t.skip('reference parts not in samples/');
  });

  it('gives every sample part a closed, outward-facing mesh that agrees with SolidWorks', async (t) => {
    let checked = 0;
    for (const name of available) {
      const { entries, source, built } = await brepOf(name);
      if (!source) continue;
      assert.ok(built, `${name}: B-rep with ${source.faces} faces gave no mesh`);
      checked += 1;
      assert.equal(built.stats.approximated + built.stats.skipped, 0, `${name}: faces not drawn exactly`);
      const { open, misoriented } = defects(built.mesh);
      assert.equal(misoriented, 0, `${name}: ${misoriented} edges used twice the same way round`);
      assert.equal(open, 0, `${name}: ${open} open edges`);
      const display = findDisplayMesh(entries);
      if (display.length === 0) continue;
      const reference = measureMesh(toIndexedMesh(display)).volume;
      const volume = measureMesh(built.mesh).volume;
      assert.ok(volume > 0, `${name}: volume ${volume} — inside out`);
      assert.ok(
        Math.abs(volume - reference) / reference < 0.01,
        `${name}: ${volume.toFixed(1)} mm³ from the B-rep, ${reference.toFixed(1)} mm³ in SolidWorks' mesh`,
      );
    }
    if (checked === 0) return t.skip('no files in samples/');
  });
});
