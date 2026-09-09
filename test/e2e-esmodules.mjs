/**
 * test/e2e-esmodules.mjs - drives the app as ES modules, not as the bundle.
 *
 *   node test/e2e-esmodules.mjs
 *
 * Every other test boots `dist/index.html`, where the build has flattened all
 * seventeen modules into a single IIFE. That is not what visitors run.
 * `index.html` loads `src/game.js` with `<script type="module">`, so on the
 * served site each file keeps its own scope and a cross-module reference only
 * resolves if it was actually imported.
 *
 * The difference is not academic. clock.js used to read game.js's `S`, `$`,
 * `show`, `finishRound` and friends without importing any of them. Under the
 * bundle's flat scope that worked; on the real site, picking a word threw
 * "ReferenceError: S is not defined" and the round never started. The whole
 * suite was green the entire time.
 *
 * One boot, one session, walked end to end - see bootModules() for why a second
 * boot in the same process cannot get a clean module graph.
 */

import { strict as assert } from 'node:assert';
import { bootModules, $, active, click, createRunner } from './helpers.mjs';

const { test, group, report } = createRunner();

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

const { dom, restore } = await bootModules();
const cards = () => [...$(dom, 'cards').querySelectorAll('.card')];
const themes = () => [...$(dom, 'themes').querySelectorAll('button')];

/** setup -> handoff -> theme -> pick -> draw, the path that used to die. */
function playToDraw() {
  click(dom, 'go');
  assert.equal(active(dom), 's-handoff', 'start should reach handoff');
  click(dom, 'reveal');
  assert.equal(active(dom), 's-theme', 'deal-us-in should reach the theme picker');

  assert.ok(themes().length >= 2, 'theme picker should offer themes');
  click(dom, themes()[0]);
  assert.equal(active(dom), 's-pick', 'a theme should deal cards');

  const dealt = cards();
  assert.equal(dealt.length, 3, 'should deal three cards');
  const word = dealt[0].querySelector('.card-word')?.textContent?.trim();

  // The regression: selectCard -> startRound (clock.js) -> `S.card = card`.
  click(dom, dealt[0]);
  return word;
}

group('boot under real module scope');

await test('index.html + src/*.js boots to setup with no ReferenceError', async () => {
  assert.equal(active(dom), 's-setup');
  assert.match($(dom, 'poolnote').textContent, /prompts in the bank/);
});

group('the round that used to throw');

let playedWord = null;

await test('picking a word starts the round (clock.js reaches game.js state)', async () => {
  playedWord = playToDraw();
  assert.equal(active(dom), 's-draw', 'selecting a word must start the round');
  assert.match($(dom, 'clock').textContent, /^\d:\d\d$/, 'clock should be painted');
});

await test('the clock actually counts down', async () => {
  const first = $(dom, 'clock').textContent;
  await settle(1100);
  assert.notEqual(
    $(dom, 'clock').textContent,
    first,
    `clock stuck at ${first} - runClock() is not ticking`
  );
});

await test('scoring a round reaches the result screen with the word revealed', async () => {
  click(dom, 'got0');
  assert.equal(active(dom), 's-result', 'scoring should reach the result screen');
  if (playedWord) {
    assert.equal($(dom, 'res-word').textContent.trim(), playedWord, 'result should reveal the word played');
  }
});

await test('a second round runs, so nothing was left wedged by the first', async () => {
  click(dom, 'next');
  assert.equal(active(dom), 's-handoff', 'next round should return to handoff');
  click(dom, 'reveal');
  click(dom, themes()[0]);
  click(dom, cards()[0]);
  assert.equal(active(dom), 's-draw', 'round two should start too');
  click(dom, 'got1');
  assert.equal(active(dom), 's-result');
});

group('share-controller under real module scope');

await test('wrapping up reaches the win screen', async () => {
  click(dom, 'wrap-result');
  click(dom, 'm-yes');
  await settle();
  assert.equal(active(dom), 's-win', 'wrapping up should reach the win screen');
});

await test('the share modal opens and renders the tally card', async () => {
  click(dom, 'share');
  await settle(80);
  assert.ok($(dom, 'share-modal').classList.contains('on'), 'share modal should open');
  assert.ok($(dom, 'tab-tally').classList.contains('is-active'), 'tally tab should start active');
});

await test('switching to the gallery tab does not assign to an imported binding', async () => {
  // switchShareTab() replaced a direct write to an imported binding from game.js,
  // which is a TypeError under real module semantics.
  click(dom, 'tab-gallery');
  await settle(80);
  assert.ok($(dom, 'tab-gallery').classList.contains('is-active'), 'gallery tab should become active');
  assert.ok(!$(dom, 'tab-tally').classList.contains('is-active'), 'tally tab should deactivate');

  click(dom, 'tab-tally');
  await settle(80);
  assert.ok($(dom, 'tab-tally').classList.contains('is-active'), 'tally tab should come back');
});

restore();
report();
process.exit(0);
