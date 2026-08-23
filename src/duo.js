/**
 * duo.js - shared or single-team touch drawing surface.
 *
 * Solo mode (one phone):
 *   The canvas splits into two halves (Red top, Blue bottom) with multi-touch
 *   so both artists draw on the shared screen simultaneously.
 *
 * Multi-device mode (phone per team):
 *   Each team draws full-screen in their respective team color (Red on host,
 *   Blue on guest).
 *
 * In all modes, the secret word is deliberately not shown on the drawing pad
 * so guessers in the room can look directly at the phone screen without seeing
 * the answer.
 */

const PAD_TOP_INK = '#FF4262';
const PAD_BOTTOM_INK = '#3D9BFF';
const PAD_DIVIDER = 'rgba(247,244,236,.28)';
const PAD_STROKE_W = 4;

/** pointerId -> {x, y, color}; multi-touch means several can be live at once. */
const padPointers = new Map();

let padCanvas = null;
let padCtx = null;
let padShown = false;
let padColorMode = 'split'; // 'split' | 'red' | 'blue'

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

function applyPadModeUI() {
  const isSplit = padColorMode === 'split';
  const topLabel = padEl('zlabel-top');
  const bottomLabel = padEl('zlabel-bottom');
  if (topLabel) topLabel.hidden = !isSplit;
  if (bottomLabel) bottomLabel.hidden = !isSplit;
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
}

function clearPad() {
  if (!padCtx || !padCanvas) {
    return;
  }
  const rect = padCanvas.getBoundingClientRect();
  padCtx.clearRect(0, 0, rect.width, rect.height);
  drawDivider(rect.width, rect.height);
}

export function openDuoPad({ colorMode = 'split', title = 'Drawing Sheet' } = {}) {
  padColorMode = colorMode;
  padShown = true;
  const pad = padEl('duo-pad');
  if (pad) pad.hidden = false;
  const titleEl = padEl('pad-title');
  if (titleEl) titleEl.textContent = title;
  applyPadModeUI();
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
  if (!padCanvas) {
    return;
  }
  padCtx = padCanvas.getContext ? padCanvas.getContext('2d') : null;

  const clearBtn = padEl('pad-clear');
  if (clearBtn) clearBtn.onclick = clearPad;
  const doneBtn = padEl('pad-done');
  if (doneBtn) doneBtn.onclick = closeDuoPad;

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

  window.addEventListener('resize', () => {
    if (padShown) {
      padLayout();
    }
  });
}
