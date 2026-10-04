import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { instancePath, readStoredGraphics } from '../src/processing/sldprt/stored-graphics.js';

/**
 * The graphics an assembly keeps of its parts, built the way SolidWorks
 * writes them: a directory of occurrences, and a stream of blocks of faces.
 */

const words = (values: number[]) => Buffer.from(new Int32Array(values).buffer);
const floats = (values: number[]) => Buffer.from(new Float32Array(values).buffer);
const text = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe, 0xff, s.length]), Buffer.from(s, 'utf16le')]);

/** One face: a unit square (1 mm) as a single strip, normals +z. */
const square = Buffer.concat([
  words([7, 1]),
  words([4, 8, 2, 1, 4]),
  words([12, 100, 2, 4]),
  floats([0, 0, 0, 0.001, 0, 0, 0, 0.001, 0, 0.001, 0.001, 0]),
  words([12, 100, 2, 4]),
  floats([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
]);

const geometry = Buffer.from('0102030405060708', 'hex');
const own = Buffer.from('1112131415161718', 'hex');
const trailer = words([1, 103, 125, 6, 0]);

const directory = Buffer.concat([
  words([2, 1, 2, 2]),
  // The first occurrence of the bolt: its geometry, the stream and block holding it.
  text('Plate-1@Top/Bolt-1@Plate'),
  words([235]),
  Buffer.alloc(8),
  geometry,
  text('000-000-001'),
  words([0]),
  trailer,
  // The second: the same geometry, 8 bytes of its own, no stream.
  text('Plate-1@Top/Bolt-2@Plate'),
  words([235]),
  geometry,
  own,
  text(''),
  words([-1]),
  trailer,
]);
const stream = Buffer.concat([words([0]), geometry, words([1]), square]);

describe('graphics an assembly keeps of its parts', () => {
  const stored = readStoredGraphics([
    { name: 'FaceTessellations/Directory', offset: 0, data: directory },
    { name: 'FaceTessellations/000-000-001', offset: 0, data: stream },
  ]);

  it('reads a directory path as instance names', () => {
    assert.deepEqual(instancePath('Plate-1@Top/Bolt 7 -2@Plate'), ['Plate-1', 'Bolt 7 -2']);
  });

  it('finds the mesh of every occurrence, shared by occurrences of one part', () => {
    assert.ok(stored);
    assert.equal(stored.occurrences, 2);
    const first = stored.facesAt(['Plate-1', 'Bolt-1']);
    const second = stored.facesAt(['plate-1', 'Bolt-2']);
    assert.ok(first && second);
    assert.equal(first, second);
    assert.equal(first.length, 1);
    assert.deepEqual([...first[0].positions.subarray(9, 12)].map((v) => Math.round(v * 1e6)), [1000, 1000, 0]);
    assert.equal(stored.facesAt(['Plate-1', 'Bolt-3']), null);
  });

  it('says so when the assembly keeps none', () => {
    assert.equal(readStoredGraphics([]), null);
  });
});
