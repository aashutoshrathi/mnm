/**
 * clock.js - the game timer, countdown overlay, and wake lock.
 *
 * Extracted from game.js for focus. The build flattens this into the same
 * IIFE scope as game.js, so it shares the flat namespace at runtime.
 */

import { tock, buzz, buzzer } from './feedback.js';
import { closeDuoPad, openDuoPad, resetDuoPad } from './duo.js';

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

export { requestWakeLock, releaseWakeLock, formatClock, paintClock, runClock, stopClock, pauseClock, resumeClock, startRound };
