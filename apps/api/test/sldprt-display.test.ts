import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';
import { crc32, findPreviewPng, readPackage, unswapNibbles } from '../src/processing/sldprt/container.js';
import { decodeDisplayList, findDisplayMesh, measureMesh, toIndexedMesh } from '../src/processing/sldprt/display-list.js';

/**
 * The display mesh is what the viewer draws for every SolidWorks part, so it is
 * checked the strict way: by enclosed volume against parts whose volume is
 * known. Volume only comes out right when every face is present, the mesh is
 * closed and every triangle faces outward — a missing face, a duplicated one or
 * a flipped strip all show up as a wrong number.
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

async function meshOf(name: string) {
  if (!available.includes(name)) return null;
  const buffer = await fs.readFile(path.join(samples, name));
  return toIndexedMesh(findDisplayMesh(readPackage(buffer)));
}

/** One ZIP local header without its signature, name nibble-swapped, as SolidWorks writes it. */
function packageEntry(name: string, content: Buffer): Buffer {
  const deflated = zlib.deflateRawSync(content);
  const header = Buffer.alloc(26);
  header.writeUInt16LE(0x14, 0);
  header.writeUInt16LE(6, 2);
  header.writeUInt16LE(8, 4);
  header.writeUInt32LE(crc32(content), 10);
  header.writeUInt32LE(deflated.length, 14);
  header.writeUInt32LE(content.length, 18);
  header.writeUInt16LE(name.length, 22);
  return Buffer.concat([header, unswapNibbles(Buffer.from(name, 'latin1')), deflated]);
}

/** One face: a unit square in the z = 0 plane as a single strip, normals +z. */
function squareFace(): Buffer {
  const words = (values: number[]) => Buffer.from(new Uint32Array(values).buffer);
  const floats = (values: number[]) => Buffer.from(new Float32Array(values).buffer);
  return Buffer.concat([
    words([4, 8, 2, 1, 4]),
    words([12, 100, 2, 4]),
    floats([0, 0, 0, 0.001, 0, 0, 0, 0.001, 0, 0.001, 0.001, 0]),
    words([12, 100, 2, 4]),
    floats([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  ]);
}

describe('SolidWorks package, read as ZIP entries', () => {
  it('accepts an entry only when it inflates to its own CRC-32 and length', () => {
    const good = packageEntry('Contents/DisplayLists', Buffer.from('mesh data '.repeat(40)));
    const entries = readPackage(Buffer.concat([Buffer.alloc(9), good]));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'Contents/DisplayLists');

    // One flipped byte in the stored CRC and the entry is gone, not misread.
    const damaged = Buffer.from(good);
    damaged[10] ^= 0xff;
    assert.equal(readPackage(damaged).length, 0);
  });

  it('extracts the preview SolidWorks saved, from every part', async (t) => {
    if (available.length === 0) return t.skip('no files in samples/');
    let real = 0;
    let previews = 0;
    for (const name of available) {
      const buffer = await fs.readFile(path.join(samples, name));
      if (buffer.length < 1024) continue;
      real += 1;
      if (findPreviewPng(readPackage(buffer))) previews += 1;
    }
    assert.equal(previews, real, `preview found in ${previews}/${real} parts`);
  });
});

describe('display mesh', () => {
  it('turns a strip into triangles facing the way the stored normals say, in millimetres', () => {
    const faces = decodeDisplayList(Buffer.concat([Buffer.alloc(7), squareFace(), Buffer.alloc(5)]));
    assert.equal(faces.length, 1);
    const mesh = toIndexedMesh(faces);
    assert.equal(mesh.triangles, 2);
    const measured = measureMesh(mesh);
    assert.ok(Math.abs(measured.area - 1) < 1e-6, `a 1 mm square should have 1 mm² of area, got ${measured.area}`);
    assert.deepEqual(measured.size.map((v) => Number(v.toFixed(6))), [1, 1, 0]);

    // Both triangles must face +z, as the normals do.
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [mesh.indices[t] * 3, mesh.indices[t + 1] * 3, mesh.indices[t + 2] * 3];
      const p = mesh.positions;
      const z = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
      assert.ok(z > 0, 'triangle wound against its normals');
    }
  });

  it('ignores a header whose strip lengths do not add up to its vertex count', () => {
    const face = squareFace();
    face.writeUInt32LE(3, 16); // strip of 3 declared, 4 vertices follow
    assert.equal(decodeDisplayList(face).length, 0);
  });

  it('reproduces the exact volume of parts whose volume is known', async (t) => {
    const cases: [string, number, number][] = [
      // name, expected mm³, tolerance: flat parts are exact, curved ones are facets
      ['cube-10.SLDPRT', 1000, 1e-3],
      ['cube-20.SLDPRT', 8000, 1e-3],
      ['sheet-flat-50-100-2.SLDPRT', 10000, 1e-3],
      ['cylinder-d50-h100.SLDPRT', Math.PI * 25 * 25 * 100, 0.01],
      ['cylinder-d50-h50.SLDPRT', Math.PI * 25 * 25 * 50, 0.01],
      ['hole-d20.SLDPRT', 50 * 50 * 50 - Math.PI * 10 * 10 * 50, 0.01],
    ];
    let checked = 0;
    for (const [name, expected, tolerance] of cases) {
      const mesh = await meshOf(name);
      if (!mesh) continue;
      checked += 1;
      const { volume } = measureMesh(mesh);
      assert.ok(
        Math.abs(volume - expected) / expected < tolerance,
        `${name}: volume ${volume.toFixed(1)} mm³, expected ${expected.toFixed(1)}`,
      );
    }
    if (checked === 0) return t.skip('reference parts not in samples/');
  });

  it('draws every real part as a closed, outward-facing solid', async (t) => {
    if (available.length === 0) return t.skip('no files in samples/');
    let real = 0;
    const failed: string[] = [];
    for (const name of available) {
      const buffer = await fs.readFile(path.join(samples, name));
      if (buffer.length < 1024) continue; // empty files hold no model at all
      real += 1;
      const mesh = toIndexedMesh(findDisplayMesh(readPackage(buffer)));
      const { volume, size } = measureMesh(mesh);
      if (mesh.triangles === 0 || !(volume > 0) || Math.max(...size) > 5000) failed.push(name);
    }
    console.log(`      display mesh drawn for ${real - failed.length}/${real} parts`);
    assert.deepEqual(failed, [], `no usable mesh in: ${failed.slice(0, 5).join(', ')}`);
  });
});
