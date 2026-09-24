#!/usr/bin/env node
/**
 * Proof, on the machine that matters, that every SOLIDWORKS model opens in 3D
 * — with no CAD installed anywhere.
 *
 *   node scripts/verify-models.mjs [folder] [--assemblies] [--api http://127.0.0.1:4000]
 *
 * Sends every .SLDPRT under the folder (and with --assemblies every .SLDASM)
 * through the running DocuView exactly as the browser does — upload, wait for
 * the job — and records whether it came back as real 3D geometry. Writes an
 * HTML and a CSV report to logs/ and exits 0 only if every non-empty model did.
 *
 * Default folder: C:\User\3D\SW on Windows, ./samples elsewhere.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const api = (option('--api') ?? 'http://127.0.0.1:4000').replace(/\/$/, '');
const withAssemblies = argv.includes('--assemblies');
const folder = path.resolve(
  argv.find((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--api') ??
    (process.platform === 'win32' ? 'C:\\User\\3D\\SW' : path.join(root, 'samples')),
);
const PER_FILE_LIMIT_MS = 11 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findModels(dir) {
  const pattern = withAssemblies ? /\.(sldprt|sldasm)$/i : /\.sldprt$/i;
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      // SOLIDWORKS leaves ~$name.SLDPRT lock files next to open documents.
      else if (pattern.test(entry.name) && !entry.name.startsWith('~$')) found.push(full);
    }
  };
  walk(dir);
  return found.sort((a, b) => a.localeCompare(b));
}

async function upload(file) {
  const data = await fs.promises.readFile(file);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const form = new FormData();
    form.append('file', new Blob([data]), path.basename(file));
    const response = await fetch(`${api}/api/v1/uploads`, { method: 'POST', body: form });
    if (response.status === 429) {
      // The upload limit is a real limit even locally; wait it out.
      const wait = Number(response.headers.get('retry-after')) || 20;
      await sleep(wait * 1000);
      continue;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message ?? `upload failed with HTTP ${response.status}`);
    return body.jobId;
  }
  throw new Error('upload kept being rate-limited');
}

async function waitForJob(jobId) {
  const deadline = Date.now() + PER_FILE_LIMIT_MS;
  while (Date.now() < deadline) {
    const response = await fetch(`${api}/api/v1/jobs/${jobId}`);
    if (response.ok) {
      const job = await response.json();
      if (job.status === 'succeeded' || job.status === 'failed') return job;
    }
    await sleep(1000);
  }
  throw new Error('no result within 11 minutes');
}

function classify(job) {
  if (job.status === 'failed') return { outcome: 'error', reason: job.error?.message ?? 'processing failed' };
  const result = job.result ?? {};
  const viewer = String(result.viewer ?? '');
  if (viewer.startsWith('cad') && viewer !== 'cad-preview') {
    const faces = result.meta?.faces;
    const triangles = result.meta?.triangles;
    const via = result.meta?.convertedVia === 'server converter' ? 'через внешний конвертер' : 'прочитано из файла';
    return { outcome: '3d', reason: `${via}${faces ? `, граней ${faces}` : ''}${triangles ? `, треугольников ${triangles}` : ''}` };
  }
  return { outcome: 'no-3d', reason: (result.warnings ?? [])[0] ?? 'открыт без 3D-геометрии' };
}

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function writeReports(rows, summary) {
  const tag = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const logs = path.join(root, 'logs');
  fs.mkdirSync(logs, { recursive: true });

  const csv = [
    ['file', 'size_kb', 'outcome', 'seconds', 'detail'].join(';'),
    ...rows.map((r) => [r.file, r.sizeKb, r.outcome, r.seconds, r.reason.replace(/;/g, ',')].join(';')),
  ].join('\r\n');
  const csvPath = path.join(logs, `model-check-${tag}.csv`);
  fs.writeFileSync(csvPath, `\ufeff${csv}`);

  const label = { '3d': '3D', 'no-3d': 'без 3D', error: 'ошибка', empty: 'пустой файл' };
  const colour = { '3d': '#1f8a4c', 'no-3d': '#b7791f', error: '#c53030', empty: '#718096' };
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Проверка моделей SOLIDWORKS</title>
<style>body{font:14px/1.45 system-ui,Segoe UI,sans-serif;margin:24px;color:#1a202c;background:#fff}
h1{font-size:20px;margin:0 0 4px}p{margin:4px 0 16px;color:#4a5568}
.big{font-size:32px;font-weight:600;color:${summary.all ? '#1f8a4c' : '#c53030'}}
table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:left;vertical-align:top}
th{background:#f7fafc;font-weight:600}td.n{text-align:right;font-variant-numeric:tabular-nums}
span.tag{display:inline-block;padding:1px 8px;border-radius:10px;color:#fff;font-size:12px}</style></head><body>
<h1>Проверка моделей SOLIDWORKS в DocuView</h1>
<p>${escape(summary.folder)} · ${escape(new Date().toLocaleString('ru-RU'))} · без CAD — модели прочитаны из самих файлов</p>
<div class="big">${summary.ok} из ${summary.real} открыты в 3D (${summary.percent}%)</div>
<p>${summary.empty ? `Пустых файлов (0 байт, модели в них нет): ${summary.empty}. ` : ''}Среднее время: ${summary.avg} с на модель.</p>
<table><tr><th>Файл</th><th>Размер, КБ</th><th>Результат</th><th>Время, с</th><th>Подробности</th></tr>
${rows
  .map(
    (r) =>
      `<tr><td>${escape(r.file)}</td><td class="n">${r.sizeKb}</td><td><span class="tag" style="background:${colour[r.outcome]}">${label[r.outcome]}</span></td><td class="n">${r.seconds}</td><td>${escape(r.reason)}</td></tr>`,
  )
  .join('\n')}
</table></body></html>`;
  const htmlPath = path.join(logs, `model-check-${tag}.html`);
  fs.writeFileSync(htmlPath, html);
  return { csvPath, htmlPath };
}

async function main() {
  console.log(`\n  Проверка моделей SOLIDWORKS\n  Папка: ${folder}\n`);
  if (!fs.existsSync(folder)) {
    console.log(`  ОШИБКА: папка не найдена: ${folder}\n  Укажите папку: Check-All-Models.bat "D:\\путь\\к\\моделям"`);
    return 2;
  }
  let capabilities;
  try {
    capabilities = await (await fetch(`${api}/api/v1/capabilities`)).json();
  } catch {
    console.log('  ОШИБКА: DocuView не запущен. Сначала запустите Start-DocuView.bat, затем эту проверку.');
    return 2;
  }

  const files = findModels(folder);
  if (files.length === 0) {
    console.log('  В папке нет файлов .SLDPRT.');
    return 2;
  }

  const rows = [];
  for (const [index, file] of files.entries()) {
    const size = fs.statSync(file).size;
    const name = path.relative(folder, file);
    const started = Date.now();
    let row;
    if (size === 0) {
      row = { outcome: 'empty', reason: 'файл пустой (0 байт) — модели в нём нет' };
    } else {
      try {
        row = classify(await waitForJob(await upload(file)));
      } catch (err) {
        row = { outcome: 'error', reason: err instanceof Error ? err.message : String(err) };
      }
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    rows.push({ file: name, sizeKb: Math.round(size / 1024), seconds, ...row });
    const mark = { '3d': ' 3D  ', 'no-3d': 'без3D', error: 'ОШИБ ', empty: 'пуст ' }[row.outcome];
    console.log(`  [${String(index + 1).padStart(4)}/${files.length}] ${mark} ${seconds.padStart(6)} с  ${name}`);
  }

  const real = rows.filter((r) => r.outcome !== 'empty');
  const ok = real.filter((r) => r.outcome === '3d').length;
  const times = real.map((r) => Number(r.seconds));
  const summary = {
    folder,
    real: real.length,
    ok,
    empty: rows.length - real.length,
    percent: real.length ? ((100 * ok) / real.length).toFixed(1) : '0',
    avg: times.length ? (times.reduce((a, b) => a + b, 0) / times.length).toFixed(1) : '0',
    all: ok === real.length,
  };
  const { htmlPath, csvPath } = writeReports(rows, summary);

  console.log(`\n  ИТОГ: ${ok} из ${real.length} моделей открыты в 3D (${summary.percent}%)${summary.empty ? `, пустых файлов: ${summary.empty}` : ''}`);
  for (const r of real.filter((x) => x.outcome !== '3d')) console.log(`    - ${r.file}: ${r.reason}`);
  console.log(`\n  Отчёт: ${htmlPath}\n         ${csvPath}\n`);

  if (process.platform === 'win32') {
    spawn('rundll32', ['url.dll,FileProtocolHandler', htmlPath], { detached: true, stdio: 'ignore' }).unref();
  }
  return summary.all ? 0 : 1;
}

main().then((code) => process.exit(code));
