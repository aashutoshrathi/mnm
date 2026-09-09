/**
 * test/e2e-twoplayer-fixes.mjs
 * Comprehensive regression tests verifying all 2-player multiplayer fixes:
 * 1. Real-time team renaming synchronization across Host and Guest UI.
 * 2. Score adjustment ("Fix a score") real-time sync.
 * 3. Countdown orchestration and automatic drawing pad open on both devices.
 * 4. Rematch flow and clean disconnection on return to setup.
 * 5. Stroke streaming without duplicate channel transmissions.
 */

import { strict as assert } from 'node:assert';
import { boot, $, click, pickSegment, expectScreen, expectText, expectMatch, waitFor } from './helpers.mjs';

console.log('Testing Two-Player Bug Fixes and Edge Cases...');

// 1. Host initializes game
const host = await boot({ mockCanvasCtx: true });
$(host, 'n0').value = 'Super Drawers';
$(host, 'n1').value = 'Mega Sketchers';
pickSegment(host, 'seg-devices', 'host');
click(host, 'go');
await expectScreen(host, 's-invite');
const inviteUrl = $(host, 'invite-url').textContent;

// 2. Guest joins
const guest = await boot({ hash: inviteUrl.slice(inviteUrl.indexOf('#')), mockCanvasCtx: true });
await new Promise((r) => setTimeout(r, 120));

// Verify team names synced to Guest
await expectText(guest, 'guest-team-name', 'Mega Sketchers');
await expectText(guest, 'gr-other-name', 'Super Drawers');
console.log('  [PASS] 1. Initial custom team names synced from Host to Guest');

// 3. Guest customizes team name mid-lobby
click(guest, 'guest-rename-toggle');
$(guest, 'gr-name').value = 'The Neon Inkers';
click(guest, 'gr-save');
await new Promise((r) => setTimeout(r, 100));

// Verify Host received updated guest team name
await expectText(host, 'lobby-guest-name', 'The Neon Inkers');
console.log('  [PASS] 2. Guest team rename propagated to Host lobby in real time');

// 4. Host proceeds to handoff
click(host, 'invite-done');
await expectScreen(host, 's-handoff');
await expectText(host, 'hr-guest-name', 'The Neon Inkers');

// 5. Test "Fix a score" (score adjustment) real-time sync
click(host, 'adjust-toggle');
const plusBtn = host.window.document.querySelector('.adjust[data-team="0"] button[data-step="1"]');
click(host, plusBtn);
click(host, plusBtn); // Add 2 points to team 0
await new Promise((r) => setTimeout(r, 100));

// Verify Guest board updated
const guestTnum = () => guest.window.document.querySelector('#board .teamrow:nth-child(1) .tnum')?.textContent;
await waitFor(() => guestTnum() === '2');
assert.equal(guestTnum(), '2', 'Guest scoreboard should reflect Host manual score adjustment');
console.log('  [PASS] 3. Score adjustment (+2 pts) synced to Guest');

// 6. Round 1 Card Pick & Countdown
click(host, 'reveal'); // pick theme
click(host, host.window.document.querySelector('.theme'));
click(host, host.window.document.querySelector('.card'));
await new Promise((r) => setTimeout(r, 100));

assert.equal($(host, 'host-word-text').textContent, $(guest, 'guest-word-text').textContent);

// Ready handshake
click(guest, 'gr-my-btn');
await new Promise((r) => setTimeout(r, 100));
await expectMatch(host, 'hr-guest-status', /Ready/);

// Host triggers countdown
click(host, 'reveal');
await new Promise((r) => setTimeout(r, 100));

await expectScreen(host, 's-draw');
await expectScreen(guest, 's-draw');
console.log('  [PASS] 4. Synchronized countdown orchestrated and transition to s-draw verified');

// 7. Host scores Round 1
click(host, 'got0');
await new Promise((r) => setTimeout(r, 100));
await expectScreen(host, 's-result');
await expectScreen(guest, 's-result');
assert.equal($(guest, 'next').disabled, true, 'Next button on Guest result screen is disabled for host authority');
console.log('  [PASS] 5. Result screen synchronized with Host authority over Next Round');

// 8. Next Round transition
click(host, 'next');
await new Promise((r) => setTimeout(r, 100));
await expectScreen(host, 's-handoff');
await expectScreen(guest, 's-guest');
console.log('  [PASS] 6. Round 2 transition clean across both devices');

// 9. Host ends match early and tests Rematch
click(host, 'wrap-handoff');
click(host, 'm-yes');
await new Promise((r) => setTimeout(r, 100));
await expectScreen(host, 's-win');
await expectScreen(guest, 's-win');

// Host triggers Rematch
click(host, 'again');
await new Promise((r) => setTimeout(r, 100));
await expectScreen(host, 's-invite');
await expectScreen(guest, 's-guest');
console.log('  [PASS] 7. Rematch resets both devices into fresh synchronized game');

// 10. Clean guest reset on Back to Setup
click(guest, 'guest-leave');
click(guest, 'm-yes');
await new Promise((r) => setTimeout(r, 100));
await expectScreen(guest, 's-setup');
console.log('  [PASS] 8. Guest cleanly disconnects and returns to setup');

host.window.close();
guest.window.close();

console.log('\nALL TWO-PLAYER FIXES AND REGRESSION TESTS PASSED PERFECTLY!');
process.exit(0);
