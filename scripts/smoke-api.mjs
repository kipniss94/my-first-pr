/**
 * Upload every fixture through the real API and report what happened.
 *
 *   node scripts/smoke-api.mjs [apiBase] [fixturesDir]
 *
 * Exits non-zero if a file that is expected to open fails, or if a file that is
 * expected to fail opens anyway.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] ?? 'http://127.0.0.1:4000';
const fixturesDir = path.resolve(root, process.argv[3] ?? 'fixtures');

/**
 * `true`  = must open.
 * `false` = must fail with a user-facing message.
 * `'mismatch'` = must open *and* warn that the extension disagreed with the
 *   contents, which is how content sniffing is supposed to behave.
 */
const EXPECTATIONS = {
  'cube.step': true,
  'hollow-block.step': true,
  'bracket-assembly.step': true,
  'broken.step': false,
  'stepped-block.stl': true,
  'cube-ascii.stl': true,
  'two-part.obj': true,
  'plate.dxf': true,
  'report.pdf': true,
  'measurements.csv': true,
  'notes.txt': true,
  'inspection-report.docx': true,
  'bill-of-materials.xlsx': true,
  'pipeline-overview.pptx': true,
  'not-a-model.stl': 'mismatch',
  'garbage.bin': false,
};

async function uploadOne(name) {
  const filePath = path.join(fixturesDir, name);
  const data = await fs.readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([data]), name);

  const started = Date.now();
  const response = await fetch(`${base}/api/v1/uploads`, { method: 'POST', body: form });
  const body = await response.json();
  if (!response.ok) {
    return { name, ok: false, ms: Date.now() - started, error: body.error, stage: 'upload' };
  }

  const deadline = Date.now() + 180_000;
  let job = body.job;
  while (Date.now() < deadline) {
    const poll = await fetch(`${base}/api/v1/jobs/${body.jobId}`);
    job = await poll.json();
    if (job.status === 'succeeded' || job.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const ms = Date.now() - started;
  if (job.status !== 'succeeded') {
    return { name, ok: false, ms, error: job.error, stage: job.stage, format: job.format, fileId: body.fileId };
  }

  // The viewer must actually be able to fetch what the job points at.
  const assetResponse = await fetch(`${base}${job.result.source}`);
  const assetOk = assetResponse.ok;
  const assetBytes = Number(assetResponse.headers.get('content-length') ?? 0);
  await assetResponse.arrayBuffer();

  return {
    name,
    ok: assetOk,
    ms,
    format: job.format,
    viewer: job.result.viewer,
    meta: job.result.meta,
    warnings: job.result.warnings,
    assetBytes,
    fileId: body.fileId,
  };
}

async function main() {
  const names = Object.keys(EXPECTATIONS);
  let failures = 0;
  const cleanup = [];

  for (const name of names) {
    let outcome;
    try {
      outcome = await uploadOne(name);
    } catch (err) {
      outcome = { name, ok: false, error: { message: String(err) } };
    }
    if (outcome.fileId) cleanup.push(outcome.fileId);

    const expected = EXPECTATIONS[name];
    const matched =
      expected === 'mismatch'
        ? outcome.ok === true && (outcome.warnings ?? []).some((w) => w.includes('but its contents are'))
        : outcome.ok === expected;
    if (!matched) failures += 1;

    const mark = matched ? 'PASS' : 'FAIL';
    const detail = outcome.ok
      ? `${outcome.format?.label ?? '?'}${outcome.format?.version ? ` ${outcome.format.version}` : ''} → ${outcome.viewer} (${outcome.assetBytes} B)`
      : `${outcome.error?.code ?? 'error'}: ${outcome.error?.message ?? 'unknown'}`;
    console.log(`${mark}  ${name.padEnd(26)} ${String(outcome.ms ?? 0).padStart(6)} ms  ${detail}`);

    if (outcome.meta && Object.keys(outcome.meta).length > 0) {
      const interesting = ['triangles', 'parts', 'sheetCount', 'slideCount', 'words', 'units', 'producer', 'mode'];
      const summary = interesting
        .filter((key) => outcome.meta[key] !== undefined && outcome.meta[key] !== null)
        .map((key) => `${key}=${JSON.stringify(outcome.meta[key])}`)
        .join(' ');
      if (summary) console.log(`      ${summary}`);
    }
    for (const warning of outcome.warnings ?? []) console.log(`      warning: ${warning}`);
  }

  // Verify deletion works, then confirm the file is really gone.
  if (cleanup.length > 0) {
    const target = cleanup[0];
    await fetch(`${base}/api/v1/files/${target}`, { method: 'DELETE' });
    const after = await fetch(`${base}/api/v1/files/${target}/raw`);
    console.log(`\n${after.status === 404 ? 'PASS' : 'FAIL'}  delete removes the stored file (got ${after.status})`);
    if (after.status !== 404) failures += 1;
  }

  console.log(`\n${names.length - failures}/${names.length} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
