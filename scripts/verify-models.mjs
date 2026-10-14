#!/usr/bin/env node
/**
 * Proof, on the machine that matters, that every SOLIDWORKS model opens in 3D
 * — with no CAD installed anywhere.
 *
 *   node scripts/verify-models.mjs [folder] [--assemblies] [--api http://127.0.0.1:4000] [--no-open]
 *
 * Sends every .SLDPRT under the folder (and with --assemblies every .SLDASM)
 * through the running DocuView exactly as the browser does — upload, wait for
 * the job — and records whether it came back as real 3D geometry. Writes an
 * HTML and a CSV report to logs/ and exits 0 only if every non-empty model did.
 *
 * An assembly counts as 3D when every part it places was found — beside it
 * first, then anywhere under the folder — and opens in 3D itself, or when its
 * parts are saved inside it. Its parts are sent as components of the assembly —
 * the viewer's own path — and where they land is checked against the extent
 * SolidWorks recorded for it.
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
  // Parts first, then assemblies: the report reads parts before what uses them.
  const isAssembly = (file) => /\.sldasm$/i.test(file);
  return found.sort((a, b) => Number(isAssembly(a)) - Number(isAssembly(b)) || a.localeCompare(b));
}

/** Every part file under the folder, by lower-case name. */
function indexParts(dir) {
  const index = new Map();
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.sldprt$/i.test(entry.name) && !entry.name.startsWith('~$')) {
        const key = entry.name.toLowerCase();
        index.set(key, [...(index.get(key) ?? []), full]);
      }
    }
  };
  walk(dir);
  return index;
}

/**
 * The copy of a part the assembly means: first the place SolidWorks recorded
 * for it, walked from where the assembly is now (a library beside the
 * projects stays beside them); then the copy nearest the assembly.
 */
function locate(index, name, assembly, recorded) {
  if (recorded?.part && recorded.assembly) {
    const way = path.win32.relative(path.win32.dirname(recorded.assembly), path.win32.dirname(recorded.part));
    if (!path.win32.isAbsolute(way)) {
      const expected = path.resolve(path.dirname(assembly), way, name);
      if (fs.existsSync(expected)) return expected;
    }
  }
  const candidates = index.get(name.toLowerCase());
  if (!candidates) return null;
  const home = path.dirname(assembly).toLowerCase().split(path.sep);
  const shared = (file) => {
    const parts = path.dirname(file).toLowerCase().split(path.sep);
    let n = 0;
    while (n < parts.length && n < home.length && parts[n] === home[n]) n += 1;
    return n * 1000 - parts.length;
  };
  return [...candidates].sort((a, b) => shared(b) - shared(a))[0];
}

async function upload(file, to = '/api/v1/uploads') {
  const data = await fs.promises.readFile(file);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const form = new FormData();
    form.append('file', new Blob([data]), path.basename(file));
    const response = await fetch(`${api}${to}`, { method: 'POST', body: form });
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
    // Most parts are ready in a fraction of a second; a slow poll would be
    // most of the run.
    await sleep(200);
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
    const via =
      result.meta?.convertedVia === 'server converter'
        ? 'через внешний конвертер'
        : result.meta?.staleDisplayMesh
          ? 'построено из точной геометрии (Parasolid): сетка в файле от прежнего состояния детали'
          : result.meta?.meshSource === 'b-rep'
            ? 'построено из точной геометрии (Parasolid)'
            : 'прочитано из файла';
    return { outcome: '3d', reason: `${via}${faces ? `, граней ${faces}` : ''}${triangles ? `, треугольников ${triangles}` : ''}` };
  }
  if (result.meta?.emptyModel) return { outcome: 'empty', reason: 'деталь пустая — в ней нет ни одного тела' };
  return { outcome: 'no-3d', reason: (result.warnings ?? [])[0] ?? 'открыт без 3D-геометрии' };
}

const getJson = async (url) => {
  const response = await fetch(url.startsWith('http') ? url : `${api}${url}`);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
};

/** Extent of a prepared model, from its manifest: [minX, minY, minZ, maxX, maxY, maxZ]. */
async function manifestBox(url) {
  const box = (await getJson(url)).bbox;
  return box ? [...box.min, ...box.max] : null;
}

/**
 * Where the viewer puts every occurrence, checked the way the viewer does it:
 * the same placements, the same part geometry — in the configuration the
 * assembly uses — and the extent that makes compared with the one SolidWorks
 * wrote into the assembly. That extent is SolidWorks' own and can include
 * hidden components, so a difference is reported, not failed.
 */
