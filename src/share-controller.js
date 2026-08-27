/**
 * share-controller.js - the share-card modal, tab switching, and export.
 *
 * Extracted from game.js for focus. The build flattens this into the same
 * IIFE scope as game.js, so it shares the flat namespace at runtime.
 */

import { renderShareCard, renderGalleryCard, exportCard, fontsReady } from './share.js';

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

export { activeShareTab, updateShareCard, openShare, closeShare };
