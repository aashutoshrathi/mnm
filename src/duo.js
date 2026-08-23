/**
 * duo.js - one phone, two artists.
 *
 * The solo huddle assumes paper exists somewhere in the room. Sometimes it
 * doesn't. This turns the phone itself into the shared sheet: a full-screen
 * canvas split into two halves by a dashed line, with real multi-touch so two
 * fingers draw at once. Each artist's strokes take their half's colour (marker
 * red above the line, marker blue below), decided by where the stroke starts,
 * so crossing the line to steal space keeps your colour.
 *
 * Because both artists share one screen, "live updates" are free - this is the
 * one drawing surface that needs no network, no WebRTC, no anything. It is
 * deliberately an overlay: the clock keeps running underneath it, and the panic
 * veil still covers everything.
 *
 * Graceful degradation: if canvas 2D is unavailable (some embedded webviews),
 * the buttons keep working and the surface simply stays blank rather than
 * throwing mid-party.
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
let padGetWord = () => '';

function padEl(id) {
  return document.getElementById(id);
}

export function duoPadIsOpen() {
  return padShown;
}

function inkFor(y, height) {
  return y < height / 2 ? PAD_TOP_INK : PAD_BOTTOM_INK;
}

function padPos(e) {
  const rect = padCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function drawDivider(width, height) {
  if (!padCtx) {
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

/**
 * Match the backing store to the element at device resolution.
 * Preserves the existing artwork across small viewport shifts (e.g. browser
 * address bar collapsing on scroll).
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

export function openDuoPad() {
  padShown = true;
  padEl('duo-pad').hidden = false;
  requestAnimationFrame(padLayout);
}

export function closeDuoPad() {
  if (!padShown) {
    return;
  }
  padShown = false;
  padEl('duo-pad').hidden = true;
  padPointers.clear();
}

export function wireDuoPad({ getWord = () => '' } = {}) {
  padGetWord = getWord;
  padCanvas = padEl('pad-canvas');
  if (!padCanvas) {
    return;
  }
  padCtx = padCanvas.getContext ? padCanvas.getContext('2d') : null;

  padEl('pad-clear').onclick = clearPad;
  padEl('pad-done').onclick = closeDuoPad;

  const wordBtn = padEl('pad-word');
  wordBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    wordBtn.classList.add('showing');
    wordBtn.textContent = padGetWord();
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => {
    wordBtn.addEventListener(ev, () => {
      wordBtn.classList.remove('showing');
      wordBtn.textContent = 'Hold for the word';
    });
  });

  padCanvas.addEventListener('pointerdown', (e) => {
    if (!padCtx) {
      return;
    }
    e.preventDefault();
    const p = padPos(e);
    const rect = padCanvas.getBoundingClientRect();
    padPointers.set(e.pointerId, { ...p, color: inkFor(p.y, rect.height) });
    try {
      padCanvas.setPointerCapture(e.pointerId);
    } catch (err) {
      /* capture is a nicety; drawing works without it */
    }
    padStroke(p, p, inkFor(p.y, rect.height));
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

  [padCanvas, wordBtn].forEach((el) => {
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
  });

  window.addEventListener('resize', () => {
    if (padShown) {
      padLayout();
    }
  });
}
