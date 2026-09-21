/**
 * test/e2e-back-navigation.mjs - the back gesture and the back buttons.
 *
 *   node build.mjs && node test/e2e-back-navigation.mjs
 *
 * Installed to a home screen there is no browser chrome, so the OS back
 * gesture is the only back there is - and it used to unload the document,
 * which closes the installed app outright, mid-round. The guard in nav.js
 * keeps a spare history entry underneath at all times so a pop has something
 * to consume that is not the app; these tests hold it to that.
 *
 * They drive a real `history.back()` rather than dispatching a synthetic
 * popstate, because the thing under test is precisely the bookkeeping around
 * a genuine pop: an entry has to actually come off before arm() puts one back.
 * A synthetic event pushes without popping and the depth assertions - the
 * whole point - would pass on a stack that was quietly growing.
 *
 * One boot, one session, walked end to end: back is a stateful thing and the
 * interesting cases are the ones several screens deep.
 */

import { strict as assert } from 'node:assert';
import { boot, $, active, click, createRunner } from './helpers.mjs';
import { newSeed, encodeJoinCode } from '../src/joincode.js';

const { test, group, report } = createRunner();

const dom = await boot();
const win = dom.window;

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

/** The OS back gesture, as far as the page can tell. */
const gestureBack = async () => {
  win.history.back();
  await settle();
};

const backButton = () => win.document.querySelector('.screen.is-active .backbtn');
const themeButtons = () => [...$(dom, 'themes').querySelectorAll('button')];
const modalOpen = (id) => $(dom, id).classList.contains('on');

/** setup -> handoff -> theme -> pick, the deepest the solo flow nests. */
function playToPick() {
  if (active(dom) !== 's-setup') throw new Error(`expected setup, got ${active(dom)}`);
  click(dom, 'go');
  click(dom, 'reveal');
  click(dom, themeButtons()[0]);
  assert.equal(active(dom), 's-pick');
}

await settle(150);

group('the root never unloads the app');

await test('back on the setup screen stays on the setup screen', async () => {
  assert.equal(active(dom), 's-setup');
  await gestureBack();
  assert.equal(active(dom), 's-setup');
});

await test('a pop leaves the history depth where it found it', async () => {
  const before = win.history.length;
  await gestureBack();
  assert.equal(win.history.length, before, 'arm() should replace exactly what was popped');
  await gestureBack();
  await gestureBack();
  assert.equal(win.history.length, before, 'and keep doing so');
});

group('every screen offers a way back');

await test('each screen with a topbar has a back button in it', () => {
  const screens = [...win.document.querySelectorAll('.screen')].filter((s) => s.querySelector('.topbar'));
  assert.equal(screens.length, 9, 'nine screens sit under the setup root');
  for (const screen of screens) {
    assert.ok(screen.querySelector('.topbar > .backbtn'), `${screen.id} has no back button`);
  }
});

await test('the setup root has none, because there is nowhere to go', () => {
  assert.equal($(dom, 's-setup').querySelector('.backbtn'), null);
});

group('walking back up the picking flow');

await test('back from the card picker returns to the theme picker', async () => {
  playToPick();
  await gestureBack();
  assert.equal(active(dom), 's-theme');
});

await test('back from the theme picker returns to the handoff', async () => {
  await gestureBack();
  assert.equal(active(dom), 's-handoff');
});

await test('the back button does exactly what the gesture does', async () => {
  click(dom, 'reveal');
  click(dom, themeButtons()[0]);
  assert.equal(active(dom), 's-pick');
  backButton().click();
  await settle();
  assert.equal(active(dom), 's-theme');
  await gestureBack();
  assert.equal(active(dom), 's-handoff');
});

group('leaving a live game is a decision, not an accident');

await test('back from the handoff asks before it drops the game', async () => {
  await gestureBack();
  assert.ok(modalOpen('modal'), 'expected the leave prompt');
  assert.equal(active(dom), 's-handoff', 'and no move until it is answered');
});

await test('back again answers no, rather than leaving twice as fast', async () => {
  await gestureBack();
  assert.ok(!modalOpen('modal'));
  assert.equal(active(dom), 's-handoff');
});

await test('confirming lands on setup', async () => {
  await gestureBack();
  assert.ok(modalOpen('modal'));
  click(dom, 'm-yes');
  await settle(120);
  assert.equal(active(dom), 's-setup');
});

group('overlays come off before screens');

await test('back closes the settings sheet and leaves the screen alone', async () => {
  click(dom, 'open-settings');
  assert.ok(modalOpen('settings-modal'));
  await gestureBack();
  assert.ok(!modalOpen('settings-modal'));
  assert.equal(active(dom), 's-setup');
});

await test('back lifts the hidden-screen veil without ending the round', async () => {
  playToPick();
  click(dom, 'panic2');
  assert.ok(modalOpen('veil'));
  await gestureBack();
  assert.ok(!modalOpen('veil'));
  assert.equal(active(dom), 's-pick', 'the round survives the veil coming off');
});

group('a live round');

await test('back closes the drawing pad before it touches the round', async () => {
  click(dom, [...$(dom, 'cards').querySelectorAll('.card')][0]);
  await settle(120);
  assert.equal(active(dom), 's-draw');
  assert.ok(!$(dom, 'duo-pad').hidden, 'the pad opens with the round');
  await gestureBack();
  assert.ok($(dom, 'duo-pad').hidden, 'the pad closes first');
  assert.equal(active(dom), 's-draw', 'and the clock is still running');
  assert.ok(!modalOpen('modal'), 'with nothing asked, because nothing was lost');
});

await test('back on a running round asks before dropping it', async () => {
  await gestureBack();
  assert.ok(modalOpen('modal'));
  assert.equal($(dom, 'm-title').textContent, 'End this round?');
  click(dom, 'm-no');
  await settle();
  assert.equal(active(dom), 's-draw', 'declining keeps drawing');
});

await test('confirming drops the round back to the handoff', async () => {
  await gestureBack();
  assert.ok(modalOpen('modal'));
  click(dom, 'm-yes');
  await settle(120);
  assert.equal(active(dom), 's-handoff');
});

group('the join form');

await test('back leaves the join form for setup', async () => {
  await gestureBack();
  click(dom, 'm-yes');
  await settle(120);
  assert.equal(active(dom), 's-setup');

  click(dom, 'open-join');
  assert.equal(active(dom), 's-join');
  await gestureBack();
  assert.equal(active(dom), 's-setup', 'and asks nothing, since no game is running');
  assert.ok(!modalOpen('modal'));
});

win.close();

/* ------------------------------------------------------------------------
 * A guest arriving on an invite link needs its own session, because the hash
 * is only read at boot. joinFromHash() strips it from our entry, but the
 * entry underneath still carries it - so a pop would hand the address bar a
 * spent invite back, and a reload would act on it.
 * ---------------------------------------------------------------------- */

group('arriving on an invite link');

const inviteCode = encodeJoinCode({ seed: newSeed(), diff: 'mixed', len: 90, rounds: 10, target: 0 });
const invited = await boot({ hash: `#join=${inviteCode}` });
const invitedWin = invited.window;

await test('back does not put the spent invite code back in the URL', async () => {
  await settle(200);
  assert.equal(active(invited), 's-guest', 'the link should have joined the room');
  assert.ok(!invitedWin.location.hash, 'the hash is stripped on arrival');
  invitedWin.history.back();
  await settle(150);
  assert.ok(!invitedWin.location.hash, 'and stays stripped after a pop');
});

report();
invitedWin.close();
// The relay transport keeps a handle open that outlives window.close(), the
// same reason every other suite here ends this way.
process.exit(0);
