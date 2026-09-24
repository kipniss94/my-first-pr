#!/usr/bin/env node
/**
 * Convert a SOLIDWORKS part or assembly to STEP — the CAD_CONVERTER_CMD target.
 *
 *   node tools/solidworks/convert.mjs <input> <output.step> <informat> [--helper <path>]
 *
 * The launcher points the API at this script when it finds SOLIDWORKS on the
 * machine. The API hands over its stored upload, this script prepares it, and
 * `bin/sw-convert.exe` (compiled from SwConvert.cs on first start) has the
 * installed SOLIDWORKS open it and save it as STEP. From there the model takes
 * DocuView's ordinary STEP path to the browser as real 3D geometry.
 *
 * Why the preparation matters: the API stores every upload as `original.bin`,
 * and SOLIDWORKS decides what a file is by its extension. So it gets a copy
 * with the right one — under a unique name, because SOLIDWORKS refuses to open
 * a second document with a file name that is already open.
 *
 * Exit codes: 0 converted, 1 failed, 2 bad arguments, 3 nothing to convert
 * (an empty file, a drawing), 4 SOLIDWORKS busy for too long.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const logDir = path.join(root, 'logs');
const logFile = path.join(logDir, 'solidworks.log');

/** Under the API's own 600 s processing limit, so this reports before being killed. */
const TIMEOUT_MS = 540_000;

const KINDS = {
  sldprt: 'part',
  prtdot: 'part',
  sldasm: 'assembly',
  asmdot: 'assembly',
};

function log(message) {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)}  [${process.pid}] ${message}`;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(logFile, `${line}\n`);
  } catch {
    // Logging must never be the reason a conversion fails.
  }
  process.stdout.write(`${message}\n`);
}

function fail(code, message) {
  log(`ERROR: ${message}`);
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const positional = [];
  let helper = path.join(here, 'bin', 'sw-convert.exe');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--helper') helper = argv[++i];
    else positional.push(argv[i]);
  }
  const [input, output, format = ''] = positional;
  return { input, output, format, helper };
}

function killTree(child) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}

async function main() {
  const { input, output, format, helper } = parseArgs(process.argv.slice(2));
  if (!input || !output) fail(2, 'usage: convert.mjs <input> <output.step> <informat> [--helper <path>]');

  let size;
  try {
    size = fs.statSync(input).size;
  } catch {
    fail(2, `input file not found: ${input}`);
  }
  if (size === 0) fail(3, 'The file is empty (0 bytes): there is no model in it to open.');

  const extension = (format || path.extname(input)).replace(/^\./, '').toLowerCase();
  if (extension === 'slddrw' || extension === 'drwdot') fail(3, 'A drawing has no solid to convert.');
  const kind = KINDS[extension] ?? 'part';
  const sourceExtension = KINDS[extension] ? extension : 'sldprt';

  if (!fs.existsSync(helper)) {
    fail(1, 'The SOLIDWORKS helper is not built yet. Start DocuView with Start-DocuView.bat, which builds it.');
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'docuview-sw-'));
  const source = path.join(work, `dv-${randomBytes(6).toString('hex')}.${sourceExtension}`);
  fs.copyFileSync(input, source);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.rmSync(output, { force: true });

  const started = Date.now();
  // A test harness may pass a script in place of the compiled helper.
  const [command, args] = /\.(mjs|js)$/i.test(helper)
    ? [process.execPath, [helper, 'convert', source, output, kind]]
    : [helper, ['convert', source, output, kind]];

  const code = await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      killTree(child);
      stderr = 'SOLIDWORKS took longer than 9 minutes on this model and was stopped.';
    }, TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim()) log(line.trim());
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      stderr = `could not start the SOLIDWORKS helper: ${err.message}`;
      resolve(1);
    });
    child.on('close', (exit) => {
      clearTimeout(timer);
      if (exit !== 0) {
        log(`ERROR: ${stderr.trim() || `helper exited with ${exit}`}`);
        process.stderr.write(`${stderr.trim()}\n`);
      }
      resolve(exit ?? 1);
    });
  });

  // SOLIDWORKS can hold the copy for a moment after closing it; a leftover in
  // the temp folder is harmless, a crash over it would not be.
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch {
    // ignored
  }

  if (code !== 0) process.exit(code);

  const produced = fs.existsSync(output) ? fs.statSync(output).size : 0;
  if (produced === 0) fail(1, 'SOLIDWORKS reported success but no STEP file was written.');

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  log(`converted ${kind} (${Math.round(size / 1024)} KB) to STEP (${Math.round(produced / 1024)} KB) in ${seconds} s`);
}

main().catch((err) => fail(1, err instanceof Error ? err.message : String(err)));
