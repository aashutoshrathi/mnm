/**
 * clock.js - the game timer, countdown overlay, and wake lock.
 *
 * Extracted from game.js for focus. The import from game.js below is circular
 * (game.js imports startRound from here), which ES modules handle fine because
 * nothing in this module touches a game.js binding at evaluation time - every
 * reference is inside a function that only runs once boot has finished.
 *
 * Those imports are not optional decoration. `index.html` loads src/game.js as
 * a real module, so each file gets its own scope; only the bundle flattens them
 * into one. Relying on the flat scope meant this module threw
 * "ReferenceError: S is not defined" on the served site while every test - all
 * of which boot dist/index.html - stayed green.
 */

import { tock, buzz, buzzer, blip } from './feedback.js';
import { closeDuoPad, openDuoPad, resetDuoPad } from './duo.js';
import {
  $,
  S,
  TICK_PHASES,
  finishRound,
  isGuest,
  isSynced,
  renderBoard,
  show,
} from './game.js';

/* =============================================================== wake lock */

let wakeLock = null;

async function requestWakeLock() {
  if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
    try {
      if (!wakeLock) {
        const lock = await navigator.wakeLock.request('screen');
        wakeLock = lock;
        lock.addEventListener('release', () => {
          if (wakeLock === lock) {
            wakeLock = null;
          }
        });
      }
    } catch (e) {
      /* wake lock is best effort (e.g. low battery mode or background tab) */
      wakeLock = null;
    }
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    const lock = wakeLock;
    wakeLock = null;
    try {
      lock.release().catch(() => {});
    } catch (e) {
      /* no-op */
    }
  }
}

/* ============================================================== countdown */

/**
 * The 3-2-1 overlay that fires before a synced round. It lives here rather
 * than in game.js because stopClock() has to be able to cancel it, and a timer
 * that two modules can clear is a timer that needs one owner.
 */

let countdownTimer = null;

function triggerSynchronizedCountdown(onComplete) {
  const overlay = $('countdown-overlay');
  const num = $('cd-num');
  if (!overlay || !num) {
    onComplete();
    return;
  }

  overlay.hidden = false;
  let count = 3;
  num.textContent = count;
  blip(520, 0.08);

  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    if (!countdownTimer) return;
    count--;
    if (count > 0) {
      num.textContent = count;
      blip(520, 0.08);
    } else if (count === 0) {
      num.textContent = 'GO!';
      blip(1040, 0.15);
    } else {
      clearInterval(countdownTimer);
      countdownTimer = null;
      overlay.hidden = true;
      if ($('s-draw') && $('s-draw').classList.contains('is-active')) {
        onComplete();
      }
    }
  }, 1000);
}

/* ================================================================== clock */

const formatClock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function paintClock() {
  const ms = Math.max(0, S.endsAt - Date.now());
  const left = Math.ceil(ms / 1000);
  const el = $('clock');
  if (!el) return left;

  el.textContent = formatClock(left);
  el.className = 'clock' + (left <= 5 ? ' hot shake' : left <= 10 ? ' hot' : left <= 20 ? ' warn' : '');
  const stroke = $('stroke');
  if (stroke) {
    stroke.style.transform = `scaleX(${ms / (S.len * 1000)})`;
    stroke.style.background = left <= 10 ? '#FF4262' : left <= 20 ? '#FFD23F' : '#F7F4EC';
  }

  const padClock = $('pad-clock');
  if (padClock) {
    padClock.textContent = formatClock(left);
    padClock.style.color =
      left <= 10 ? '#FF4262' : left <= 20 ? '#FFD23F' : 'var(--paper)';
  }

  return left;
}

function runClock() {
  clearInterval(S.ticker);
  let nextTock = 0;
  let high = true;
  paintClock();
  requestWakeLock();

  S.ticker = setInterval(() => {
    const left = paintClock();

    let phase = null;
    for (const p of TICK_PHASES) {
      if (left <= p.from) phase = p;
    }
    if (phase && left > 0 && Date.now() >= nextTock) {
      nextTock = Date.now() + phase.gap;
      tock(high ? 2300 : 1700, phase.vol);
      high = !high;
      if (left <= 5) buzz(12);
    }

    if (left <= 0) {
      stopClock();
      buzzer();
      if (isGuest()) {
        $('res-eyebrow').textContent = `Round ${S.round}`;
        $('verdict').textContent = 'Time expired';
        $('verdict').style.color = 'rgba(247,244,236,.35)';
        $('res-word').textContent = S.card?.word || '';
        $('next').textContent = 'Waiting for host…';
        $('next').disabled = true;
        $('next').style.opacity = '0.6';
        renderBoard($('board2'));
        show('s-result');
      } else {
        finishRound(null);
      }
    }
  }, 50);
}

function stopClock() {
  clearInterval(S.ticker);
  S.ticker = null;
  S.pausedMs = null;
  clearInterval(countdownTimer);
  countdownTimer = null;
  const overlay = $('countdown-overlay');
  if (overlay) overlay.hidden = true;
  releaseWakeLock();
  closeDuoPad();
}

function pauseClock() {
  if (!S.ticker) return;
  clearInterval(S.ticker);
  S.ticker = null;
  S.pausedMs = Math.max(0, S.endsAt - Date.now());
  releaseWakeLock();
}

function resumeClock() {
  if (S.pausedMs === null) return;
  S.endsAt = Date.now() + S.pausedMs;
  S.pausedMs = null;
  runClock();
}

function startRound(card) {
  S.card = card;
  resetDuoPad();
  $('draw-theme').textContent = S.theme.any ? '🎯 Anything goes' : `${S.theme.icon} ${S.theme.name}`;
  $('draw-worth').textContent = `Worth ${card.pts}`;
  $('got0').textContent = `${S.teams[0].name} got it`;
  $('got1').textContent = `${S.teams[1].name} got it`;

  S.endsAt = Date.now() + S.len * 1000;
  S.pausedMs = null;
  show('s-draw');
  runClock();

  if (!isSynced()) {
    openDuoPad({
      colorMode: 'split',
      team0Name: S.teams[0].name,
      team1Name: S.teams[1].name,
    });
  }
}

export {
  requestWakeLock,
  releaseWakeLock,
  formatClock,
  paintClock,
  runClock,
  stopClock,
  pauseClock,
  resumeClock,
  startRound,
  triggerSynchronizedCountdown,
};
