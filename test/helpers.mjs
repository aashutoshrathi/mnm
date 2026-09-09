/**
 * test/helpers.mjs - shared JSDOM boot harness and DOM utilities.
 *
 * Every e2e/dom test needs the same JSDOM setup: mock AudioContext, mock
 * canvas getContext, polyfill BroadcastChannel/WebSocket, and wait for the
 * boot IIFE to settle. That was duplicated across four files; it lives here now.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { JSDOM } from 'jsdom';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Boot a JSDOM instance with the built bundle and browser-API shims.
 *
 * @param {Object} opts
 * @param {string} [opts.hash] - URL hash to simulate (e.g. invite link)
 * @param {string} [opts.url] - base URL origin (default https://example.test)
 * @param {boolean} [opts.mockCanvasCtx] - if true, getContext returns a mock
 *   2D context; if false (default), returns null (tests that don't draw)
 * @returns {Promise<JSDOM>}
 */
export async function boot({ hash = '', url = 'https://example.test', mockCanvasCtx = false } = {}) {
  const html = await readFile(join(root, 'dist', 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: `${url}/${hash}`,
    pretendToBeVisual: true,
    beforeParse(window) {
      window.AudioContext = class {
        constructor() {
          this.state = 'running';
          this.currentTime = 0;
          this.destination = {};
        }
        resume() {}
        createOscillator() {
          return {
            frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
            connect() {},
            start() {},
            stop() {},
          };
        }
        createGain() {
          return {
            gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
            connect() {},
          };
        }
      };
      window.navigator.vibrate = () => true;

      if (mockCanvasCtx) {
        window.HTMLCanvasElement.prototype.getContext = () => ({
          clearRect() {},
          beginPath() {},
          moveTo() {},
          lineTo() {},
          stroke() {},
          fill() {},
          arc() {},
          scale() {},
          save() {},
          restore() {},
          drawImage() {},
          setTransform() {},
          translate() {},
          rotate() {},
          fillRect() {},
          fillText() {},
          measureText() { return { width: 10 }; },
          rect() {},
          roundRect() {},
          clip() {},
          setLineDash() {},
        });
        window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,mockCanvasData';
        window.HTMLCanvasElement.prototype.toBlob = (cb) => cb(new window.Blob(['mockPngData'], { type: 'image/png' }));
      } else {
        window.HTMLCanvasElement.prototype.getContext = () => null;
      }

      window.scrollTo = () => {};
      window.BroadcastChannel = globalThis.BroadcastChannel;
      window.WebSocket = globalThis.WebSocket;
    },
  });

  await new Promise((r) => setTimeout(r, 60));
  return dom;
}

export const $ = (dom, id) => dom.window.document.getElementById(id);
export const active = (dom) => dom.window.document.querySelector('.screen.is-active')?.id;
export const visible = (dom, id) => {
  const el = $(dom, id);
  if (!el || el.hidden) return false;
  const styles = dom.window.getComputedStyle(el);
  return styles.display !== 'none';
};

export const click = (dom, idOrEl) => {
  const el = typeof idOrEl === 'string' ? $(dom, idOrEl) : idOrEl;
  assert.ok(el, `no element #${idOrEl}`);
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
};

export const pickSegment = (dom, segId, value) => {
  const btn = $(dom, segId).querySelector(`button[data-v="${value}"]`);
  assert.ok(btn, `no option ${value} in #${segId}`);
  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
};

/** Simulate a pointer-drag stroke on the pad canvas. */
export const drawFakeStroke = (dom, { points = [{ x: 50, y: 50 }, { x: 120, y: 120 }] } = {}) => {
  const canvas = $(dom, 'pad-canvas');
  if (!canvas) return;
  const rect = { width: 360, height: 600, left: 0, top: 0 };
  canvas.getBoundingClientRect = () => rect;

  const [p0, ...rest] = points;
  canvas.dispatchEvent(new dom.window.PointerEvent('pointerdown', {
    clientX: p0.x, clientY: p0.y, pointerId: 1, bubbles: true,
  }));

  for (const pt of rest) {
    canvas.dispatchEvent(new dom.window.PointerEvent('pointermove', {
      clientX: pt.x, clientY: pt.y, pointerId: 1, bubbles: true,
    }));
  }

  canvas.dispatchEvent(new dom.window.PointerEvent('pointerup', {
    clientX: points[points.length - 1].x,
    clientY: points[points.length - 1].y,
    pointerId: 1, bubbles: true,
  }));
};

/** Test runner helpers matching the existing convention. */
export function createRunner() {
  let passed = 0;
  let failed = 0;
  const failures = [];

  async function test(name, fn) {
    try {
      await fn();
      passed++;
      console.log(`  ok   ${name}`);
    } catch (err) {
      failed++;
      failures.push({ name, err });
      console.log(`  FAIL ${name}`);
      console.log(`       ${String(err.message).split('\n')[0]}`);
    }
  }

  function group(name) {
    console.log(`\n${name}`);
  }

  function report() {
    console.log(`\n${'─'.repeat(52)}`);
    console.log(`${passed} passed, ${failed} failed`);
    if (failed) {
      console.log('');
      failures.forEach(({ name, err }) => {
        console.log(`✗ ${name}`);
        console.log(`  ${err.stack ? err.stack.split('\n').slice(0, 3).join('\n  ') : err.message}`);
      });
      process.exit(1);
    }
  }

  return { test, group, report, get passed() { return passed; }, get failed() { return failed; } };
}

/* ==================================================== ES-module boot harness */

