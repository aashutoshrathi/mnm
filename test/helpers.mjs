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
