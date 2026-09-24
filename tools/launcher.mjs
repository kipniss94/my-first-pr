#!/usr/bin/env node
/**
 * DocuView launcher — what Start-DocuView.bat and Stop-DocuView.bat run.
 *
 *   node tools/launcher.mjs              start (or just open the browser if running)
 *   node tools/launcher.mjs --stop       stop everything it started
 *   node tools/launcher.mjs --no-browser start without opening a browser
 *
 * In order: dependencies (only when package-lock.json changed), a production
 * build (only when the sources changed), SOLIDWORKS (found, and its small COM
 * helper compiled, so every .SLDPRT opens as real 3D), then the API and the web
 * app in the background, and the browser once both actually answer.
 *
 * Written for Node rather than PowerShell on purpose: Windows blocks
 * PowerShell scripts by default, and working around that would mean weakening
 * a protection the user has switched on. Node is needed anyway.
 *
 * The same file runs on Linux and macOS; there it simply finds no SOLIDWORKS.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logs = path.join(root, 'logs');
const stateFile = path.join(logs, 'running.json');
const stampFile = path.join(root, '.build-stamp');
const swDir = path.join(root, 'tools', 'solidworks');
const swHelper = path.join(swDir, 'bin', 'sw-convert.exe');
const swMarker = path.join(logs, 'solidworks-started-by-docuview.txt');
const WEB_PORT = 3000;
const API_PORT = 4000;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const MIN_NODE = [20, 11];
const isWindows = process.platform === 'win32';

const args = new Set(process.argv.slice(2));
const argValue = (name) => {
  const all = process.argv.slice(2);
  const at = all.indexOf(name);
  return at >= 0 ? all[at + 1] : undefined;
};

fs.mkdirSync(logs, { recursive: true });

/* ------------------------------------------------------------------ output */

const paint = (code) => (text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const cyan = paint('36');
const green = paint('32');
const yellow = paint('33');
const red = paint('31');
const dim = paint('90');
const bold = paint('1');

const say = (text = '') => console.log(text);
const step = (text) => say(`\n${cyan('>> ' + text)}`);
const ok = (text) => say(green(`   [OK] ${text}`));
const warn = (text) => say(yellow(`   [!]  ${text}`));

class Stop extends Error {}

function die(text, hints = []) {
  say();
  say(red(`   ОШИБКА: ${text}`));
  for (const hint of hints) say(yellow(`   - ${hint}`));
  say(dim(`   Логи: ${logs}`));
  throw new Stop(text);
}

function tail(file, lines = 25) {
  try {
    const text = fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-lines);
    say(dim(`   --- ${path.basename(file)} ---`));
    for (const line of text) say(dim(`   ${line}`));
  } catch {
    // no log yet
  }
}

/* ----------------------------------------------------------------- helpers */

