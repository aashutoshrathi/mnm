/**
 * duo.js - shared or single-team touch drawing surface with real-time sideboard.
 *
 * Solo mode (one phone):
 *   The canvas splits into two halves (Red top, Blue bottom) with multi-touch
 *   so both artists draw on the shared screen simultaneously.
 *
 * Multi-device mode (phone per team):
 *   Each team draws on a major full-screen board in their team color (Red on host,
 *   Blue on guest), while a compact read-only sideboard displays the opponent's
 *   live strokes in real time via BroadcastChannel without blocking local drawing.
 *
 * In all modes, the secret word is deliberately not shown on the drawing pad
 * so guessers in the room can look directly at the phone screen without seeing
 * the answer.
 */

import { sendP2P } from './p2p.js';

const PAD_TOP_INK = '#FF4262';
const PAD_BOTTOM_INK = '#3D9BFF';
const PAD_DIVIDER = 'rgba(247,244,236,.28)';
const PAD_STROKE_W = 4;
const SIDEBOARD_STROKE_W = 2.5;

/** pointerId -> {x, y, color}; multi-touch means several can be live at once. */
const padPointers = new Map();

let padCanvas = null;
let padCtx = null;
let sideboardCanvas = null;
let sideboardCtx = null;
let padShown = false;
let padColorMode = 'split'; // 'split' | 'red' | 'blue'
let streamChannel = null;

function padEl(id) {
  return document.getElementById(id);
}

export function duoPadIsOpen() {
  return padShown;
}

function inkFor(y, height) {
  if (padColorMode === 'red') return PAD_TOP_INK;
  if (padColorMode === 'blue') return PAD_BOTTOM_INK;
  return y < height / 2 ? PAD_TOP_INK : PAD_BOTTOM_INK;
}