/**
 * Boot the app the way a browser actually does: `index.html` plus the real
 * `src/*.js` module graph, each file in its own scope.
 *
 * `boot()` above loads `dist/index.html`, where the bundler has flattened every
 * module into one IIFE. That flat scope hides a whole class of bug - a module
 * reading a name that lives in a *different* module still resolves, so the
 * bundle runs while the served site throws ReferenceError. Exactly that shipped
 * once: clock.js used game.js's `S` without importing it, and selecting a word
 * died on the real site while all 90-odd tests stayed green.
 *
 * So this harness deliberately does not use the bundle. jsdom cannot execute
 * `<script type="module">` itself, so we build the DOM with scripts disabled,
 * publish jsdom's browser globals onto Node's globalThis, and let Node's own
 * ESM loader import the graph - which enforces real module boundaries.
 *
 * **Once per process.** Node's ESM cache is keyed by specifier, and the graph is
 * circular (game.js <-> clock.js), so a second boot cannot get a fresh copy:
 * cache-busting the entry alone hands clock.js the *old* game.js and the two
 * silently stop sharing state. A test file using this walks one continuous
 * session instead, which is how the other e2e files are written anyway.
 *
 * @param {Object} opts
 * @param {string} [opts.hash] - URL hash to simulate (e.g. invite link)
 * @param {string} [opts.url] - base URL origin
 * @returns {Promise<{dom: JSDOM, restore: () => void}>}
 */
let modulesBooted = false;

export async function bootModules({ hash = '', url = 'https://example.test' } = {}) {
  assert.ok(
    !modulesBooted,
    'bootModules() is once-per-process: the ESM cache would hand the second boot ' +
      'a half-fresh module graph. Drive one session, or use a separate test file.'
  );
  modulesBooted = true;

  const html = await readFile(join(root, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: `${url}/${hash}`,
    pretendToBeVisual: true,
  });

  const { window } = dom;

  window.AudioContext = class {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
    }
    resume() {}
    createOscillator() {
      return {
        frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
        start() {},
        stop() {},
      };
    }
    createGain() {
      return {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
      };
    }
  };
  window.navigator.vibrate = () => true;
  window.HTMLCanvasElement.prototype.getContext = () => null;
  window.scrollTo = () => {};
  window.BroadcastChannel = globalThis.BroadcastChannel;
  window.WebSocket = globalThis.WebSocket;

  // The module graph runs in Node's realm, so the browser globals it expects
  // have to exist there. Saved and restored so tests stay isolated.
  const saved = new Map();
  const publish = (name, value) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  };

  for (const name of [
    'window', 'document', 'navigator', 'location', 'history', 'localStorage',
    'sessionStorage', 'AudioContext', 'HTMLCanvasElement', 'HTMLElement',
    'MouseEvent', 'PointerEvent', 'CustomEvent', 'Event', 'Blob', 'Image',
    'matchMedia', 'getComputedStyle', 'requestAnimationFrame',
    'cancelAnimationFrame', 'scrollTo', 'alert', 'confirm', 'prompt',
    'addEventListener', 'removeEventListener', 'dispatchEvent',
  ]) {
    if (name in window) {
      const v = window[name];
      publish(name, typeof v === 'function' && !v.prototype ? v.bind(window) : v);
    }
  }

  await import('../src/game.js');
  await new Promise((r) => setTimeout(r, 60));

  const restore = () => {
    for (const [name, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, name, desc);
      else delete globalThis[name];
    }
    window.close();
  };

  return { dom, restore };
}

/* ================================================== waiting for propagation */

/**
 * Poll until `check()` returns true, or give up after `timeout` ms.
 *
 * The e2e suites drive two jsdom windows that talk over a BroadcastChannel, and
 * they used to assert cross-device state behind a fixed `setTimeout(100)`. That
 * asserts a latency budget, not a behaviour: on a loaded CI runner the message
 * lands at 120ms and a test that only ever meant "the guest follows the host"
 * fails. Both e2e suites flaked this way on main - `'s-guest' !== 's-win'` at
 * e2e-twoplayer-fixes.mjs:102 among others - while passing every local run.
 *
 * Polling keeps the assertion and drops the deadline. The happy path is no
 * slower: a condition that is already true returns on the first check.
 */
export async function waitFor(check, { timeout = 3000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Wait for a device to land on a screen, then assert it - so failures still read well. */
export async function expectScreen(dom, id, msg) {
  await waitFor(() => active(dom) === id);
  assert.equal(active(dom), id, msg || `expected screen ${id}`);
}

/** Wait for an element's text to equal `expected`, then assert it. */
export async function expectText(dom, id, expected, msg) {
  await waitFor(() => $(dom, id)?.textContent === expected);
  assert.equal($(dom, id)?.textContent, expected, msg || `expected #${id} to read "${expected}"`);
}

/** Wait for an element's text to match `re`, then assert it. */
export async function expectMatch(dom, id, re, msg) {
  await waitFor(() => re.test($(dom, id)?.textContent ?? ''));
  assert.match($(dom, id)?.textContent ?? '', re, msg || `expected #${id} to match ${re}`);
}

/** Wait until two devices agree on the same element text, then return it. */
export async function expectSynced(domA, idA, domB, idB, msg) {
  await waitFor(() => {
    const a = $(domA, idA)?.textContent;
    return a && a === $(domB, idB)?.textContent;
  });
  const a = $(domA, idA)?.textContent;
  assert.equal(a, $(domB, idB)?.textContent, msg || `#${idA} and #${idB} should agree across devices`);
  return a;
}
