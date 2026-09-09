/**
 * test/e2e-p2p-dedupe.mjs - a message must be acted on once, not twice.
 *
 *   node test/e2e-p2p-dedupe.mjs
 *
 * p2p.js sends on two transports at once: BroadcastChannel for other windows on
 * the same device, and a public MQTT broker for everything else. The receiver
 * accepts from both, so every cross-device message used to arrive twice - once
 * almost immediately, once after a network round trip.
 *
 * Most handlers set absolute values and survive being run twice. The ones that
 * move the host between screens do not. A repeated WORD_SELECTED runs
 * toHandoff() and drags the host off a round in progress; a repeated
 * DRAWER_READY tries to start a round that has already been scored. How late
 * the second copy lands is up to a third-party broker, which is why this only
 * ever failed on CI - as `'s-handoff' !== 's-draw'` and `'s-draw' !== 's-win'` -
 * and never in a local run, where the duplicate arrives while the app is still
 * on the screen that ignores it.
 *
 * The suites that flaked drive whole matches, so the duplicate has to be timed
 * to catch them. This replays one directly instead, which is deterministic.
 */

import { strict as assert } from 'node:assert';
import { boot, $, active, click, pickSegment, createRunner } from './helpers.mjs';

const { test, group, report } = createRunner();

const host = await boot({ mockCanvasCtx: true });
pickSegment(host, 'seg-devices', 'host');
click(host, 'go');

const inviteUrl = $(host, 'invite-url').textContent;
const roomCode = inviteUrl.slice(inviteUrl.indexOf('#join=') + 6).toUpperCase().replace(/[^0-9A-Z]/g, '');
const guest = await boot({ hash: inviteUrl.slice(inviteUrl.indexOf('#')), mockCanvasCtx: true });
await new Promise((r) => setTimeout(r, 150));

/** Post as the guest, so the host's `from !== p2pRole` check lets it through. */
function sendAsGuest(msg) {
  const channel = new guest.window.BroadcastChannel(`mnm-room-${roomCode}`);
  channel.postMessage(msg);
  channel.postMessage(msg); // the copy the relay would deliver a moment later
  channel.close();
}

group('duplicate delivery');

await test('a round in progress survives a repeated WORD_SELECTED', async () => {
  click(host, 'reveal');
  click(host, host.window.document.querySelector('.theme'));
  click(host, host.window.document.querySelector('.card'));
  await new Promise((r) => setTimeout(r, 120));

  click(guest, 'gr-my-btn');
  click(host, 'hr-host-btn');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(active(host), 's-draw', 'host should be drawing before the duplicate arrives');

  sendAsGuest({
    type: 'WORD_SELECTED',
    from: 'guest',
    round: 1,
    picker: 0,
    theme: { id: 'x', name: 'X', icon: '?' },
    card: { tier: 2, pts: 2, word: 'duplicate' },
    ts: Date.now(),
    seq: 1,
  });
  await new Promise((r) => setTimeout(r, 250));

  assert.equal(active(host), 's-draw', 'a repeated WORD_SELECTED must not run toHandoff() again');
});

await test('a scored round is not restarted by a repeated DRAWER_READY', async () => {
  click(host, 'got0');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(active(host), 's-result', 'host should be on the result screen');

  sendAsGuest({ type: 'DRAWER_READY', from: 'guest', role: 'guest', ready: true, round: 1, ts: Date.now(), seq: 2 });
  await new Promise((r) => setTimeout(r, 250));

  assert.equal(active(host), 's-result', 'a stale ready message must not restart a finished round');
});

host.window.close();
guest.window.close();
report();
process.exit(0);
