/**
 * share-controller.js - the share-card modal, tab switching, and export.
 *
 * Extracted from game.js for focus. The import from game.js is circular, which
 * is safe here for the same reason it is in clock.js: nothing below runs until
 * the user opens the share modal, long after both modules have evaluated.
 *
 * `activeShareTab` stays private to this module. game.js used to assign it
 * directly, which only worked because the bundle flattened both files into one
 * scope - an imported binding is read-only, so the served ES-module build threw
 * on the write. switchShareTab() owns the whole transition instead.
 */

import { renderShareCard, renderGalleryCard, exportCard, fontsReady } from './share.js';
import { $, S, TEAM_HEX, isSynced, toast } from './game.js';

let activeShareTab = 'tally';

async function updateShareCard() {
  const shot = $('shot');
  shot.innerHTML = '';
  $('sh-hint').textContent = 'Rendering…';

  await fontsReady();
  const gameData = {
    teams: S.teams.map((t, i) => ({ name: t.name, score: t.score, color: TEAM_HEX[i] })),
    rounds: S.history.length,
    wordsUsed: isSynced() ? S.history.length : S.used.size,
    reason: S.endReason,
    history: S.history,
  };

  const canvas = activeShareTab === 'gallery' ? renderGalleryCard(gameData) : renderShareCard(gameData);
  shot.appendChild(canvas);
  $('sh-hint').textContent = 'Long-press the image to save it, or use the button below.';

  $('sh-share').onclick = async () => {
    const filename = `marker-mayhem-${activeShareTab}-${Date.now()}.png`;
    const result = await exportCard(canvas, filename);
    if (result === 'shared') {
      toast('Shared');
    } else if (result === 'downloaded') {
      toast('Image saved');
    } else if (result !== 'cancelled') {
      toast('Long-press the image to save it');
    }
  };
}

async function openShare() {
  const modal = $('share-modal');
  modal.classList.add('on');
  activeShareTab = 'tally';
  const tabTally = $('tab-tally');
  const tabGallery = $('tab-gallery');
  if (tabTally) tabTally.classList.add('is-active');
  if (tabGallery) tabGallery.classList.remove('is-active');

  await updateShareCard();
}

const closeShare = () => $('share-modal').classList.remove('on');

/** Swap the share modal between the tally card and the gallery card. */
function switchShareTab(tab) {
  if (activeShareTab === tab) return;
  activeShareTab = tab;

  const tabTally = $('tab-tally');
  const tabGallery = $('tab-gallery');
  if (tabTally) tabTally.classList.toggle('is-active', tab === 'tally');
  if (tabGallery) tabGallery.classList.toggle('is-active', tab === 'gallery');

  return updateShareCard();
}

export { updateShareCard, openShare, closeShare, switchShareTab };
