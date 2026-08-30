import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { detectFormat } from '../src/processing/detect.js';
import { readCompoundFile } from '../src/processing/cfb.js';
import { bestImage, findEmbeddedImages } from '../src/processing/embedded.js';
import { extractReferences, inspectNativeCad } from '../src/processing/native-cad.js';
import { tokenizeCommand } from '../src/processing/converter.js';
// Plain-JS builders shared with the fixture generator, so the containers these
// tests read are byte-for-byte the ones `npm run fixtures` writes.
import {
  buildCompoundFile,
  buildDib,
  buildPng,
  buildSummaryInformation,
} from '../../../scripts/compound-file.mjs';

/**
 * These cover the path a `.SLDPRT` takes when no licensed converter is
 * configured: the container is walked, the preview the CAD system stored is
 * pulled out, and the document opens instead of being refused.
 *
 * The fixtures are synthetic. Real SolidWorks and Inventor files cannot ship
 * with the repository, so the reader is written against the published compound
 * file and property set layouts and tested against files built to them.
 */

const SUMMARY = String.fromCharCode(5) + 'SummaryInformation';

describe('compound file reader', () => {
  it('enumerates streams from both the mini and the regular FAT', () => {
    const small = Buffer.alloc(300, 0x11);
    const large = Buffer.alloc(9000, 0x22);
    const file = buildCompoundFile([
      { name: 'Small', data: small },
      { name: 'Large', data: large },
    ]);

    const cfb = readCompoundFile(file);
    assert.ok(cfb, 'the container should parse');
    assert.deepEqual(
      cfb.entries.map((e) => e.name).sort(),
      ['Large', 'Small'],
    );

    const smallEntry = cfb.entries.find((e) => e.name === 'Small')!;
    const largeEntry = cfb.entries.find((e) => e.name === 'Large')!;
    assert.equal(cfb.read(smallEntry).length, 300);
    assert.deepEqual(cfb.read(smallEntry), small);
    assert.equal(cfb.read(largeEntry).length, 9000);
    assert.deepEqual(cfb.read(largeEntry), large);
  });

  it('rejects a file that is not a compound file', () => {
    assert.equal(readCompoundFile(Buffer.from('not a container at all, really')), null);
  });

  it('survives a truncated container without throwing', () => {
    const file = buildCompoundFile([{ name: 'Data', data: Buffer.alloc(5000, 7) }]);
    const truncated = file.subarray(0, 1024);
    // Either a null or a partial read is fine; hanging or throwing is not.
    const cfb = readCompoundFile(truncated);
    if (cfb) for (const entry of cfb.entries) cfb.read(entry);
  });
});

describe('embedded image extraction', () => {
  it('finds a PNG and reads its real dimensions', () => {
    const png = buildPng(120, 80);
    const haystack = Buffer.concat([Buffer.alloc(64, 0xab), png, Buffer.alloc(32, 0xcd)]);
    const image = bestImage(findEmbeddedImages(haystack));
    assert.ok(image);
    assert.equal(image.type, 'png');
    assert.equal(image.width, 120);
    assert.equal(image.height, 80);
    assert.deepEqual(image.data, png);
  });

  it('wraps a bare DIB into a bitmap a browser can render', () => {
    const dib = buildDib(48, 32);
    const image = bestImage(findEmbeddedImages(dib));
    assert.ok(image);
    assert.equal(image.type, 'bmp');
    assert.equal(image.width, 48);
    assert.equal(image.height, 32);
    assert.equal(image.data.subarray(0, 2).toString('latin1'), 'BM');
    assert.equal(image.data.readUInt32LE(2), image.data.length);
  });

  it('does not mistake random binary for an image', () => {
    // Deterministic pseudo-random bytes, so a failure here is reproducible.
    const noise = Buffer.alloc(64 * 1024);
    let seed = 12345;
    for (let i = 0; i < noise.length; i += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      noise[i] = seed & 0xff;
    }
    assert.deepEqual(findEmbeddedImages(noise), []);
  });

  it('prefers the largest picture when several are embedded', () => {
    const haystack = Buffer.concat([buildPng(32, 32), buildPng(200, 150), buildPng(64, 64)]);
    const image = bestImage(findEmbeddedImages(haystack));
    assert.ok(image);
    assert.equal(image.width, 200);
    assert.equal(image.height, 150);
  });
});

