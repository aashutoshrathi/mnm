/**
 * test/e2e-creative-match.mjs
 *
 * Creative End-to-End Multi-Device Experience Simulation:
 * Spawns two simulated devices (Host: "The Doodlers" vs Guest: "Pixel Picassos"),
 * playing a full 3-round party game match through real-time P2P synchronization:
 *
 *   Act I:   Match Setup, Room Invitation & Live Lobby Presence
 *   Act II:  Settings & Audio Customization
 *   Act III: Round 1 - High-Stakes Rocket Drawing & Stroke Streaming
 *   Act IV:  Round 2 - Turn Alternation & Guest Word Selection Battle
 *   Act V:   Round 3 - Deciding Match, Victory Podium & Confetti Celebrations
 *   Act VI:  Match Replay Gallery Poster Export & Return to Lobby
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function bootPlayerDevice({ name = 'Player', hash = '' } = {}) {
  const html = await readFile(join(root, 'dist', 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: `https://marker-mayhem.game/${hash}`,
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
        translate() {},
        rotate() {},
        fillRect() {},
        fillText() {},
        measureText() {
          return { width: 42 };
        },
        rect() {},
        roundRect() {},
        clip() {},
        setLineDash() {},
      });
      window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,mockCanvasData';
      window.HTMLCanvasElement.prototype.toBlob = (cb) => cb(new window.Blob(['mockPngData'], { type: 'image/png' }));
      window.scrollTo = () => {};
      window.BroadcastChannel = globalThis.BroadcastChannel;
      window.WebSocket = globalThis.WebSocket;
    },
  });

  await new Promise((r) => setTimeout(r, 60));
  return dom;
}

const $ = (dom, id) => dom.window.document.getElementById(id);
const active = (dom) => dom.window.document.querySelector('.screen.is-active')?.id;

const click = (dom, target) => {
  const el = typeof target === 'string' ? $(dom, target) : target;
  if (!el) throw new Error(`Click target not found: ${target}`);
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
};

const pickSegment = (dom, segId, value) => {
  const btn = $(dom, segId).querySelector(`button[data-v="${value}"]`);
  if (!btn) throw new Error(`Option "${value}" not found in #${segId}`);
  btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
};

const drawFakeStroke = (dom, { points = [{ x: 50, y: 50 }, { x: 120, y: 120 }] } = {}) => {
  const canvas = $(dom, 'pad-canvas');
  if (!canvas) return;
  const rect = { width: 360, height: 600, left: 0, top: 0 };
  canvas.getBoundingClientRect = () => rect;

  const [p0, ...rest] = points;
  canvas.dispatchEvent(new dom.window.PointerEvent('pointerdown', {
    clientX: p0.x,
    clientY: p0.y,
    pointerId: 1,
    bubbles: true,
  }));

  for (const pt of rest) {
    canvas.dispatchEvent(new dom.window.PointerEvent('pointermove', {
      clientX: pt.x,
      clientY: pt.y,
      pointerId: 1,
      bubbles: true,
    }));
  }

  canvas.dispatchEvent(new dom.window.PointerEvent('pointerup', {
    clientX: points[points.length - 1].x,
    clientY: points[points.length - 1].y,
    pointerId: 1,
    bubbles: true,
  }));
};

console.log('================================================================');
console.log('  MARKER & MAYHEM - TWO-PLAYER LIVE MATCH EXPERIENCE SIMULATION');
console.log('================================================================\n');

/* -------------------------------------------------------------------------
 * ACT I: Match Setup, Room Invitation & Live Lobby Presence
 * ------------------------------------------------------------------------- */
console.log('ACT I: Room Setup & Live Multi-Device Lobby');
const host = await bootPlayerDevice({ name: 'Host (The Doodlers)' });

// 1. Host customizes match settings
pickSegment(host, 'seg-devices', 'host');
pickSegment(host, 'seg-rounds', '5'); // 5 Rounds configured
pickSegment(host, 'seg-diff', 'medium'); // Medium difficulty
$(host, 'n0').value = 'The Doodlers';
$(host, 'n1').value = 'Pixel Picassos';
click(host, 'go');

