/**
 * test/dom.mjs - drives the built bundle in jsdom.
 *
 *   node build.mjs && node test/dom.mjs
 *
 * The unit tests cover the maths; this covers the wiring, which is where the
 * cheap bugs live: a handler bound to an element that was renamed, a screen
 * that never becomes visible, a mode that leaves the wrong buttons on screen.
 *
 * Requires jsdom (a dev-only dependency): npm install
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

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

/** A fresh document with the browser APIs the app touches but jsdom lacks. */
async function boot({ hash = '' } = {}) {
  const html = await readFile(join(root, 'dist', 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: `https://example.test/${hash}`,
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
      window.HTMLCanvasElement.prototype.getContext = () => null;
      window.scrollTo = () => {};
      window.BroadcastChannel = globalThis.BroadcastChannel;
      window.WebSocket = globalThis.WebSocket;
    },
  });

  // let the boot IIFE and its awaited storage reads settle
  await new Promise((r) => setTimeout(r, 60));
  return dom;
}

const $ = (dom, id) => dom.window.document.getElementById(id);
const active = (dom) => dom.window.document.querySelector('.screen.is-active').id;
const visible = (dom, id) => {
  const el = $(dom, id);
  if (!el || el.hidden) return false;
  const styles = dom.window.getComputedStyle(el);
  return styles.display !== 'none';
};

const click = (dom, idOrEl) => {
  const el = typeof idOrEl === 'string' ? $(dom, idOrEl) : idOrEl;
  assert.ok(el, `no element #${idOrEl}`);
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
};

const pickSegment = (dom, segId, value) => {
  const btn = $(dom, segId).querySelector(`button[data-v="${value}"]`);
  assert.ok(btn, `no option ${value} in #${segId}`);
  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
};

console.log('\nbootstrap');

await test('loads without throwing and lands on setup', async () => {
  const dom = await boot();
  assert.equal(active(dom), 's-setup');
  assert.match($(dom, 'poolnote').textContent, /prompts in the bank/);
  dom.window.close();
});

await test('every screen exists exactly once', async () => {
  const dom = await boot();
  const ids = [...dom.window.document.querySelectorAll('.screen')].map((s) => s.id);
  assert.deepEqual(
    ids.slice().sort(),
    ['s-draw', 's-guest', 's-handoff', 's-invite', 's-join', 's-pick', 's-result', 's-setup', 's-theme', 's-win']
  );
  assert.equal(new Set(ids).size, ids.length);
  dom.window.close();
});

console.log('\nsolo mode');

