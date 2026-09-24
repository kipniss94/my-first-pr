#!/usr/bin/env node
/**
 * Stand-in for bin/sw-convert.exe, for testing everything around SOLIDWORKS on
 * a machine that has none. Checks what it is handed the way SOLIDWORKS would
 * care about, then "exports" fixtures/cube.step. DOCUVIEW_FAKE_HELPER selects
 * a failure: fail, busy, silent (exit 0, write nothing), slow.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const [mode, source, output, kind] = process.argv.slice(2);
const behaviour = process.env.DOCUVIEW_FAKE_HELPER ?? 'ok';

if (mode !== 'convert') process.exit(0);
if (!fs.existsSync(source)) { console.error(`source missing: ${source}`); process.exit(1); }
const expected = kind === 'assembly' ? '.sldasm' : '.sldprt';
if (path.extname(source) !== expected) { console.error(`SOLIDWORKS would reject ${path.basename(source)}: expected ${expected}`); process.exit(1); }

if (behaviour === 'fail') { console.error('SOLIDWORKS could not open the file (load error 8192). It was saved by a newer SOLIDWORKS.'); process.exit(1); }
if (behaviour === 'busy') { console.error('SOLIDWORKS stayed busy with other conversions for too long.'); process.exit(4); }
if (behaviour === 'slow') await new Promise((r) => setTimeout(r, 600_000));
if (behaviour !== 'silent') fs.copyFileSync(path.join(root, 'fixtures', 'cube.step'), output);
console.log(`fake SOLIDWORKS: ${kind} exported`);
