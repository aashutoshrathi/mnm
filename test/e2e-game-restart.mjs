import { strict as assert } from 'node:assert';
import { boot, $, active, click, pickSegment } from './helpers.mjs';

console.log('Testing End Game and Restart Game Flow...');

// 1. Host initializes game (Rounds capped at 5)
const host = await boot({ mockCanvasCtx: true });
pickSegment(host, 'seg-devices', 'solo');
pickSegment(host, 'seg-rounds', '5');
click(host, 'go');
assert.equal(active(host), 's-handoff');

// 2. Play rounds until game ends
for (let r = 1; r <= 5; r++) {
  assert.equal($(host, 'roundlabel').textContent.includes(`Round ${r}`), true, `Should be round ${r}`);
  // Handoff to Theme
  click(host, 'reveal');
  assert.equal(active(host), 's-theme');
  
  // Pick theme
  click(host, host.window.document.querySelector('.theme'));
  assert.equal(active(host), 's-pick');
  
  // Pick card
  click(host, host.window.document.querySelector('.card'));
  assert.equal(active(host), 's-draw');
  
  // End round (someone wins)
  click(host, 'got0'); // Red got it
  await new Promise(res => setTimeout(res, 100)); // wait for transitions
  
  assert.equal(active(host), 's-result');
  click(host, 'next');
  
  if (r < 5) {
    assert.equal(active(host), 's-handoff');
  } else {
    // Game ends on round 5
    assert.equal(active(host), 's-win');
  }
}

console.log('  [PASS] 1. Reached Win Screen after 5 rounds');

// 3. Restart game
click(host, 'again');
assert.equal(active(host), 's-handoff');

// Verify reset
assert.equal($(host, 'roundlabel').textContent.includes(`Round 1`), true, 'Round should be reset to 1');
const team0Score = host.window.document.querySelector('#board .teamrow:nth-child(1) .tnum')?.textContent;
assert.equal(team0Score, '0', 'Team 0 score should be reset');
const team1Score = host.window.document.querySelector('#board .teamrow:nth-child(2) .tnum')?.textContent;
assert.equal(team1Score, '0', 'Team 1 score should be reset');

console.log('  [PASS] 2. Game restarted cleanly and state is fully reset');
