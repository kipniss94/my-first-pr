#!/usr/bin/env node
/**
 * DocuView launcher — what Start-DocuView.bat and Stop-DocuView.bat run.
 *
 *   node tools/launcher.mjs              start (or just open the browser if running)
 *   node tools/launcher.mjs --stop       stop everything it started
 *   node tools/launcher.mjs --no-browser start without opening a browser
 *
 * In order: dependencies (only when package-lock.json changed), a production
 * build (only when the sources changed), then the API and the web app in the
 * background, and the browser once both actually answer.
 *
 * No CAD is needed on this machine or any other: SolidWorks parts are read
 * straight from the file, in DocuView's own code.
 *
 * Written for Node rather than PowerShell on purpose: Windows blocks
 * PowerShell scripts by default, and working around that would mean weakening
 * a protection the user has switched on. Node is needed anyway. The same file
 * runs on Linux and macOS.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logs = path.join(root, 'logs');
const stateFile = path.join(logs, 'running.json');
const stampFile = path.join(root, '.build-stamp');
const WEB_PORT = 3000;
const API_PORT = 4000;
/** Next.js listens here, on loopback only; the gateway in front serves WEB_PORT. */
const WEB_INTERNAL_PORT = 3001;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const MIN_NODE = [20, 11];
const isWindows = process.platform === 'win32';

const args = new Set(process.argv.slice(2));
const argValue = (name) => {
  const all = process.argv.slice(2);
  const at = all.indexOf(name);
  return at >= 0 ? all[at + 1] : undefined;
};

/**
 * Who may reach DocuView:
 *   default   this computer, the local network, and a public internet link
 *   --lan     this computer and the local network, no internet link
 *   --local   this computer only
 * Anything beyond this computer asks for the access code.
 */
const SHARE_LAN = !args.has('--local');
const SHARE_INTERNET = SHARE_LAN && !args.has('--lan');
const codeFile = path.join(root, '.access-code');
const toolsBin = path.join(root, 'tools', 'bin');

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

function openBrowser(url = WEB_URL) {
  const [command, argv] = isWindows
    ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
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

function stopAll() {
  const state = readState();
  if (state) for (const pid of [state.api, state.web, state.gateway, state.tunnel]) killTree(pid);
  fs.rmSync(stateFile, { force: true });
}

/* ----------------------------------------------------------- sharing ----- */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * The access code: eight characters, kept in .access-code so phones that
 * signed in once stay signed in across restarts. Delete the file to issue a
 * new one and sign every device out.
 */
function accessCode() {
  try {
    const saved = fs.readFileSync(codeFile, 'utf8').trim().toUpperCase();
    if (/^[A-Z0-9]{8}$/.test(saved)) return saved;
  } catch {
    // first run
  }
  const code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  fs.writeFileSync(codeFile, code);
  return code;
}

const showCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

/** Addresses other devices on the same network can use. */
function lanAddresses() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || entry.address.startsWith('169.254.')) continue;
      // Virtual adapters (Hyper-V, WSL, VPN clients) are rarely what a phone can reach.
      const virtual = /vethernet|wsl|hyper-v|virtualbox|vmware|docker|vpn|tap|tun/i.test(name);
      found.push({ url: `http://${entry.address}:${WEB_PORT}`, virtual });
    }
  }
  return found.sort((a, b) => Number(a.virtual) - Number(b.virtual)).map((entry) => entry.url);
}