function padPos(e) {
  const rect = padCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function drawDivider(width, height) {
  if (!padCtx || padColorMode !== 'split') {
    return;
  }
  padCtx.save();
  padCtx.strokeStyle = PAD_DIVIDER;
  padCtx.lineWidth = 2;
  padCtx.setLineDash([10, 12]);
  padCtx.beginPath();
  padCtx.moveTo(10, height / 2);
  padCtx.lineTo(width - 10, height / 2);
  padCtx.stroke();
  padCtx.restore();
}

function applyPadModeUI(opponentTitle = '', opponentColor = '') {
  const isSplit = padColorMode === 'split';
  const topLabel = padEl('zlabel-top');
  const bottomLabel = padEl('zlabel-bottom');
  if (topLabel) topLabel.hidden = !isSplit;
  if (bottomLabel) bottomLabel.hidden = !isSplit;

  const sideboard = padEl('pad-sideboard');
  if (sideboard) {
    sideboard.hidden = isSplit;
    if (!isSplit) {
      const titleEl = padEl('sideboard-title');
      const dotEl = padEl('sideboard-dot');
      if (titleEl) {
        titleEl.textContent = opponentTitle || (padColorMode === 'red' ? 'Blue Team' : 'Red Team');
      }
      if (dotEl) {
        dotEl.style.background = opponentColor || (padColorMode === 'red' ? PAD_BOTTOM_INK : PAD_TOP_INK);
      }
    }
  }
}

/**
 * Match the backing store to the element at device resolution.
 * Preserves the existing artwork across small viewport shifts.
 */
function padLayout() {
  if (!padCtx || !padCanvas) {
    return;
  }
  const rect = padCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (padCanvas.width === w && padCanvas.height === h) {
    sideboardLayout();
    return;
  }

  const oldW = padCanvas.width;
  const oldH = padCanvas.height;
  let backup = null;
  if (oldW > 0 && oldH > 0) {
    backup = document.createElement('canvas');
    backup.width = oldW;
    backup.height = oldH;
    const bCtx = backup.getContext('2d');
    if (bCtx) {
      bCtx.drawImage(padCanvas, 0, 0);
    }
  }

  padCanvas.width = w;
  padCanvas.height = h;
  padCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  padCtx.clearRect(0, 0, rect.width, rect.height);
  drawDivider(rect.width, rect.height);

  if (backup) {
    padCtx.save();
    padCtx.setTransform(1, 0, 0, 1, 0, 0);
    padCtx.drawImage(backup, 0, 0, w, h);
    padCtx.restore();
  }

  sideboardLayout();
}

function sideboardLayout() {
  if (!sideboardCtx || !sideboardCanvas) {
    return;
  }
  const rect = sideboardCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (sideboardCanvas.width === w && sideboardCanvas.height === h) {
    return;
  }

  const oldW = sideboardCanvas.width;
  const oldH = sideboardCanvas.height;
  let backup = null;
  if (oldW > 0 && oldH > 0) {
    backup = document.createElement('canvas');
    backup.width = oldW;
    backup.height = oldH;
    const bCtx = backup.getContext('2d');
    if (bCtx) {
      bCtx.drawImage(sideboardCanvas, 0, 0);
    }
  }

  sideboardCanvas.width = w;
  sideboardCanvas.height = h;
  sideboardCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sideboardCtx.clearRect(0, 0, rect.width, rect.height);

  if (backup) {
    sideboardCtx.save();
    sideboardCtx.setTransform(1, 0, 0, 1, 0, 0);
    sideboardCtx.drawImage(backup, 0, 0, w, h);
    sideboardCtx.restore();
  }
}

let strokeBatch = [];
let strokeFlushTimer = null;

function flushStrokeBatch() {
  if (strokeBatch.length === 0) return;
  if (typeof sendP2P === 'function') {
    sendP2P('STROKES', { from: padColorMode, pts: strokeBatch });
  }
  strokeBatch = [];
}

function queueStroke(aNorm, bNorm, color) {
  strokeBatch.push({
    a: { x: Math.round(aNorm.x * 1000) / 1000, y: Math.round(aNorm.y * 1000) / 1000 },
    b: { x: Math.round(bNorm.x * 1000) / 1000, y: Math.round(bNorm.y * 1000) / 1000 },
    c: color,
  });
  if (!strokeFlushTimer) {
    strokeFlushTimer = setTimeout(() => {
      strokeFlushTimer = null;
      flushStrokeBatch();
    }, 25);
  }
}

function padStroke(a, b, color) {
  if (!padCtx) {
    return;
  }
  padCtx.strokeStyle = color;
  padCtx.lineWidth = PAD_STROKE_W;
  padCtx.lineCap = 'round';
  padCtx.lineJoin = 'round';
  padCtx.beginPath();
  padCtx.moveTo(a.x, a.y);
  padCtx.lineTo(b.x + 0.01, b.y + 0.01);
  padCtx.stroke();

  if (padCanvas) {
    const rect = padCanvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const aNorm = { x: a.x / rect.width, y: a.y / rect.height };
      const bNorm = { x: b.x / rect.width, y: b.y / rect.height };
      queueStroke(aNorm, bNorm, color);
      if (streamChannel) {
        try {
          streamChannel.postMessage({ type: 'stroke', from: padColorMode, aNorm, bNorm, color });
        } catch (err) {}
      }
    }
  }
}

function sideboardStroke(a, b, color) {
  if (!sideboardCtx) {
    return;
  }
  sideboardCtx.strokeStyle = color;
  sideboardCtx.lineWidth = SIDEBOARD_STROKE_W;
  sideboardCtx.lineCap = 'round';
  sideboardCtx.lineJoin = 'round';
  sideboardCtx.beginPath();
  sideboardCtx.moveTo(a.x, a.y);
  sideboardCtx.lineTo(b.x + 0.01, b.y + 0.01);
  sideboardCtx.stroke();
}

export function renderIncomingStroke(from, aNorm, bNorm, color) {
  if (!sideboardCtx || !sideboardCanvas || from === padColorMode) {
    return;
  }
  const rect = sideboardCanvas.getBoundingClientRect();
  const sa = { x: aNorm.x * rect.width, y: aNorm.y * rect.height };
  const sb = { x: bNorm.x * rect.width, y: bNorm.y * rect.height };
  sideboardStroke(sa, sb, color);
}

export function renderIncomingBatch(from, pts = []) {
  if (!sideboardCtx || !sideboardCanvas || from === padColorMode) {
    return;
  }
  const rect = sideboardCanvas.getBoundingClientRect();
  for (const item of pts) {
    if (!item || !item.a || !item.b) continue;
    const sa = { x: item.a.x * rect.width, y: item.a.y * rect.height };
    const sb = { x: item.b.x * rect.width, y: item.b.y * rect.height };
    sideboardStroke(sa, sb, item.c || PAD_TOP_INK);
  }
}