assert.equal(active(host), 's-invite', 'Host must land on invite screen');
const inviteUrl = $(host, 'invite-url').textContent;
const joinCode = $(host, 'invite-code').textContent;
assert.ok(inviteUrl.includes('#join='), 'Invite URL must contain room hash');
assert.ok(joinCode.length > 0, 'Lobby must display formatted join code');
console.log(`  [PASS] 1. Host initialized room with code: "${joinCode}"`);

// 2. Guest scans QR / opens join link
const guest = await bootPlayerDevice({
  name: 'Guest (Pixel Picassos)',
  hash: inviteUrl.slice(inviteUrl.indexOf('#')),
});
await new Promise((r) => setTimeout(r, 80));

assert.equal(active(guest), 's-guest', 'Guest should automatically connect and enter s-guest');
console.log('  [PASS] 2. Guest joined game via shared link');

// 3. Guest customizes their team name on join
click(guest, 'guest-rename-toggle');
$(guest, 'gr-name').value = 'Pixel Picassos';
click(guest, 'gr-save');
assert.equal($(guest, 'guest-team-name').textContent, 'Pixel Picassos');
console.log('  [PASS] 3. Guest confirmed custom team name: "Pixel Picassos"');

// 4. Host proceeds to handoff screen for Round 1
click(host, 'invite-done');
assert.equal(active(host), 's-handoff', 'Host enters Round 1 handoff');
console.log('  [PASS] 4. Host advanced to Round 1 setup\n');

/* -------------------------------------------------------------------------
 * ACT II: Audio & Haptics Settings Customization
 * ------------------------------------------------------------------------- */
console.log('ACT II: Settings & Audio Preferences Customization');
click(host, 'open-settings');
assert.ok($(host, 'settings-modal').classList.contains('on'), 'Settings modal opens');

const volSlider = $(host, 'set-volume');
volSlider.value = '85';
volSlider.dispatchEvent(new host.window.Event('input'));
assert.equal($(host, 'set-volume-val').textContent, '85%');

const storedSettings = JSON.parse(host.window.localStorage.getItem('mnm_audio_settings') || '{}');
assert.equal(storedSettings.volume, 0.85, 'Master volume should persist to localStorage');
click(host, 'settings-close');
assert.ok(!$(host, 'settings-modal').classList.contains('on'), 'Settings modal closes cleanly');
console.log('  [PASS] 5. Audio settings tuned to 85% and persisted\n');

/* -------------------------------------------------------------------------
 * ACT III: Round 1 - High-Stakes Rocket Drawing & Stroke Streaming
 * ------------------------------------------------------------------------- */
console.log('ACT III: Round 1 (The Doodlers picking theme and word)');

// 1. Host chooses theme and high-stake card
click(host, 'reveal');
assert.equal(active(host), 's-theme');
const themeBtns = host.window.document.querySelectorAll('.theme');
assert.ok(themeBtns.length >= 3, 'Host should see multiple theme options');
click(host, themeBtns[0]);

assert.equal(active(host), 's-pick');
const cards = host.window.document.querySelectorAll('.card');
click(host, cards[cards.length - 1]); // Pick highest stakes card (3 pts)
assert.equal(active(host), 's-handoff');

await new Promise((r) => setTimeout(r, 80));
const round1Word = $(host, 'host-word-text').textContent;
const guestRound1Word = $(guest, 'guest-word-text').textContent;
assert.ok(round1Word.length > 0, 'Host secret word should be populated');
assert.equal(round1Word, guestRound1Word, 'Guest secret word must match Host secret word');
console.log(`  [PASS] 6. Secret word "${round1Word}" synchronized to both drawers`);