/** Cloudflare's tunnel client: from PATH, from tools/bin, or downloaded once. */
async function findCloudflared() {
  const testBinary = argValue('--tunnel-bin');
  if (testBinary) return path.resolve(testBinary);
  const exe = isWindows ? 'cloudflared.exe' : 'cloudflared';
  const local = path.join(toolsBin, exe);
  if (fs.existsSync(local)) return local;
  const which = spawnSync(isWindows ? 'where' : 'which', ['cloudflared'], { encoding: 'utf8', windowsHide: true });
  const onPath = which.status === 0 ? which.stdout.split(/\r?\n/)[0].trim() : '';
  if (onPath) return onPath;

  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : '386';
  const asset = isWindows ? `cloudflared-windows-${arch === 'arm64' ? 'amd64' : arch}.exe` : process.platform === 'linux' ? `cloudflared-linux-${arch}` : null;
  if (!asset) return null;
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  say(`   Скачиваю cloudflared (официальный клиент Cloudflare, один раз, ~60 МБ)...`);
  say(dim(`   ${url}`));
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    fs.mkdirSync(toolsBin, { recursive: true });
    const partial = `${local}.part`;
    fs.writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
    fs.renameSync(partial, local);
    if (!isWindows) fs.chmodSync(local, 0o755);
    return local;
  } catch (err) {
    warn(`Не удалось скачать cloudflared: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * A public https address for this computer, through a Cloudflare quick tunnel.
 * No account is needed; the address changes on every start. A fixed address
 * comes with hosting DocuView on its own server.
 */
async function startTunnel() {
  const binary = await findCloudflared();
  if (!binary) return null;
  const tag = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const logPath = path.join(logs, `tunnel-${tag}.log`);
  const log = fs.createWriteStream(logPath);
  const [command, argv] = /\.(mjs|js)$/.test(binary)
    ? [process.execPath, [binary]]
    : [binary, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${WEB_PORT}`]];
  // Shares this window's console, like the servers: closing the window ends it.
  const child = spawn(command, argv, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(url ? { url, pid: child.pid, log: logPath } : null);
    };
    const take = (chunk) => {
      log.write(chunk);
      const match = /https:\/\/[-a-z0-9]+\.trycloudflare\.com/.exec(chunk.toString('utf8'));
      if (match) finish(match[0]);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    const timer = setTimeout(() => {
      killTree(child.pid);
      finish(null);
    }, 60_000);
  });
}

async function printQr(text) {
  try {
    const { default: QRCode } = await import('qrcode');
    const art = await QRCode.toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'L' });
    for (const line of art.split('\n')) say(`    ${line}`);
  } catch {
    // no QR, the address is printed anyway
  }
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

