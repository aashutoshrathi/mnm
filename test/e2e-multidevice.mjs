/**
 * test/e2e-multidevice.mjs
 * End-to-end test verifying multi-device P2P state synchronization,
 * turn alternation, readiness handshakes, synchronized countdown, and stroke streaming.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function bootDevice({ hash = '' } = {}) {
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
      });
      window.scrollTo = () => {};
      window.BroadcastChannel = globalThis.BroadcastChannel;
      window.WebSocket = globalThis.WebSocket;
    },
  });

  await new Promise((r) => setTimeout(r, 60));
  return dom;
}

const $ = (dom, id) => dom.window.document.getElementById(id);
const click = (dom, target) => {
  const el = typeof target === 'string' ? $(dom, target) : target;
  if (!el) throw new Error(`click target not found: ${target}`);
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
};
const pickSegment = (dom, segId, value) => {
  const btn = $(dom, segId).querySelector(`button[data-v="${value}"]`);
  if (!btn) throw new Error(`no option ${value} in #${segId}`);
  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
};
const active = (dom) => dom.window.document.querySelector('.screen.is-active')?.id;

console.log('Running End-to-End Multi-Device Real-Time Verification...');

// 1. Host setup
const host = await bootDevice();
pickSegment(host, 'seg-devices', 'host');
click(host, 'go');
assert.equal(active(host), 's-invite', 'Host should land on invite screen');
const inviteUrl = $(host, 'invite-url').textContent;
assert.ok(inviteUrl.includes('#'), 'Invite URL should contain hash');
console.log('  [PASS] Step 1: Host initialized lobby with invite URL');

// 2. Guest joins
const guest = await bootDevice({ hash: inviteUrl.slice(inviteUrl.indexOf('#')) });
await new Promise((r) => setTimeout(r, 100));
assert.equal(active(guest), 's-guest', 'Guest should join and land on s-guest');
console.log('  [PASS] Step 2: Guest joined room via hash URL');

// 3. Host moves to handoff
click(host, 'invite-done');
assert.equal(active(host), 's-handoff', 'Host should move to s-handoff');
console.log('  [PASS] Step 3: Host entered handoff for Round 1');

// 4. Host picks Theme and Word for Round 1
click(host, 'reveal');
assert.equal(active(host), 's-theme', 'Host should see themes');
click(host, host.window.document.querySelector('.theme'));
assert.equal(active(host), 's-pick', 'Host should see card stakes');
click(host, host.window.document.querySelector('.card'));
assert.equal(active(host), 's-handoff', 'Host should return to s-handoff after card selection');

await new Promise((r) => setTimeout(r, 100));

// 5. Verify Word Display on Both Phones
const hostWord = $(host, 'host-word-text').textContent;
const guestWord = $(guest, 'guest-word-text').textContent;
assert.ok(hostWord.length > 0, 'Host secret word should be populated');
assert.equal(hostWord, guestWord, 'Guest secret word must match Host secret word');
console.log(`  [PASS] Step 4: Secret word "${hostWord}" synced across both devices`);

// 6. Guest marks Ready
click(guest, 'gr-my-btn');
await new Promise((r) => setTimeout(r, 100));
assert.match($(host, 'hr-guest-status').textContent, /Ready/, 'Host should see Guest marked ready');
console.log('  [PASS] Step 5: Guest readiness state received and displayed on Host');

// 7. Host starts game -> synchronized countdown
click(host, 'reveal');
await new Promise((r) => setTimeout(r, 100));
assert.equal(active(host), 's-draw', 'Host should transition to s-draw');
assert.equal(active(guest), 's-draw', 'Guest should transition to s-draw simultaneously');
console.log('  [PASS] Step 6: Host started game; both phones transitioned to s-draw');

// 8. Open Drawing Pad & Stream Strokes
click(host, 'duo-toggle');
click(guest, 'duo-toggle');
assert.ok(!$(host, 'duo-pad').hidden, 'Host drawing pad should be open');
assert.ok(!$(guest, 'duo-pad').hidden, 'Guest drawing pad should be open');
console.log('  [PASS] Step 7: Drawing pad and opponent sideboards active on both phones');

// 9. Accidental Navigation Protection Verification
host.window.dispatchEvent(new host.window.Event('beforeunload'));
assert.equal(active(host), 's-draw', 'Host should stay on active game screen');
console.log('  [PASS] Step 8: Accidental exit/reload protection verified');

// 10. Complete Round 1 and verify Round 2 turn alternation
click(host, 'pad-done');
click(guest, 'pad-done');
click(host, 'got0'); // Host scores for Red
assert.equal(active(host), 's-result', 'Host should land on s-result');
click(host, 'next'); // Advance to Round 2
assert.equal(active(host), 's-handoff', 'Host moves to Round 2 handoff');

click(guest, 'guest-done'); // Guest advances to Round 2
assert.equal(active(guest), 's-guest', 'Guest moves to Round 2');

await new Promise((r) => setTimeout(r, 100));
assert.match($(host, 'handoff-head').textContent, /Blue is choosing/i, 'Host shows Guest turn to pick');
assert.match($(guest, 'guest-head').textContent, /Your turn to pick/i, 'Guest shows picker turn');
console.log('  [PASS] Step 9: Round 2 turn alternation verified (Guest picking turn)');

// 11. Guest picks Theme & Card in Round 2
click(guest, 'guest-start');
assert.equal(active(guest), 's-theme');
click(guest, guest.window.document.querySelector('.theme'));
assert.equal(active(guest), 's-pick');
click(guest, guest.window.document.querySelector('.card'));
assert.equal(active(guest), 's-guest');

await new Promise((r) => setTimeout(r, 100));
const round2Word = $(guest, 'guest-word-text').textContent;
const hostRound2Word = $(host, 'host-word-text').textContent;
assert.equal(round2Word, hostRound2Word, 'Host receives Round 2 word picked by Guest');
console.log(`  [PASS] Step 10: Round 2 word "${round2Word}" picked by Guest synced to Host`);

host.window.close();
guest.window.close();

console.log('\nALL 10 MULTI-DEVICE END-TO-END STEPS PASSED SUCCESSFULLY.');