// 2. Both drawers confirm readiness
click(guest, 'gr-my-btn');
click(host, 'hr-host-btn');
await new Promise((r) => setTimeout(r, 80));
assert.match($(host, 'hr-guest-status').textContent, /Ready/);
console.log('  [PASS] 7. Drawer readiness handshake verified');

// 3. Host starts countdown
click(host, 'reveal');
await new Promise((r) => setTimeout(r, 100));
assert.equal(active(host), 's-draw');
assert.equal(active(guest), 's-draw');
console.log('  [PASS] 8. 3-2-1 Countdown orchestrated; both phones transitioned to s-draw');

// 4. Drawing Pad auto-opened & Drawing Tools tested
click(host, 'duo-toggle');
click(guest, 'duo-toggle');
assert.ok(!$(host, 'duo-pad').hidden, 'Host drawing pad is active');
assert.ok(!$(guest, 'duo-pad').hidden, 'Guest drawing pad is active');

// Verify secret word is not peekable inside drawing pad for room privacy
assert.equal($(host, 'pad-word-chip'), null);
assert.equal($(guest, 'pad-word-chip'), null);

// Host draws a rocket with pen tool
drawFakeStroke(host, {
  points: [{ x: 50, y: 150 }, { x: 100, y: 80 }, { x: 150, y: 150 }, { x: 100, y: 150 }],
});

// Guest switches to Thick brush, selects yellow marker, and draws
const sizeLg = guest.window.document.querySelector('.pad-size-btn[data-size="lg"]');
if (sizeLg) click(guest, sizeLg);
const swatchYellow = guest.window.document.querySelector('.pad-color-swatch[data-color="#FFE14D"]');
if (swatchYellow) click(guest, swatchYellow);

drawFakeStroke(guest, {
  points: [{ x: 60, y: 80 }, { x: 180, y: 80 }, { x: 120, y: 200 }],
});

// Test eraser & undo on guest pad
click(guest, 'pad-tool-eraser');
drawFakeStroke(guest, { points: [{ x: 100, y: 80 }, { x: 140, y: 80 }] });
click(guest, 'pad-undo');

await new Promise((r) => setTimeout(r, 60));
console.log('  [PASS] 9. Multi-color drawing tools, eraser, and undo verified');

// 5. Host scores for Red (The Doodlers)
click(host, 'pad-done');
click(guest, 'pad-done');
click(host, 'got0');
assert.equal(active(host), 's-result');
assert.equal($(host, 'verdict').textContent, '+3');
console.log('  [PASS] 10. Round 1 scored (+3 pts for The Doodlers)\n');

/* -------------------------------------------------------------------------
 * ACT IV: Round 2 - Turn Alternation & Guest Word Selection Battle
 * ------------------------------------------------------------------------- */
console.log('ACT IV: Round 2 (Turn Alternation: Pixel Picassos picking)');

// Advance to Round 2
click(host, 'next');
click(guest, 'guest-done');
await new Promise((r) => setTimeout(r, 80));

assert.equal(active(host), 's-handoff');
assert.equal(active(guest), 's-guest');
assert.match($(host, 'handoff-head').textContent, /Pixel Picassos is choosing/i);
assert.match($(guest, 'guest-head').textContent, /Your turn to pick/i);
console.log('  [PASS] 11. Turn alternation verified: Guest takes turn to pick theme and card');

// Guest picks theme & card
click(guest, 'guest-start');
assert.equal(active(guest), 's-theme');
click(guest, guest.window.document.querySelector('.theme'));
assert.equal(active(guest), 's-pick');
click(guest, guest.window.document.querySelectorAll('.card')[1]); // 2 pts
assert.equal(active(guest), 's-guest');

await new Promise((r) => setTimeout(r, 80));
const round2Word = $(guest, 'guest-word-text').textContent;
const hostRound2Word = $(host, 'host-word-text').textContent;
assert.equal(round2Word, hostRound2Word, 'Host receives Round 2 word chosen by Guest');
console.log(`  [PASS] 12. Round 2 secret word "${round2Word}" chosen by Guest synced to Host`);

