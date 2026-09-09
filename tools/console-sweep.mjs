/**
 * tools/console-sweep.mjs - walk the app in a real browser and fail on console noise.
 *
 *   npm run sweep
 *
 * The jsdom suites cannot see this class of problem. Browsers write some
 * complaints themselves rather than throwing - "The AudioContext was not
 * allowed to start", "Blocked call to navigator.vibrate because user hasn't
 * tapped on the frame" - so no try/catch and no assertion in jsdom will ever
 * notice them. They only show up in a real engine, in a real console.
 *
 * So this drives headless Chrome over CDP, clicks through every screen, and
 * reports anything that lands in the console. Headless means no extensions,
 * which matters: a browser profile with a wallet extension installed fills the
 * console with `[PHANTOM]` and "Could not establish connection" noise that has
 * nothing to do with this app, and it is easy to lose a real error in it.
 *
 * Exits non-zero if anything was logged, so it can gate CI once a Chrome step
 * is available there.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8131;
const CDP_PORT = Number(process.env.CDP_PORT) || 9333;

const CHROME =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

/* ------------------------------------------------------------ static host */

const server = createServer(async (req, res) => {
  const path = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = join(root, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(PORT, r));

/* ------------------------------------------------------------- browser -- */

const profile = await mkdtemp(join(tmpdir(), 'mnm-sweep-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
], { stdio: 'ignore' });

const cleanup = async (code) => {
  chrome.kill();
  server.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(code);
};

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch {
      /* chrome still starting */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error(`Could not reach Chrome. Set CHROME_PATH if it is not at:\n  ${CHROME}`);
  await cleanup(1);
}

const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const noise = [];

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    noise.push(['exception', d.exception?.description || d.text]);
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    noise.push([msg.params.type, msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')]);
  }
  if (msg.method === 'Log.entryAdded' && ['error', 'warning'].includes(msg.params.entry.level)) {
    noise.push([msg.params.entry.level, `${msg.params.entry.text} ${msg.params.entry.url || ''}`.trim()]);
  }
});
await new Promise((r) => ws.addEventListener('open', r));

const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return `THREW: ${r.result.exceptionDetails.exception?.description || ''}`;
  return r.result?.result?.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });

await send('Page.navigate', { url: `http://localhost:${PORT}/index.html` });
await wait(2500);
await evaluate(`(async () => {
  localStorage.clear();
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(regs.map((r) => r.unregister()));
  const keys = await caches.keys();
  await Promise.all(keys.map((k) => caches.delete(k)));
  return 1;
})()`);
await send('Page.reload');
await wait(2500);
noise.length = 0; // the reset load is not what we are measuring

const active = `document.querySelector('.screen.is-active').id`;
const click = (id) => `(document.getElementById('${id}') || {click(){}}).click(), 1`;

const steps = [
  ['open settings', click('open-settings')],
  ['toggle every info', `document.querySelectorAll('.info').forEach((b) => b.click()), 1`],
  ['close them again', `document.querySelectorAll('.info').forEach((b) => b.click()), 1`],
  ['start a game', click('go')],
  ['rename teams', click('rename-toggle')],
  ['adjust a score', `(document.querySelector('.adjust button') || {click(){}}).click(), 1`],
  ['reveal', click('reveal')],
  ['pick a theme', `document.querySelectorAll('#themes button')[0].click(), 1`],
  ['pick a word', `document.querySelectorAll('#cards .card')[0].click(), 1`, 1200],
  ['open the pad', click('duo-toggle'), 800],
  ['score it', click('got0'), 800],
  ['next round', click('next')],
  ['wrap up', click('wrap-handoff')],
  ['confirm', click('m-yes'), 1200],
  ['share card', click('share'), 1600],
  ['gallery tab', click('tab-gallery'), 1600],
  ['tally tab', click('tab-tally'), 1200],
  ['play again', click('again'), 800],
];

console.log('walking the app in Chrome:');
for (const [label, js, ms = 500] of steps) {
  await evaluate(js);
  await wait(ms); // read the screen after the transition, not in the same tick as the click
  console.log(`  ${label.padEnd(20)} ${await evaluate(active)}`);
}
await wait(800);

console.log('');
if (!noise.length) {
  console.log('Console clean across every screen.');
  await cleanup(0);
}

const seen = new Set();
console.log(`${noise.length} console message(s):`);
for (const [level, text] of noise) {
  const key = level + String(text).slice(0, 160);
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`  [${level}] ${String(text).split('\n').slice(0, 3).join('\n           ')}`);
}
await cleanup(1);