async function checkPlacement(job, components) {
  const document = await getJson(job.result.source);
  const placements = document.placements ?? [];
  const boxes = new Map();
  for (const [name, result] of components) {
    const main = await manifestBox(result.source);
    const perConfiguration = {};
    for (const [configuration, url] of Object.entries(result.meta?.configurations ?? {})) {
      if (typeof url === 'string') perConfiguration[configuration] = await manifestBox(url);
    }
    boxes.set(name.toLowerCase(), { main, perConfiguration, unavailable: result.meta?.unavailableConfigurations ?? [] });
  }
  const extent = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const grow = (box, m) => {
    for (const x of [box[0], box[3]]) for (const y of [box[1], box[4]]) for (const z of [box[2], box[5]]) {
      const p = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
      for (let a = 0; a < 3; a += 1) {
        extent[a] = Math.min(extent[a], p[a]);
        extent[a + 3] = Math.max(extent[a + 3], p[a]);
      }
    }
  };
  let placed = 0;
  let inConfiguration = 0;
  for (const placement of placements) {
    const entry = boxes.get(placement.component.toLowerCase());
    const box = entry ? entry.perConfiguration[placement.configuration] ?? entry.main : null;
    if (!box) continue;
    if (entry.perConfiguration[placement.configuration]) inConfiguration += 1;
    placed += 1;
    grow(box, placement.matrix);
  }
  if (document.geometry3d) {
    const inside = await manifestBox(document.geometry3d);
    if (inside) grow(inside, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  }
  const unavailable = [...boxes.values()].reduce((n, e) => n + e.unavailable.length, 0);
  const sw = job.result.meta?.boundingBoxMm;
  let deviation = null;
  if (Array.isArray(sw) && sw.length === 6 && Number.isFinite(extent[0])) {
    const diagonal = Math.hypot(sw[3] - sw[0], sw[4] - sw[1], sw[5] - sw[2]) || 1;
    deviation = Math.max(...extent.map((v, i) => Math.abs(v - sw[i]))) / diagonal;
  }
  return { placed, total: placements.length, inConfiguration, unavailable, deviation };
}

/** An assembly: are all the parts it places found, do they open in 3D, and do they land where they belong? */
async function classifyAssembly(job, file, index) {
  if (job.status === 'failed') return { outcome: 'error', reason: job.error?.message ?? 'processing failed' };
  const meta = job.result?.meta ?? {};
  if (typeof meta.instances !== 'number') return { outcome: 'no-3d', reason: 'в сборке не найдено дерево компонентов' };
  if (meta.instances === 0) return { outcome: 'empty', reason: 'сборка пустая — в ней нет ни одной видимой детали' };
  const names = Array.isArray(meta.componentNames) ? meta.componentNames : [];
  const missing = [];
  const broken = [];
  const ready = new Map();
  // Sent as components of this assembly — the viewer's own path, which also
  // builds each part in the configuration the assembly uses.
  for (const name of names) {
    const found = locate(index, name, file, {
      assembly: meta.originalPath,
      part: meta.referencedPaths?.[name.toLowerCase()],
    });
    if (!found) {
      missing.push(name);
      continue;
    }
    let part;
    try {
      const component = await waitForJob(await upload(found, `/api/v1/jobs/${job.id}/components`));
      part = classify(component);
      if (component.status === 'succeeded' && part.outcome === '3d') ready.set(name, component.result);
    } catch (err) {
      part = { outcome: 'error', reason: err instanceof Error ? err.message : String(err) };
    }
    if (part.outcome !== '3d' && part.outcome !== 'empty') broken.push(name);
  }
  let check = null;
  try {
    check = await checkPlacement(job, ready);
  } catch {
    check = null;
  }
  const inside = meta.instancesInside ?? 0;
  const where = check
    ? `на местах ${check.placed + inside} из ${check.total + inside} вхождений${inside ? ` (${inside} сохранены внутри сборки)` : ''}${check.inConfiguration ? `, в своей конфигурации: ${check.inConfiguration}` : ''}${check.unavailable ? `, конфигураций нет в файле детали: ${check.unavailable}` : ''}`
    : `${meta.instances} вхождений`;
  const extent =
    check?.deviation === null || check?.deviation === undefined
      ? ''
      : check.deviation < 0.02
        ? '; габарит совпадает с записанным в сборке'
        : `; габарит отличается от записанного в сборке на ${(check.deviation * 100).toFixed(1)}% диагонали`;
  const extentOk = check?.deviation === null || check?.deviation === undefined ? null : check.deviation < 0.02;
  const placed = `сборка: ${where}, файлов деталей ${names.length}${extent}`;
  if (missing.length === 0 && broken.length === 0) return { outcome: '3d', reason: placed, extentOk };
  const list = (items) => `${items.slice(0, 5).join(', ')}${items.length > 5 ? ` и ещё ${items.length - 5}` : ''}`;
  return {
    outcome: 'partial',
    reason: [
      missing.length ? `не найдено файлов деталей: ${missing.length} из ${names.length} (${list(missing)})` : '',
      broken.length ? `не открылись: ${list(broken)}` : '',
    ]
      .filter(Boolean)
      .join('; '),
  };
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

  const label = { '3d': '3D', 'no-3d': 'без 3D', error: 'ошибка', empty: 'пусто', partial: 'частично' };
  const colour = { '3d': '#1f8a4c', 'no-3d': '#b7791f', error: '#c53030', empty: '#718096', partial: '#d69e2e' };
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
<p>${summary.fromBrep ? `Из них построено из точной геометрии (в файле не было готовой сетки или она от прежнего состояния детали): ${summary.fromBrep}${summary.stale ? `, из них с устаревшей сеткой: ${summary.stale}` : ''}. ` : ''}${summary.empty ? `Пустых — модели в них нет (файл 0 байт или деталь без единого тела): ${summary.empty}. ` : ''}Среднее время: ${summary.avg} с на модель.</p>
${summary.assemblies ? `<div class="big" style="font-size:24px;color:${summary.assembliesOk === summary.assemblies ? '#1f8a4c' : '#b7791f'}">Сборки: ${summary.assembliesOk} из ${summary.assemblies} собраны целиком</div><p>Сборка считается собранной, когда все её детали найдены в папке и открываются в 3D. ${summary.assembliesPartial ? `Частично — не хватает файлов деталей: ${summary.assembliesPartial}.` : ''}${summary.extentChecked ? ` Габарит расстановки совпал с записанным в сборке у ${summary.extentOk} из ${summary.extentChecked} (SolidWorks хранит габарит с учётом скрытых компонентов, поэтому расхождение — повод посмотреть, а не ошибка).` : ''}</p>` : ''}
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
  const partIndex = withAssemblies ? indexParts(folder) : new Map();
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
        const job = await waitForJob(await upload(file));
        row = /\.sldasm$/i.test(file) ? await classifyAssembly(job, file, partIndex) : classify(job);
      } catch (err) {
        row = { outcome: 'error', reason: err instanceof Error ? err.message : String(err) };
      }
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    rows.push({ file: name, sizeKb: Math.round(size / 1024), seconds, kind: /\.sldasm$/i.test(file) ? 'assembly' : 'part', ...row });
    const mark = { '3d': ' 3D  ', 'no-3d': 'без3D', error: 'ОШИБ ', empty: 'пуст ', partial: 'част ' }[row.outcome];
    console.log(`  [${String(index + 1).padStart(4)}/${files.length}] ${mark} ${seconds.padStart(6)} с  ${name}`);
  }

  const assemblies = rows.filter((r) => r.kind === 'assembly' && r.outcome !== 'empty');
  const real = rows.filter((r) => r.kind !== 'assembly' && r.outcome !== 'empty');
  const ok = real.filter((r) => r.outcome === '3d').length;
  const times = real.map((r) => Number(r.seconds));
  const summary = {
    folder,
    real: real.length,
    ok,
    empty: rows.filter((r) => r.kind !== 'assembly').length - real.length,
    percent: real.length ? ((100 * ok) / real.length).toFixed(1) : '0',
    avg: times.length ? (times.reduce((a, b) => a + b, 0) / times.length).toFixed(1) : '0',
    all: ok === real.length,
    fromBrep: real.filter((r) => r.reason.startsWith('построено')).length,
    stale: real.filter((r) => r.reason.includes('от прежнего состояния')).length,
    assemblies: assemblies.length,
    assembliesOk: assemblies.filter((r) => r.outcome === '3d').length,
    assembliesPartial: assemblies.filter((r) => r.outcome === 'partial').length,
    extentChecked: assemblies.filter((r) => r.extentOk !== null && r.extentOk !== undefined).length,
    extentOk: assemblies.filter((r) => r.extentOk === true).length,
  };
  const { htmlPath, csvPath } = writeReports(rows, summary);

  console.log(`\n  ИТОГ: ${ok} из ${real.length} моделей открыты в 3D (${summary.percent}%)${summary.fromBrep ? `, из них построено из точной геометрии: ${summary.fromBrep}${summary.stale ? ` (сетка в файле устарела: ${summary.stale})` : ''}` : ''}${summary.empty ? `, пустых: ${summary.empty}` : ''}`);
  for (const r of real.filter((x) => x.outcome !== '3d')) console.log(`    - ${r.file}: ${r.reason}`);
  if (summary.assemblies) {
    console.log(`\n  СБОРКИ: ${summary.assembliesOk} из ${summary.assemblies} собраны целиком (все детали найдены и на местах)${summary.assembliesPartial ? `, частично: ${summary.assembliesPartial}` : ''}`);
    for (const r of assemblies.filter((x) => x.outcome !== '3d').slice(0, 30)) console.log(`    - ${r.file}: ${r.reason}`);
    if (summary.extentChecked) {
      console.log(`\n  РАССТАНОВКА: у ${summary.extentOk} из ${summary.extentChecked} собранных сборок габарит совпал с записанным в файле SolidWorks (допуск 2% диагонали)`);
      for (const r of assemblies.filter((x) => x.extentOk === false).slice(0, 30)) console.log(`    - ${r.file}: ${r.reason}`);
    }
  }
  console.log(`\n  Отчёт: ${htmlPath}\n         ${csvPath}\n`);

  if (process.platform === 'win32' && !argv.includes('--no-open')) {
    spawn('rundll32', ['url.dll,FileProtocolHandler', htmlPath], { detached: true, stdio: 'ignore' }).unref();
  }
  return summary.all && assemblies.every((r) => r.outcome !== 'error') ? 0 : 1;
}

main().then((code) => process.exit(code));