async function answers(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(pid) {
  if (!alive(pid)) return;
  if (isWindows) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

function openBrowser() {
  const [command, argv] = isWindows
    ? ['rundll32', ['url.dll,FileProtocolHandler', WEB_URL]]
    : process.platform === 'darwin'
      ? ['open', [WEB_URL]]
      : ['xdg-open', [WEB_URL]];
  try {
    spawn(command, argv, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
  } catch {
    // no browser available (a server, a test run): the address is printed anyway
  }
}

/** Who holds a port, on Windows — so an error can name the program. */
function portOwner(port) {
  if (!isWindows) return null;
  const netstat = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
  const line = netstat.split(/\r?\n/).find((row) => new RegExp(`:${port}\\s+\\S+\\s+LISTENING`, 'i').test(row));
  const pid = line?.trim().split(/\s+/).pop();
  if (!pid) return null;
  const task = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
  return { pid: Number(pid), name: task.split(',')[0]?.replace(/"/g, '') || 'неизвестная программа' };
}

/**
 * A long command (npm install, the build): full output to a log, and in the
 * window a seconds counter with the latest line, so it is visibly alive.
 */
function runLogged(command, logName) {
  const logPath = path.join(logs, logName);
  const log = fs.createWriteStream(logPath);
  log.write(`[${new Date().toISOString()}] ${command}\n`);
  const started = Date.now();
  let last = '';
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: root, shell: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = (chunk) => {
      log.write(chunk);
      const lines = chunk.toString('utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length) last = lines[lines.length - 1];
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setInterval(() => {
      if (!process.stdout.isTTY) return;
      const seconds = String(Math.round((Date.now() - started) / 1000)).padStart(4);
      process.stdout.write(`\r   ${seconds} с  ${last.replace(/\s+/g, ' ').slice(0, 66).padEnd(66)}`);
    }, 1000);
    child.on('close', (code) => {
      clearInterval(timer);
      log.end();
      const seconds = Math.round((Date.now() - started) / 1000);
      if (process.stdout.isTTY) process.stdout.write(`\r   ${String(seconds).padStart(4)} с  ${'готово'.padEnd(66)}\n`);
      if (code !== 0) tail(logPath, 30);
      resolve(code === 0);
    });
  });
}

/* ------------------------------------------------------------------- state */

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

function stopAll({ quitSolidWorks = true } = {}) {
  const state = readState();
  if (state) for (const pid of [state.api, state.web, state.keeper]) killTree(pid);
  if (quitSolidWorks && isWindows && fs.existsSync(swHelper) && fs.existsSync(swMarker)) {
    // Closes only a SOLIDWORKS this launcher started hidden — never one the
    // user opened themselves.
    spawnSync(swHelper, ['quit', swMarker], { stdio: 'ignore', windowsHide: true, timeout: 30000 });
  }
  fs.rmSync(stateFile, { force: true });
}

/* ------------------------------------------------------------------- steps */

function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    die(`Установлен Node.js ${process.versions.node}, нужен ${MIN_NODE.join('.')} или новее.`, [
      'Скачайте LTS-версию с https://nodejs.org и установите поверх.',
    ]);
  }
  ok(`Node.js ${process.versions.node}`);
}

async function ensureDependencies() {
  const lock = fs.readFileSync(path.join(root, 'package-lock.json'));
  const hash = createHash('sha256').update(lock).digest('hex');
  const hashFile = path.join(root, 'node_modules', '.docuview-lock-hash');
  const current =
    fs.existsSync(path.join(root, 'node_modules', '.package-lock.json')) &&
    fs.existsSync(hashFile) &&
    fs.readFileSync(hashFile, 'utf8').trim() === hash;
  if (!current) {
    say('   Устанавливаю (первый раз 2-5 минут, нужен интернет)...');
    if (!(await runLogged('npm install --no-audit --no-fund', 'install.log'))) {
      die('npm install завершился с ошибкой.', [
        'Проверьте подключение к интернету.',
        'Если повторяется — удалите папку node_modules и запустите снова.',
      ]);
    }
    fs.writeFileSync(hashFile, hash);
  }
  ok('Зависимости на месте');
}

function sourceStamp() {
  let newest = 0;
  let count = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        count += 1;
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      }
    }
  };
  for (const dir of ['apps/api/src', 'apps/web/src', 'apps/web/public', 'packages/shared/src']) walk(path.join(root, dir));
  for (const file of ['package-lock.json', 'apps/web/next.config.ts', 'apps/web/package.json', 'apps/api/package.json']) {
    try {
      newest = Math.max(newest, fs.statSync(path.join(root, file)).mtimeMs);
      count += 1;
    } catch {
      // optional
    }
  }
  return `${Math.round(newest)}|${count}`;
}

