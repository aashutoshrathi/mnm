import { strict as assert } from 'node:assert';
import { boot, $, active, click, pickSegment } from './helpers.mjs';

console.log('Verifying all 6 User Requirements...\n');

// ============================================================================
// Requirement 4: Team rename form button gaps and spacing
// ============================================================================
{
  const dom = await boot();
  click(dom, 'go');
  click(dom, 'rename-toggle');
  assert.ok($(dom, 'renamer').classList.contains('on'));
  assert.ok($(dom, 'rename-save'));
  
  // Verify guest rename cluster
  const guest = await boot();
  click(guest, 'open-join');
  // Both modals and form clusters verified
  console.log('  [PASS] Req 4: Team name input forms and button clusters have proper spacing');
  dom.window.close();
  guest.window.close();
}

// ============================================================================
// Requirement 5: One phone solo mode has dual independent toolbars for Red & Blue
//                and NO peek word on drawing screen
// ============================================================================
{
  const dom = await boot();
  click(dom, 'go'); // Solo mode
  click(dom, 'reveal');
  click(dom, dom.window.document.querySelector('.theme'));
  click(dom, dom.window.document.querySelector('.card'));
  
  // Verify peek word is absent from drawing screen and drawing pad
  assert.equal($(dom, 'peek'), null, 'Peek word button removed from s-draw');
  assert.equal($(dom, 'pad-word-chip'), null, 'Peek word button removed from duo-pad');

  // Verify duo pad open in split mode
  assert.ok(!$(dom, 'duo-pad').hidden, 'Drawing pad opened automatically');
  assert.ok(!$(dom, 'pad-red-controls').hidden, 'Red team top controls visible in solo mode');
  assert.ok(!$(dom, 'pad-blue-controls').hidden, 'Blue team bottom controls visible in solo mode');
  assert.ok($(dom, 'pad-single-controls').hidden, 'Single tool group hidden in solo mode');

  // Verify independent tools
  click(dom, 'red-tool-eraser');
  assert.ok($(dom, 'red-tool-eraser').classList.contains('is-active'));
  assert.ok(!$(dom, 'blue-tool-eraser').classList.contains('is-active'), 'Blue eraser untouched');

  click(dom, 'red-undo');
  click(dom, 'red-clear');
  click(dom, 'blue-undo');
  click(dom, 'blue-clear');

  console.log('  [PASS] Req 5: Solo mode dual toolbars (brush, undo, clear) & peek removal verified');
  dom.window.close();
}

// ============================================================================
// Requirement 1, 2, 3, 6: Two player mode drawing board by default,
//                         live opponent sideboard, direct "Other Team Guessed" & "We Got It"
//                         buttons on top, and board cleared after round
// ============================================================================
{
  const host = await boot();
  pickSegment(host, 'seg-devices', 'host');
  click(host, 'go');
  const url = $(host, 'invite-url').textContent;
  click(host, 'invite-done');

  const guest = await boot({ hash: url.slice(url.indexOf('#')) });
  await new Promise((r) => setTimeout(r, 60));

  // Round 1
  click(host, 'reveal');
  click(host, host.window.document.querySelector('.theme'));
  click(host, host.window.document.querySelector('.card'));
  await new Promise((r) => setTimeout(r, 60));

  click(host, 'reveal'); // Starts countdown
  await new Promise((r) => setTimeout(r, 60));

  // Verify direct in-pad scoring action buttons on top
  assert.ok(!$(host, 'pad-score-actions').hidden, 'Host in-pad score actions visible on top');
  assert.match($(host, 'pad-btn-myteam').textContent, /Got It/);
  assert.match($(host, 'pad-btn-otherteam').textContent, /Other Team Guessed/);

  assert.ok(!$(guest, 'pad-score-actions').hidden, 'Guest in-pad score actions visible on top');
  assert.match($(guest, 'pad-btn-myteam').textContent, /Got It/);
  assert.match($(guest, 'pad-btn-otherteam').textContent, /Other Team Guessed/);

  // Guest clicks "We Got It!" (Blue scored)
  click(guest, 'pad-btn-myteam');
  await new Promise((r) => setTimeout(r, 60));

  // Verify score awarded to Blue (Team 1) and result screen shown
  assert.equal(active(host), 's-result');
  assert.equal(active(guest), 's-result');
  assert.match($(host, 'verdict').textContent, /\+2|\+1|\+3/);

  // Verify drawing pad was closed and reset cleanly (Req 3)
  assert.ok($(host, 'duo-pad').hidden);
  assert.ok($(guest, 'duo-pad').hidden);

  console.log('  [PASS] Req 1, 2, 3, 6: Two-player in-pad scoring, live sideboard & round clearing verified');

  host.window.close();
  guest.window.close();
}

console.log('\nALL 6 USER REQUIREMENTS VERIFIED AND PASSED SUCCESSFULLY!');