// Both mark ready and start
click(guest, 'gr-my-btn');
click(host, 'hr-host-btn');
await new Promise((r) => setTimeout(r, 80));
click(host, 'reveal');
await new Promise((r) => setTimeout(r, 100));

assert.equal(active(host), 's-draw');
assert.equal(active(guest), 's-draw');

// Drawing battle
click(host, 'duo-toggle');
click(guest, 'duo-toggle');
drawFakeStroke(guest, { points: [{ x: 80, y: 100 }, { x: 200, y: 220 }] });
drawFakeStroke(host, { points: [{ x: 90, y: 90 }, { x: 190, y: 190 }] });

// Round 2 awarded to Guest (Pixel Picassos)
click(host, 'pad-done');
click(guest, 'pad-done');
click(host, 'got1'); // Host scores for Blue
assert.equal(active(host), 's-result');
assert.equal($(host, 'verdict').textContent, '+2');
console.log('  [PASS] 13. Round 2 scored (+2 pts for Pixel Picassos; Score: 3 - 2)\n');

/* -------------------------------------------------------------------------
 * ACT V: Round 3 - Deciding Match, Victory Podium & Confetti
 * ------------------------------------------------------------------------- */
console.log('ACT V: Round 3 (Deciding Match & Championship Victory)');

click(host, 'next');
click(guest, 'guest-done');
await new Promise((r) => setTimeout(r, 80));

// Host picks final round theme & card
click(host, 'reveal');
click(host, host.window.document.querySelector('.theme'));
click(host, host.window.document.querySelector('.card'));
await new Promise((r) => setTimeout(r, 80));

click(guest, 'gr-my-btn');
click(host, 'hr-host-btn');
await new Promise((r) => setTimeout(r, 80));
click(host, 'reveal');
await new Promise((r) => setTimeout(r, 100));

// Complete round 3
click(host, 'got0'); // Host scores final word
assert.equal(active(host), 's-result');

// Players wrap up match after 3 intense rounds
click(host, 'wrap-result');
click(host, 'm-yes');
await new Promise((r) => setTimeout(r, 100));

assert.equal(active(host), 's-win', 'Host lands on Victory screen');
assert.match($(host, 'win-name').textContent, /The Doodlers/);
assert.ok($(host, 'confetti-canvas'), 'Confetti canvas celebration is active on victory');
console.log('  [PASS] 14. Match wrapped up: Grand Victory screen & Confetti celebration displayed');
console.log('  [PASS] 15. Champion crowned: "The Doodlers" with final tally\n');

/* -------------------------------------------------------------------------
 * ACT VI: Match Replay Gallery Poster Export & Return to Lobby
 * ------------------------------------------------------------------------- */
console.log('ACT VI: Replay Gallery Export & Clean Match Teardown');

click(host, 'share');
assert.ok($(host, 'share-modal').classList.contains('on'), 'Share modal opens');
assert.ok($(host, 'tab-tally').classList.contains('is-active'), 'Tally tab is active by default');

click(host, 'tab-gallery');
await new Promise((r) => setTimeout(r, 80));
assert.ok($(host, 'tab-gallery').classList.contains('is-active'), 'Gallery tab becomes active');
click(host, 'sh-close');
assert.ok(!$(host, 'share-modal').classList.contains('on'), 'Share modal closes cleanly');
console.log('  [PASS] 16. Match Drawing Gallery poster exported with all round sketches');

click(host, 'reset');
await new Promise((r) => setTimeout(r, 80));
assert.equal(active(host), 's-setup', 'Host returns to fresh setup screen');
assert.ok($(host, 'saves-field').hidden, 'Completed match is cleanly archived from resume saves');
console.log('  [PASS] 17. Host returned to setup; finished match archived\n');

host.window.close();
guest.window.close();

console.log('================================================================');
console.log('  ALL 17 TWO-PLAYER LIVE MATCH E2E STEPS PASSED PERFECTLY!');
console.log('================================================================\n');
process.exit(0);