async function ensureBuild() {
  const stamp = sourceStamp();
  const outputs = ['packages/shared/dist/index.js', 'apps/api/dist/index.js', 'apps/web/.next/BUILD_ID'];
  const built = outputs.every((file) => fs.existsSync(path.join(root, file)));
  const current = built && fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8').trim() === stamp;
  if (!current) {
    say('   Собираю production-версию (1-3 минуты)...');
    process.env.NEXT_TELEMETRY_DISABLED = '1';
    if (!(await runLogged('npm run build', 'build.log'))) {
      die('Сборка завершилась с ошибкой.', ['Подробности выше и в logs\\build.log.']);
    }
    // Taken again after the build, not before: the build itself writes into a
    // watched folder (it copies the PDF worker into apps/web/public), and a
    // fingerprint from before it would make every later start rebuild.
    fs.writeFileSync(stampFile, sourceStamp());
  }
  ok('Сборка актуальна');
}

/** The C# compiler that ships with Windows as part of .NET Framework 4.x. */
function findCsc() {
  const windir = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows';
  for (const framework of ['Framework64', 'Framework']) {
    const candidate = path.join(windir, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findSolidWorksExe() {
  const candidates = [
    'C:\\Program Files\\SOLIDWORKS Corp\\SOLIDWORKS (3)\\SLDWORKS.exe',
    'C:\\Program Files\\SOLIDWORKS Corp\\SOLIDWORKS\\SLDWORKS.exe',
  ];
  for (let year = new Date().getFullYear() + 1; year >= 2018; year -= 1) {
    const query = spawnSync('reg', ['query', `HKLM\\SOFTWARE\\SolidWorks\\SOLIDWORKS ${year}\\Setup`, '/v', 'SolidWorks Folder'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const folder = /SolidWorks Folder\s+REG_SZ\s+(.+)/i.exec(query.stdout ?? '')?.[1]?.trim();
    if (folder) candidates.push(path.join(folder, 'SLDWORKS.exe'));
  }
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

/**
 * Returns the CAD_CONVERTER_CMD to use, or '' to run without SOLIDWORKS.
 * `--sw-helper <script>` substitutes a stand-in, for testing without SOLIDWORKS.
 */
async function setupSolidWorks() {
  const convert = path.join(swDir, 'convert.mjs');
  const quote = (value) => `"${value}"`;
  const testHelper = argValue('--sw-helper');
  if (testHelper) {
    warn(`Тестовый режим: вместо SOLIDWORKS — ${testHelper}`);
    return `${quote(process.execPath)} ${quote(convert)} {input} {output} {informat} --helper ${quote(path.resolve(testHelper))}`;
  }
  if (args.has('--no-solidworks') || process.env.DOCUVIEW_NO_SOLIDWORKS === '1') {
    warn('Отключён (--no-solidworks).');
    return '';
  }
  if (!isWindows) {
    warn('SOLIDWORKS бывает только на Windows — .SLDPRT откроются собственным чтением.');
    return '';
  }

  const registered = spawnSync('reg', ['query', 'HKCR\\SldWorks.Application'], { stdio: 'ignore', windowsHide: true }).status === 0;
  if (!registered) {
    warn('SOLIDWORKS не найден. .SLDPRT откроются собственным чтением — у части файлов без 3D.');
    return '';
  }
  const exe = findSolidWorksExe();
  ok(exe ? `Найден: ${exe}` : 'Найден (зарегистрирован в системе)');

  // Build the COM helper when it is missing or older than its source.
  const source = path.join(swDir, 'SwConvert.cs');
  const stale = !fs.existsSync(swHelper) || fs.statSync(swHelper).mtimeMs < fs.statSync(source).mtimeMs;
  if (stale) {
    const csc = findCsc();
    if (!csc) {
      warn('Не найден компилятор C# из .NET Framework 4 — без него SOLIDWORKS не подключить.');
      warn('Включите «.NET Framework 4.8» в «Компоненты Windows» и запустите снова.');
      return '';
    }
    fs.mkdirSync(path.dirname(swHelper), { recursive: true });
    const build = spawnSync(
      csc,
      ['/nologo', '/target:exe', '/optimize+', '/r:Microsoft.CSharp.dll', '/r:System.Core.dll', `/out:${swHelper}`, source],
      { encoding: 'utf8', windowsHide: true },
    );
    fs.writeFileSync(path.join(logs, 'helper-build.log'), `${build.stdout ?? ''}${build.stderr ?? ''}`);
    if (build.status !== 0 || !fs.existsSync(swHelper)) {
      tail(path.join(logs, 'helper-build.log'));
      warn('Не удалось собрать помощник SOLIDWORKS — продолжаю без него.');
      return '';
    }
    ok('Помощник SOLIDWORKS собран');
  }
  say(dim('   Модели SOLIDWORKS будут открываться полной 3D-геометрией.'));
  return `${quote(process.execPath)} ${quote(convert)} {input} {output} {informat}`;
}

async function freePorts() {
  const busy = async () => (await answers(`http://127.0.0.1:${API_PORT}/healthz`)) || (await answers(WEB_URL));
  if (!(await busy())) return;
  // Left over from an earlier run whose window was closed: ours to stop.
  const state = readState();
  if (state && (alive(state.api) || alive(state.web))) {
    warn('Остался прошлый запуск — останавливаю его.');
    stopAll({ quitSolidWorks: false });
    await sleep(1500);
  }
  if (await busy()) {
    const owner = portOwner(WEB_PORT) ?? portOwner(API_PORT);
    die(
      owner ? `Порт ${WEB_PORT} или ${API_PORT} занят: ${owner.name} (PID ${owner.pid}).` : `Порт ${WEB_PORT} или ${API_PORT} занят другой программой.`,
      ['Закройте её и запустите DocuView снова.'],
    );
  }
}

async function startServers(converter) {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    API_HOST: '127.0.0.1',
    API_PORT: String(API_PORT),
    API_INTERNAL_URL: `http://127.0.0.1:${API_PORT}`,
    PRETTY_LOGS: 'false',
    MAX_UPLOAD_MB: '1024',
    // A local, single-user tool: keep documents for a week, not an hour.
    RETENTION_MINUTES: '10080',
    // SOLIDWORKS needs time on big assemblies; the converter itself stops at 9 minutes.
    PROCESSING_TIMEOUT_SECONDS: '600',
    // Dropping a folder of parts at once is normal here. Still a limit.
    RATE_LIMIT_UPLOADS: '120',
    NEXT_TELEMETRY_DISABLED: '1',
    CAD_CONVERTER_CMD: converter,
  };

  const tag = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  for (const old of fs.readdirSync(logs).filter((name) => /^(api|web)-\d/.test(name)).sort().slice(0, -10)) {
    fs.rmSync(path.join(logs, old), { force: true });
  }
  const apiLog = path.join(logs, `api-${tag}.log`);
  const webLog = path.join(logs, `web-${tag}.log`);

  // Not detached and not hidden: both share this window's console, so closing
  // the window stops them, which is what anyone closing it expects.
  const api = spawn(process.execPath, [path.join(root, 'apps', 'api', 'dist', 'index.js')], {
    cwd: root,
    env,
    stdio: ['ignore', fs.openSync(apiLog, 'a'), fs.openSync(apiLog, 'a')],
  });
  const web = spawn(
    process.execPath,
    [path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(WEB_PORT), '-H', '127.0.0.1'],
    { cwd: path.join(root, 'apps', 'web'), env, stdio: ['ignore', fs.openSync(webLog, 'a'), fs.openSync(webLog, 'a')] },
  );

  let keeper = null;
  if (converter && isWindows && fs.existsSync(swHelper) && !argValue('--sw-helper')) {
    // Warm SOLIDWORKS up now rather than on the first model: a cold start is
    // 20-60 seconds. Detached, so it outlives this window and closes the
    // SOLIDWORKS it started a minute after the API is gone.
    keeper = spawn(swHelper, ['warmup', swMarker, String(API_PORT)], { detached: true, stdio: 'ignore', windowsHide: true });
    keeper.on('error', () => {});
    keeper.unref();
  }

  fs.writeFileSync(
    stateFile,
    JSON.stringify({ api: api.pid, web: web.pid, keeper: keeper?.pid ?? 0, started: new Date().toISOString() }, null, 2),
  );

  let exited = null;
  api.on('exit', (code) => (exited ??= { name: 'API', code, log: apiLog }));
  web.on('exit', (code) => (exited ??= { name: 'Веб-часть', code, log: webLog }));

  const deadline = Date.now() + 180_000;
  let apiUp = false;
  let webUp = false;
  while (Date.now() < deadline && !(apiUp && webUp)) {
    if (exited) {
      tail(exited.log);
      stopAll();
      die(`${exited.name} остановился при запуске (код ${exited.code}).`);
    }
    if (!apiUp && (await answers(`http://127.0.0.1:${API_PORT}/healthz`))) {
      apiUp = true;
      ok(`API      http://127.0.0.1:${API_PORT}`);
    }
    if (!webUp && (await answers(WEB_URL))) {
      webUp = true;
      ok(`Веб      ${WEB_URL}`);
    }
    if (!(apiUp && webUp)) await sleep(700);
  }
  if (!(apiUp && webUp)) {
    stopAll();
    die('Серверы не ответили за 3 минуты.', ['Посмотрите api-*.log и web-*.log в папке logs.']);
  }
  return { api, web, getExited: () => exited };
}

/* -------------------------------------------------------------------- main */

async function main() {
  say();
  say(cyan('  ============================================='));
  say(bold('    DocuView — просмотрщик CAD, PDF и Office'));
  say(cyan('  ============================================='));
  say(dim(`  Папка: ${root}`));

  if (args.has('--stop')) {
    step('Останавливаю DocuView');
    stopAll();
    ok('Остановлен.');
    return 0;
  }

  if ((await answers(`http://127.0.0.1:${API_PORT}/healthz`)) && (await answers(WEB_URL)) && readState()) {
    ok('DocuView уже работает — открываю браузер.');
    if (!args.has('--no-browser')) openBrowser();
    return 0;
  }
  await freePorts();

  step('Node.js');
  checkNode();
  step('Зависимости');
  await ensureDependencies();
  step('Сборка');
  await ensureBuild();
  step('SOLIDWORKS');
  const converter = await setupSolidWorks();
  step('Запуск');
  const { getExited } = await startServers(converter);

  if (!args.has('--no-browser')) openBrowser();

  say();
  say(green('  ============================================='));
  say(green(`    DocuView работает:  ${WEB_URL}`));
  say(green('  ============================================='));
  say('  Перетащите .SLDPRT, .SLDASM, STEP, PDF, DOCX... в окно браузера.');
  if (converter && isWindows) say(dim('  SOLIDWORKS прогревается в фоне — первая модель может открываться до минуты.'));
  say();
  say(bold('  O — открыть браузер ещё раз     S — остановить'));
  say(dim('  Окно можно свернуть. Закрыть окно — тоже остановить.'));

  return new Promise((resolve) => {
    let finished = false;
    const finish = (code, message) => {
      if (finished) return;
      finished = true;
      clearInterval(watch);
      if (message) warn(message);
      step('Останавливаю DocuView');
      stopAll();
      ok('Остановлен.');
      resolve(code);
    };
    const watch = setInterval(() => {
      const exited = getExited();
      if (exited) {
        tail(exited.log);
        finish(1, `${exited.name} неожиданно остановился.`);
      }
    }, 1000);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', (key) => {
        const k = key.toString('utf8').toLowerCase();
        // Also the same keys on a Russian layout: S is "ы", O is "щ".
        if (k === 's' || k === 'ы' || k === '\u0003') finish(0);
        else if (k === 'o' || k === 'щ') openBrowser();
      });
    }
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => finish(0));
  });
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    if (!(err instanceof Stop)) {
      say(red(`   ОШИБКА: ${err instanceof Error ? err.stack ?? err.message : String(err)}`));
    }
    process.exit(1);
  });