describe('native CAD inspection', () => {
  it('opens a SolidWorks-shaped part from its summary thumbnail and properties', () => {
    const file = buildCompoundFile([
      {
        name: SUMMARY,
        data: buildSummaryInformation([
          { id: 2, value: '10640.00.00.00.00.04' },
          { id: 4, value: 'A. Engineer' },
          { id: 9, value: 'Rev C' },
          { id: 18, value: 'SolidWorks 2021' },
          { id: 17, value: buildDib(64, 64) },
        ]),
      },
      { name: 'ISolidWorksInformation', data: Buffer.from('SolidWorks 2021 document', 'utf16le') },
    ]);

    const info = inspectNativeCad(file, 'sldprt', 'sldprt');
    assert.equal(info.application, 'SolidWorks');
    assert.equal(info.role, 'part');
    assert.ok(info.preview, 'the stored thumbnail should be found');
    assert.equal(info.preview.width, 64);
    assert.equal(info.preview.height, 64);

    const byName = new Map(info.properties.map((p) => [p.name, p.value]));
    assert.equal(byName.get('Title'), '10640.00.00.00.00.04');
    assert.equal(byName.get('Author'), 'A. Engineer');
    assert.equal(byName.get('Revision'), 'Rev C');
    assert.equal(byName.get('Created with'), 'SolidWorks 2021');
    assert.equal(info.version, 'SolidWorks 2021');
  });

  it('falls back to a preview stream when there is no summary thumbnail', () => {
    const png = buildPng(160, 120);
    const file = buildCompoundFile([
      { name: 'PreviewPNG', data: png },
      { name: 'Contents', data: Buffer.alloc(200, 3) },
    ]);

    const info = inspectNativeCad(file, 'sldprt', 'sldprt');
    assert.ok(info.preview);
    assert.equal(info.preview.type, 'png');
    assert.equal(info.preview.width, 160);
  });

  it('lists the components an assembly references', () => {
    const references = Buffer.from(
      'C:\\Projects\\10640\\bracket-left.SLDPRT\u0000D:\\lib\\pin_8x40.sldprt\u0000sub-frame.SLDASM',
      'utf16le',
    );
    const file = buildCompoundFile([
      { name: 'Contents', data: references },
      { name: SUMMARY, data: buildSummaryInformation([{ id: 18, value: 'SolidWorks 2021' }]) },
    ]);

    const info = inspectNativeCad(file, 'sldprt', 'sldasm');
    assert.equal(info.role, 'assembly');
    const names = info.references.map((n) => n.toLowerCase());
    assert.ok(names.includes('bracket-left.sldprt'), `expected bracket-left in ${names.join(', ')}`);
    assert.ok(names.includes('pin_8x40.sldprt'), `expected pin_8x40 in ${names.join(', ')}`);
    assert.ok(names.includes('sub-frame.sldasm'), `expected sub-frame in ${names.join(', ')}`);
  });

  it('reports no components for a part, even when the bytes mention other files', () => {
    const file = buildCompoundFile([
      { name: 'Contents', data: Buffer.from('neighbour.SLDPRT', 'utf16le') },
    ]);
    assert.deepEqual(inspectNativeCad(file, 'sldprt', 'sldprt').references, []);
  });

  it('reads a CATIA-shaped file that is not a compound file at all', () => {
    const png = buildPng(200, 200);
    const file = Buffer.concat([Buffer.from('CATIA V5 binary header'), Buffer.alloc(512, 0x5a), png]);
    const info = inspectNativeCad(file, 'catia', 'catpart');
    assert.equal(info.application, 'CATIA');
    assert.ok(info.preview);
    assert.equal(info.preview.width, 200);
  });
});