await test('runs a full round to the result screen', async () => {
  const dom = await boot();
  click(dom, 'go');
  assert.equal(active(dom), 's-handoff');

  click(dom, 'reveal');
  assert.equal(active(dom), 's-theme');
  assert.equal($(dom, 'themes').querySelectorAll('.theme').length, 5);

  $(dom, 'themes').querySelector('.theme').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(active(dom), 's-pick');
  const cards = $(dom, 'cards').querySelectorAll('.card');
  assert.equal(cards.length, 3);

  cards[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(active(dom), 's-draw');
  assert.equal($(dom, 'draw-worth').textContent, 'Worth 2');

  click(dom, 'got0');
  assert.equal(active(dom), 's-result');
  assert.equal($(dom, 'verdict').textContent, '+2');
  dom.window.close();
});

await test('scoring buttons carry the team names', async () => {
  const dom = await boot();
  $(dom, 'n0').value = 'Mahi';
  $(dom, 'n1').value = 'RJay';
  click(dom, 'go');
  click(dom, 'reveal');
  $(dom, 'themes').querySelector('.theme').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  $(dom, 'cards').querySelector('.card').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal($(dom, 'got0').textContent, 'Mahi got it');
  assert.equal($(dom, 'got1').textContent, 'RJay got it');
  dom.window.close();
});

await test('the round cap ends the game', async () => {
  const dom = await boot();
  pickSegment(dom, 'seg-rounds', '5');
  pickSegment(dom, 'seg-target', '0');
  click(dom, 'go');

  for (let r = 1; r <= 5; r++) {
    click(dom, 'reveal');
    $(dom, 'themes').querySelector('.theme').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    $(dom, 'cards').querySelector('.card').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    click(dom, 'got0');
    click(dom, 'next');
  }
  assert.equal(active(dom), 's-win');
  assert.match($(dom, 'win-line').textContent, /All 5 rounds played/);
  assert.ok($(dom, 'confetti-canvas'), 'confetti canvas should exist on win screen');
  dom.window.close();
});

await test('the score target ends the game early', async () => {
  const dom = await boot();
  pickSegment(dom, 'seg-rounds', '0');
  pickSegment(dom, 'seg-target', '10');
  click(dom, 'go');

  for (let i = 0; i < 12 && active(dom) !== 's-win'; i++) {
    if (active(dom) === 's-result') click(dom, 'next');
    click(dom, 'reveal');
    $(dom, 'themes').querySelector('.theme').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    $(dom, 'cards').querySelectorAll('.card')[2].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    click(dom, 'got0');
  }
  assert.equal(active(dom), 's-win');
  assert.match($(dom, 'win-line').textContent, /First to 10/);
  dom.window.close();
});

await test('renaming teams mid-game updates the board', async () => {
  const dom = await boot();
  click(dom, 'go');
  click(dom, 'rename-toggle');
  $(dom, 'r0').value = 'Foxes';
  click(dom, 'rename-save');
  assert.match($(dom, 'board').textContent, /Foxes/);
  dom.window.close();
});

await test('wrapping up asks first, and completed games are removed from resume saves', async () => {
  const dom = await boot();
  click(dom, 'go');
  click(dom, 'wrap-handoff');
  assert.ok($(dom, 'modal').classList.contains('on'), 'confirmation should open');
  click(dom, 'm-no');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(active(dom), 's-handoff', 'declining should stay in the game');

  click(dom, 'wrap-handoff');
  click(dom, 'm-yes');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(active(dom), 's-win');

  click(dom, 'reset');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(active(dom), 's-setup');
  assert.ok($(dom, 'saves-field').hidden, 'wrapped-up games must not appear in resume saves');
  dom.window.close();
});

await test('saved games can be cleared all at once', async () => {
  const dom = await boot();
  click(dom, 'go');
  click(dom, 'pause');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(active(dom), 's-setup');
  assert.ok(!$(dom, 'saves-field').hidden, 'paused game should appear in saves');

  click(dom, 'clear-all-saves');
  assert.ok($(dom, 'modal').classList.contains('on'), 'confirmation modal should open');
  click(dom, 'm-yes');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok($(dom, 'saves-field').hidden, 'clearing all saves must empty the list');
  dom.window.close();
});

console.log('\nmulti-device');

await test('host mode shows an invite with a QR and a code', async () => {
  const dom = await boot();
  pickSegment(dom, 'seg-devices', 'host');
  click(dom, 'go');
  assert.equal(active(dom), 's-invite');
  assert.match($(dom, 'invite-code').textContent, /^[0-9A-HJKMNP-TV-Z]{4} [0-9A-HJKMNP-TV-Z]{4}$/);
  assert.ok($(dom, 'invite-qr').querySelector('svg'), 'QR should render');
  assert.match($(dom, 'invite-url').textContent, /#join=[0-9A-HJKMNP-TV-Z]{8}$/);
  dom.window.close();
});

await test('host picks theme and word for round 1', async () => {
  const dom = await boot();
  pickSegment(dom, 'seg-devices', 'host');
  click(dom, 'go');
  click(dom, 'invite-done');
  assert.equal(active(dom), 's-handoff');
  assert.match($(dom, 'sync-code').textContent, /^[0-9A-HJKMNP-TV-Z]{4}$/);

  click(dom, 'reveal');
  assert.equal(active(dom), 's-theme');
  click(dom, dom.window.document.querySelector('.theme'));
  assert.equal(active(dom), 's-pick');
  click(dom, dom.window.document.querySelector('.card'));
  assert.equal(active(dom), 's-handoff');
  click(dom, 'reveal');
  assert.equal(active(dom), 's-draw');
  dom.window.close();
});

await test('a guest joining by link sees the host word for the same round', async () => {
  const host = await boot();
  pickSegment(host, 'seg-devices', 'host');
  click(host, 'go');
  const url = $(host, 'invite-url').textContent;
  click(host, 'invite-done');
  click(host, 'reveal');
  click(host, host.window.document.querySelector('.theme'));
  click(host, host.window.document.querySelector('.card'));
  click(host, 'reveal');
  click(host, 'pin-toggle');
  const hostWord = $(host, 'peek').textContent;
  assert.ok(hostWord.length > 1 && hostWord !== 'Hold to see the word', 'host word should be readable');

  const guest = await boot({ hash: url.slice(url.indexOf('#')) });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(active(guest), 's-guest', 'the link should join automatically');
  assert.ok(!$(guest, 'guest-word-box').hidden);
  assert.equal($(guest, 'guest-word-text').textContent, hostWord);

  click(guest, 'gr-my-btn');
  assert.match($(guest, 'gr-my-btn').textContent, /Ready/);

  host.window.close();
  guest.window.close();
});

await test('a guest typing the code reaches the same round', async () => {
  const host = await boot();
  pickSegment(host, 'seg-devices', 'host');
  click(host, 'go');
  const code = $(host, 'invite-code').textContent;
  click(host, 'invite-done');
  click(host, 'reveal');
  click(host, host.window.document.querySelector('.theme'));
  click(host, host.window.document.querySelector('.card'));
  click(host, 'reveal');
  click(host, 'pin-toggle');
  const hostWord = $(host, 'peek').textContent;

  const guest = await boot();
  click(guest, 'open-join');
  assert.equal(active(guest), 's-join');
  $(guest, 'join-code').value = code.toLowerCase();
  click(guest, 'join-go');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(active(guest), 's-guest');
  assert.ok(!$(guest, 'guest-word-box').hidden);
  assert.equal($(guest, 'guest-word-text').textContent, hostWord);

  host.window.close();
  guest.window.close();
});

await test('a bad code is rejected with a message, not a divergent game', async () => {
  const dom = await boot();
  click(dom, 'open-join');
  $(dom, 'join-code').value = 'AAAAAAAA';
  click(dom, 'join-go');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(active(dom), 's-join', 'should stay put');
  assert.ok($(dom, 'join-error').textContent.length > 0, 'should explain the problem');
  dom.window.close();
});

await test('guest sync code matches the host, and stepping rounds re-syncs', async () => {
  const host = await boot();
  pickSegment(host, 'seg-devices', 'host');
  click(host, 'go');
  const url = $(host, 'invite-url').textContent;
  click(host, 'invite-done');

  const guest = await boot({ hash: url.slice(url.indexOf('#')) });
  assert.equal($(guest, 'guest-sync').textContent, $(host, 'sync-code').textContent);

  click(guest, 'guest-fwd');
  assert.notEqual($(guest, 'guest-sync').textContent, $(host, 'sync-code').textContent);
  click(guest, 'guest-back');
  assert.equal($(guest, 'guest-sync').textContent, $(host, 'sync-code').textContent);

  click(guest, 'guest-back'); // must not go below round 1
  assert.match($(guest, 'guest-round').textContent, /Round 1/);

  host.window.close();
  guest.window.close();
});

await test('guest mode hides host-only controls on the draw screen', async () => {
  const host = await boot();
  pickSegment(host, 'seg-devices', 'host');
  click(host, 'go');
  const url = $(host, 'invite-url').textContent;
  click(host, 'invite-done');
  click(host, 'reveal');
  click(host, host.window.document.querySelector('.theme'));
  click(host, host.window.document.querySelector('.card'));

  const guest = await boot({ hash: url.slice(url.indexOf('#')) });
  await new Promise((r) => setTimeout(r, 50));
  click(host, 'reveal');
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(active(guest), 's-draw');
  assert.ok(guest.window.document.body.classList.contains('mode-guest'));
  assert.ok(!visible(guest, 'got0'), 'guests do not score');
  assert.ok(!visible(guest, 'got1'), 'guests do not score');
  assert.ok(visible(guest, 'guest-done'), 'guests get a round-over button');
  assert.ok($(guest, 'peek').classList.contains('showing'), 'guest word is pinned by default');

  host.window.close();
  guest.window.close();
});

await test('a guest advancing lands on the next round', async () => {
  const host = await boot();
  pickSegment(host, 'seg-devices', 'host');
  click(host, 'go');
  const url = $(host, 'invite-url').textContent;
  click(host, 'invite-done');
  click(host, 'reveal');
  click(host, host.window.document.querySelector('.theme'));
  click(host, host.window.document.querySelector('.card'));

  const guest = await boot({ hash: url.slice(url.indexOf('#')) });
  await new Promise((r) => setTimeout(r, 50));
  click(host, 'reveal');
  await new Promise((r) => setTimeout(r, 50));

  const first = $(guest, 'peek').textContent;
  click(guest, 'guest-done');
  assert.equal(active(guest), 's-guest');
  assert.match($(guest, 'guest-round').textContent, /Round 2/);
  click(guest, 'guest-start');
  assert.equal(active(guest), 's-theme');
  click(guest, guest.window.document.querySelector('.theme'));
  click(guest, guest.window.document.querySelector('.card'));
  assert.equal(active(guest), 's-guest');
  assert.notEqual($(guest, 'guest-word-text').textContent, first);

  host.window.close();
  guest.window.close();
});

await test('the drawing pad opens over the draw screen and closes', async () => {
  const dom = await boot();
  click(dom, 'go');
  click(dom, 'reveal');
  click(dom, $(dom, 'themes').querySelector('.theme'));
  click(dom, $(dom, 'cards').querySelector('.card'));
  assert.equal(active(dom), 's-draw');

  click(dom, 'duo-toggle');
  assert.ok(!$(dom, 'duo-pad').hidden, 'pad should be visible');
  assert.equal($(dom, 'pad-clock').textContent, $(dom, 'clock').textContent, 'pad mirrors the clock');
  assert.ok(!$(dom, 'pad-tools').hidden, 'tools bar should be visible');
  assert.ok(!$(dom, 'pad-sizes').hidden, 'sizes bar should be visible');
  assert.ok(!$(dom, 'pad-colors').hidden, 'palette should be visible');
  assert.ok(!$(dom, 'pad-undo').hidden, 'undo button should be visible');
  assert.ok($(dom, 'pad-sideboard').hidden, 'sideboard is hidden in solo split mode');

  click(dom, 'pad-tool-eraser');
  assert.ok($(dom, 'pad-tool-eraser').classList.contains('is-active'));
  click(dom, 'pad-tool-pen');
  assert.ok($(dom, 'pad-tool-pen').classList.contains('is-active'));
  click(dom, 'pad-undo');

  click(dom, 'pad-clear');
  click(dom, 'pad-done');
  assert.ok($(dom, 'duo-pad').hidden, 'Done should close the pad');

  click(dom, 'got0');
  assert.equal(active(dom), 's-result', 'round still scores normally after pad use');
  dom.window.close();
});

await test('guests can open the drawing pad to draw for their team with opponent sideboard', async () => {
  const host = await boot();
  pickSegment(host, 'seg-devices', 'host');
  click(host, 'go');
  const url = $(host, 'invite-url').textContent;
  click(host, 'invite-done');
  click(host, 'reveal');
  click(host, host.window.document.querySelector('.theme'));
  click(host, host.window.document.querySelector('.card'));

  const guest = await boot({ hash: url.slice(url.indexOf('#')) });
  await new Promise((r) => setTimeout(r, 50));
  click(host, 'reveal');
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(active(guest), 's-draw');
  assert.ok(visible(guest, 'duo-toggle'), 'the toggle should be available for guests');

  click(guest, 'duo-toggle');
  assert.ok(!$(guest, 'duo-pad').hidden, 'pad should open on guest phone');
  assert.ok(!$(guest, 'pad-tools').hidden, 'tools should be available on guest pad');
  assert.ok(!$(guest, 'pad-sideboard').hidden, 'opponent sideboard should be visible on guest');
  assert.match($(guest, 'sideboard-title').textContent, /Red|Other Team/);
  click(guest, 'pad-done');
  assert.ok($(guest, 'duo-pad').hidden, 'Done should close guest pad');

  host.window.close();
  guest.window.close();
});

await test('guests can review and edit their team name on join', async () => {
  const host = await boot();
  pickSegment(host, 'seg-devices', 'host');
  click(host, 'go');
  const url = $(host, 'invite-url').textContent;

  const guest = await boot({ hash: url.slice(url.indexOf('#')) });
  assert.equal(active(guest), 's-guest');
  assert.equal($(guest, 'guest-team-name').textContent, 'Blue');

  click(guest, 'guest-rename-toggle');
  assert.ok(!$(guest, 'guest-renamer').hidden, 'guest renamer should expand');
  $(guest, 'gr-name').value = 'Speedy Otters';
  click(guest, 'gr-save');

  assert.ok($(guest, 'guest-renamer').hidden, 'guest renamer should close after save');
  assert.equal($(guest, 'guest-team-name').textContent, 'Speedy Otters');

  host.window.close();
  guest.window.close();
});

await test('multi-device lobby and drawer readiness boxes display team presence', async () => {
  const host = await boot();
  pickSegment(host, 'seg-devices', 'host');
  click(host, 'go');
  assert.equal(active(host), 's-invite');
  assert.ok(!$(host, 'lobby-box').hidden);
  assert.match($(host, 'lobby-host-status').textContent, /Ready/);
  const url = $(host, 'invite-url').textContent;

  click(host, 'invite-done');
  assert.equal(active(host), 's-handoff');
  click(host, 'reveal');
  click(host, host.window.document.querySelector('.theme'));
  click(host, host.window.document.querySelector('.card'));
  assert.equal(active(host), 's-handoff');
  assert.ok(!$(host, 'host-ready-box').hidden);
  assert.equal($(host, 'hr-host-btn').textContent, "I'm ready");
  assert.ok(!$(host, 'host-word-box').hidden);

  const guest = await boot({ hash: url.slice(url.indexOf('#')) });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(active(guest), 's-guest');
  assert.ok(!$(guest, 'guest-ready-box').hidden);
  assert.equal($(guest, 'gr-my-btn').textContent, "I'm ready");
  assert.ok(!$(guest, 'guest-word-box').hidden);

  host.window.close();
  guest.window.close();
});

await test('guests reaching the round cap see completion state and can step back', async () => {
  const host = await boot();
  pickSegment(host, 'seg-devices', 'host');
  pickSegment(host, 'seg-rounds', '5');
  click(host, 'go');
  const url = $(host, 'invite-url').textContent;
  click(host, 'invite-done');

  const guest = await boot({ hash: url.slice(url.indexOf('#')) });
  for (let r = 1; r <= 5; r++) {
    if (r % 2 === 1) {
      click(host, 'reveal');
      click(host, host.window.document.querySelector('.theme'));
      click(host, host.window.document.querySelector('.card'));
      click(host, 'reveal');
    } else {
      click(guest, 'guest-start');
      click(guest, guest.window.document.querySelector('.theme'));
      click(guest, guest.window.document.querySelector('.card'));
      click(host, 'reveal');
    }
    click(guest, 'guest-done');
    click(host, 'got0');
    if (r < 5) click(host, 'next');
  }

  assert.equal(active(guest), 's-guest');
  assert.match($(guest, 'guest-head').textContent, /Game complete/);
  assert.equal($(guest, 'guest-start').textContent, 'Leave game');

  click(guest, 'guest-back');
  assert.match($(guest, 'guest-head').textContent, /drawer|choosing|picking/i);

  host.window.close();
  guest.window.close();
});

console.log(`\n${'─'.repeat(52)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('');
  failures.forEach(({ name, err }) => {
    console.log(`✗ ${name}`);
    console.log(`  ${err.stack.split('\n').slice(0, 3).join('\n  ')}`);
  });
  process.exit(1);
}