function clearPad() {
  if (!padCtx || !padCanvas) {
    return;
  }
  const rect = padCanvas.getBoundingClientRect();
  padCtx.clearRect(0, 0, rect.width, rect.height);
  drawDivider(rect.width, rect.height);

  if (typeof sendP2P === 'function') {
    sendP2P('CLEAR', { from: padColorMode });
  }

  if (streamChannel) {
    try {
      streamChannel.postMessage({ type: 'clear', from: padColorMode });
    } catch (err) {}
  }
}

export function clearIncomingSideboard(from) {
  if (from === padColorMode) {
    return;
  }
  if (!sideboardCtx || !sideboardCanvas) {
    return;
  }
  const rect = sideboardCanvas.getBoundingClientRect();
  sideboardCtx.clearRect(0, 0, rect.width, rect.height);
}

export function openDuoPad({
  colorMode = 'split',
  title = 'Drawing Sheet',
  opponentTitle = '',
  opponentColor = '',
} = {}) {
  padColorMode = colorMode;
  padShown = true;
  const pad = padEl('duo-pad');
  if (pad) pad.hidden = false;
  const titleEl = padEl('pad-title');
  if (titleEl) titleEl.textContent = title;
  applyPadModeUI(opponentTitle, opponentColor);
  requestAnimationFrame(padLayout);
}

export function closeDuoPad() {
  if (!padShown) {
    return;
  }
  padShown = false;
  const pad = padEl('duo-pad');
  if (pad) pad.hidden = true;
  padPointers.clear();
}

export function wireDuoPad() {
  padCanvas = padEl('pad-canvas');
  if (padCanvas) {
    padCtx = padCanvas.getContext ? padCanvas.getContext('2d') : null;
  }

  sideboardCanvas = padEl('sideboard-canvas');
  if (sideboardCanvas) {
    sideboardCtx = sideboardCanvas.getContext ? sideboardCanvas.getContext('2d') : null;
  }

  if (typeof BroadcastChannel !== 'undefined' && !streamChannel) {
    try {
      streamChannel = new BroadcastChannel('mnm-duo-stream');
      streamChannel.onmessage = (e) => {
        const msg = e.data;
        if (!msg || msg.from === padColorMode) return;

        if (msg.type === 'stroke' && sideboardCanvas && sideboardCtx) {
          const rect = sideboardCanvas.getBoundingClientRect();
          const sa = { x: msg.aNorm.x * rect.width, y: msg.aNorm.y * rect.height };
          const sb = { x: msg.bNorm.x * rect.width, y: msg.bNorm.y * rect.height };
          sideboardStroke(sa, sb, msg.color);
        } else if (msg.type === 'clear') {
          clearIncomingSideboard(msg.from);
        }
      };
    } catch (err) {
      streamChannel = null;
    }
  }

  const clearBtn = padEl('pad-clear');
  if (clearBtn) clearBtn.onclick = clearPad;
  const doneBtn = padEl('pad-done');
  if (doneBtn) doneBtn.onclick = closeDuoPad;

  if (padCanvas) {
    padCanvas.addEventListener('pointerdown', (e) => {
      if (!padCtx) {
        return;
      }
      e.preventDefault();
      const p = padPos(e);
      const rect = padCanvas.getBoundingClientRect();
      const color = inkFor(p.y, rect.height);
      padPointers.set(e.pointerId, { ...p, color });
      try {
        padCanvas.setPointerCapture(e.pointerId);
      } catch (err) {
        /* capture is a nicety; drawing works without it */
      }
      padStroke(p, p, color);
    });

    padCanvas.addEventListener('pointermove', (e) => {
      const last = padPointers.get(e.pointerId);
      if (!last || !padCtx) {
        return;
      }
      e.preventDefault();
      const p = padPos(e);
      padStroke(last, p, last.color);
      last.x = p.x;
      last.y = p.y;
    });

    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => {
      padCanvas.addEventListener(ev, (e) => {
        padPointers.delete(e.pointerId);
      });
    });

    padCanvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
  }

  window.addEventListener('resize', () => {
    if (padShown) {
      padLayout();
    }
  });
}