async function freePorts() {
  const busy = async () =>
    (await answers(`http://127.0.0.1:${API_PORT}/healthz`)) ||
    (await answers(WEB_URL)) ||
    (await answers(`http://127.0.0.1:${WEB_INTERNAL_PORT}`));
  if (!(await busy())) return;
  // Left over from an earlier run whose window was closed: ours to stop.
  const state = readState();
  if (state && (alive(state.api) || alive(state.web))) {
    warn('Остался прошлый запуск — останавливаю его.');
    stopAll();
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

async function startServers(code) {
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
    PROCESSING_TIMEOUT_SECONDS: '600',
    // Dropping a folder of parts at once is normal here. Still a limit.
    RATE_LIMIT_UPLOADS: '120',
    NEXT_TELEMETRY_DISABLED: '1',
    // Set only when DocuView is reachable from other devices.
    DOCUVIEW_ACCESS_CODE: code ?? '',
  };

  const tag = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  for (const old of fs.readdirSync(logs).filter((name) => /^(api|web|gateway|tunnel)-\d/.test(name)).sort().slice(0, -10)) {
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
    [path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(WEB_INTERNAL_PORT), '-H', '127.0.0.1'],
    { cwd: path.join(root, 'apps', 'web'), env, stdio: ['ignore', fs.openSync(webLog, 'a'), fs.openSync(webLog, 'a')] },
  );

  // The front door: /api to the API, the rest to the web app, as plain streams
  // (Next's own proxy cuts uploads off at 10 MB). Only this one listens beyond
  // loopback, and only when DocuView is shared.
  const gatewayLog = path.join(logs, `gateway-${tag}.log`);
  const gateway = spawn(process.execPath, [path.join(root, 'scripts', 'gateway.mjs')], {
    cwd: root,
    env: {
      ...env,
      GATEWAY_PORT: String(WEB_PORT),
      GATEWAY_HOST: SHARE_LAN ? '0.0.0.0' : '127.0.0.1',
      WEB_INTERNAL_PORT: String(WEB_INTERNAL_PORT),
    },
    stdio: ['ignore', fs.openSync(gatewayLog, 'a'), fs.openSync(gatewayLog, 'a')],
  });

  fs.writeFileSync(
    stateFile,
    JSON.stringify({ api: api.pid, web: web.pid, gateway: gateway.pid, started: new Date().toISOString() }, null, 2),
  );

  let exited = null;
  api.on('exit', (code) => (exited ??= { name: 'API', code, log: apiLog }));
  web.on('exit', (code) => (exited ??= { name: 'Веб-часть', code, log: webLog }));
  gateway.on('exit', (code) => (exited ??= { name: 'Шлюз', code, log: gatewayLog }));

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

/** A link that signs the browser in with the code, then opens DocuView. */
function signInUrl(base, code) {
  return code ? `${base}/access/verify?code=${code}` : base;
}

async function printAddresses(code, publicUrl) {
  const lan = lanAddresses();
  say(`  На этом компьютере:       ${bold(WEB_URL)}`);
  if (publicUrl) say(`  С любого устройства:      ${bold(publicUrl)}`);
  if (lan.length) say(`  В той же сети (Wi-Fi):    ${bold(lan[0])}${lan.length > 1 ? dim(`  (или ${lan.slice(1).join(', ')})`) : ''}`);
  say(`  Код доступа:              ${bold(showCode(code))}`);
  const target = publicUrl ?? lan[0];
  if (target) {
    say();
    say(dim('  Наведите камеру телефона на код — DocuView откроется сразу, без ввода кода:'));
    await printQr(signInUrl(target, code));
  }
  if (lan.length && isWindows) {
    say(dim('  Если Windows спросит про доступ Node.js к сети — нажмите «Разрешить» (частные сети).'));
  }
  if (publicUrl) {
    say(dim('  Публичная ссылка меняется при каждом запуске. Постоянный адрес — при размещении на сервере.'));
  }
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

  const running = readState();
  if ((await answers(`http://127.0.0.1:${API_PORT}/healthz`)) && (await answers(WEB_URL)) && running) {
    ok('DocuView уже работает — открываю браузер.');
    if (running.code) await printAddresses(running.code, running.publicUrl ?? null);
    if (!args.has('--no-browser')) openBrowser(signInUrl(WEB_URL, running.code));
    return 0;
  }
  await freePorts();

  step('Node.js');
  checkNode();
  step('Зависимости');
  await ensureDependencies();
  step('Сборка');
  await ensureBuild();
  step('Запуск');
  const code = SHARE_LAN ? accessCode() : null;
  const { getExited } = await startServers(code);

  let publicUrl = null;
  if (SHARE_INTERNET) {
    step('Ссылка для любого устройства');
    const tunnel = await startTunnel();
    if (tunnel) {
      publicUrl = tunnel.url;
      ok(publicUrl);
      const state = readState() ?? {};
      fs.writeFileSync(stateFile, JSON.stringify({ ...state, tunnel: tunnel.pid, publicUrl, code }, null, 2));
    } else {
      warn('Публичная ссылка не создалась (сеть могла заблокировать Cloudflare). Работает доступ по локальной сети.');
    }
  }
  if (code && !publicUrl) {
    const state = readState() ?? {};
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, code }, null, 2));
  }

  if (!args.has('--no-browser')) openBrowser(signInUrl(WEB_URL, code));

  say();
  say(green('  ============================================='));
  say(green('    DocuView работает'));
  say(green('  ============================================='));
  if (code) await printAddresses(code, publicUrl);
  else say(`  Адрес: ${WEB_URL}  (только этот компьютер)`);
  say();
  say('  Перетащите .SLDPRT, STEP, PDF, DOCX... в окно браузера. CAD для этого не нужен.');
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