describe('reference extraction', () => {
  it('keeps base names and drops duplicates', () => {
    // References sit between control bytes in a real container, which is what
    // separates one path from the next.
    const found = extractReferences(
      'X:/a/b/Housing.SLDPRT\u0000..\\..\\Housing.sldprt\u0000Cover.SLDASM',
      ['sldprt', 'sldasm'],
    );
    assert.deepEqual(found, ['Housing.SLDPRT', 'Cover.SLDASM']);
  });

  it('does not run two adjacent references together', () => {
    const found = extractReferences('Base Plate.SLDPRT Cover.SLDPRT', ['sldprt']);
    assert.deepEqual(found, ['Base Plate.SLDPRT', 'Cover.SLDPRT']);
  });

  it('returns nothing when the family has no referencing formats', () => {
    assert.deepEqual(extractReferences('Housing.SLDPRT', []), []);
  });
});

describe('converter command parsing', () => {
  it('splits a template into argv and honours quotes', () => {
    assert.deepEqual(tokenizeCommand('/opt/conv/run --in {input} --out {output}'), [
      '/opt/conv/run',
      '--in',
      '{input}',
      '--out',
      '{output}',
    ]);
    assert.deepEqual(tokenizeCommand('"C:\\Program Files\\conv.exe" -q {input}'), [
      'C:\\Program Files\\conv.exe',
      '-q',
      '{input}',
    ]);
  });
});

describe('detection of native CAD containers', () => {
  const scratch: string[] = [];

  after(async () => {
    for (const file of scratch) await fs.rm(file, { force: true });
  });

  async function detect(bytes: Buffer, name: string) {
    const file = path.join(os.tmpdir(), `docuview-native-${Date.now()}-${scratch.length}-${name}`);
    scratch.push(file);
    await fs.writeFile(file, bytes);
    const extension = /\.([^.]+)$/.exec(name)?.[1].toLowerCase() ?? '';
    return detectFormat(file, extension, bytes.length);
  }

  it('recognises a SolidWorks container from its marker stream', async () => {
    const file = buildCompoundFile([
      { name: 'ISolidWorksInformation', data: Buffer.from('SolidWorks 2021', 'utf16le') },
      { name: SUMMARY, data: buildSummaryInformation([{ id: 18, value: 'SolidWorks 2021' }]) },
    ]);
    const result = await detect(file, 'part.sldprt');
    assert.equal(result.format?.id, 'sldprt');
    assert.equal(result.format?.pipeline, 'server');
    assert.equal(result.format?.processor, 'cad-proprietary');
    assert.equal(result.extensionMismatch, false);
  });

  it('falls back to the extension for a compound file with no marker in its head', async () => {
    const file = buildCompoundFile([{ name: 'Contents', data: Buffer.alloc(600, 9) }]);
    const result = await detect(file, 'frame.sldasm');
    assert.equal(result.format?.id, 'sldprt');
    assert.equal(result.detail, 'ole:extension-native-cad');
  });

  it('accepts a CATIA part, which is not a container we can parse', async () => {
    const bytes = Buffer.concat([Buffer.alloc(64, 0xff), Buffer.from('V5 CATIA'), Buffer.alloc(4096, 0x7f)]);
    const result = await detect(bytes, 'housing.CATPart');
    assert.equal(result.format?.id, 'catia');
  });

  it('still refuses a renamed blob for a format that has a real signature', async () => {
    const bytes = Buffer.alloc(4096, 0xa5);
    assert.equal((await detect(bytes, 'model.step')).format, null);
    assert.equal((await detect(bytes, 'model.stl')).format, null);
  });
});
