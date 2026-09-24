/**
 * convert.mjs — everything the API relies on, with a stand-in for SOLIDWORKS.
 * Run: node --test tools/
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const convert = path.resolve(here, '../convert.mjs');
const helper = path.join(here, 'fake-helper.mjs');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-test-'));

// What the API hands over: an extension-less upload called original.bin.
const upload = path.join(work, 'original.bin');
fs.writeFileSync(upload, Buffer.alloc(4096, 7));
const empty = path.join(work, 'empty.bin');
fs.writeFileSync(empty, Buffer.alloc(0));

function run(args, behaviour = 'ok') {
  const result = spawnSync(process.execPath, [convert, ...args, '--helper', helper], {
    encoding: 'utf8',
    env: { ...process.env, DOCUVIEW_FAKE_HELPER: behaviour },
  });
  return { code: result.status, out: result.stdout + result.stderr };
}

const out = (name) => path.join(work, name, 'converted.step');

test('converts a part stored as original.bin, handing SOLIDWORKS a .sldprt', () => {
  const r = run([upload, out('a'), 'sldprt']);
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.statSync(out('a')).size > 0);
});

test('hands an assembly over as an assembly', () => {
  const r = run([upload, out('b'), 'sldasm']);
  assert.equal(r.code, 0, r.out);
});

test('passes SOLIDWORKS’ own explanation through when it cannot open the file', () => {
  const r = run([upload, out('c'), 'sldprt'], 'fail');
  assert.equal(r.code, 1);
  assert.match(r.out, /newer SOLIDWORKS/);
});

test('keeps the busy exit code distinct', () => {
  assert.equal(run([upload, out('d'), 'sldprt'], 'busy').code, 4);
});

test('does not trust a success that wrote nothing', () => {
  const r = run([upload, out('e'), 'sldprt'], 'silent');
  assert.equal(r.code, 1);
  assert.match(r.out, /no STEP file/);
});

test('calls an empty file empty instead of blaming SOLIDWORKS', () => {
  const r = run([empty, out('f'), 'sldprt']);
  assert.equal(r.code, 3);
  assert.match(r.out, /empty/);
});

test('refuses a drawing, which has no solid', () => {
  assert.equal(run([upload, out('g'), 'slddrw']).code, 3);
});

test('says plainly when the helper has not been built', () => {
  const result = spawnSync(process.execPath, [convert, upload, out('h'), 'sldprt', '--helper', path.join(work, 'missing.exe')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not built yet/);
});

test('leaves no temporary copies behind', () => {
  const left = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('docuview-sw-'));
  assert.deepEqual(left, []);
});
