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
 *   live strokes in real time via BroadcastChannel and WebSocket MQTT relay.
 *
 * In all modes, the secret word is deliberately not shown on the drawing pad
 * so guessers in the room can look directly at the phone screen without seeing
 * the answer.
 */

import { sendP2P } from './p2p.js';

const PAD_TOP_INK = '#FF4262';
const PAD_BOTTOM_INK = '#3D9BFF';
const PAD_DIVIDER = 'rgba(247,244,236,.28)';

const PEN_SIZES = { sm: 2.5, md: 5, lg: 9 };
const ERASER_SIZES = { sm: 16, md: 26, lg: 40 };

/** pointerId -> {x, y, color, width, tool, segments}; multi-touch supported. */
const padPointers = new Map();

let padCanvas = null;
let padCtx = null;
let sideboardCanvas = null;
let sideboardCtx = null;
let padShown = false;
let padColorMode = 'split'; // 'split' | 'red' | 'blue'
let streamChannel = null;

let currentTool = 'pen'; // 'pen' | 'eraser'
let currentSize = 'md'; // 'sm' | 'md' | 'lg'
let currentColor = 'team'; // 'team' | hex string

const strokeHistory = [];
const opponentStrokeHistory = [];

function padEl(id) {
  return document.getElementById(id);
}

export function duoPadIsOpen() {
  return padShown;
}

function resolveColor(y, height) {
  if (currentTool === 'eraser') return 'eraser';
  if (currentColor !== 'team') return currentColor;
  if (padColorMode === 'red') return PAD_TOP_INK;
  if (padColorMode === 'blue') return PAD_BOTTOM_INK;
  return y < height / 2 ? PAD_TOP_INK : PAD_BOTTOM_INK;
}

function resolveWidth() {
  return currentTool === 'eraser' ? ERASER_SIZES[currentSize] : PEN_SIZES[currentSize];
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

  const swatchTeam = padEl('swatch-team');
  if (swatchTeam) {
    if (padColorMode === 'red') {
      swatchTeam.style.background = PAD_TOP_INK;
    } else if (padColorMode === 'blue') {
      swatchTeam.style.background = PAD_BOTTOM_INK;
    } else {
      swatchTeam.style.background = 'linear-gradient(135deg, #FF4262 50%, #3D9BFF 50%)';
    }
  }

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

function redrawPadCanvas() {
  if (!padCtx || !padCanvas) return;
  const rect = padCanvas.getBoundingClientRect();
  padCtx.clearRect(0, 0, rect.width, rect.height);
  drawDivider(rect.width, rect.height);

  for (const s of strokeHistory) {
    if (!s || !s.segments || s.segments.length === 0) continue;
    padCtx.save();
    if (s.tool === 'eraser') {
      padCtx.globalCompositeOperation = 'destination-out';
      padCtx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      padCtx.globalCompositeOperation = 'source-over';
      padCtx.strokeStyle = s.color;
    }
    padCtx.lineWidth = s.width;
    padCtx.lineCap = 'round';
    padCtx.lineJoin = 'round';

    for (const seg of s.segments) {
      const ax = seg.aNorm.x * rect.width;
      const ay = seg.aNorm.y * rect.height;
      const bx = seg.bNorm.x * rect.width;
      const by = seg.bNorm.y * rect.height;
      padCtx.beginPath();
      padCtx.moveTo(ax, ay);
      padCtx.lineTo(bx + 0.01, by + 0.01);
      padCtx.stroke();
    }
    padCtx.restore();
  }
}

function redrawSideboardCanvas() {
  if (!sideboardCtx || !sideboardCanvas) return;
  const rect = sideboardCanvas.getBoundingClientRect();
  sideboardCtx.clearRect(0, 0, rect.width, rect.height);

  for (const s of opponentStrokeHistory) {
    if (!s || !s.segments || s.segments.length === 0) continue;
    sideboardCtx.save();
    if (s.tool === 'eraser') {
      sideboardCtx.globalCompositeOperation = 'destination-out';
      sideboardCtx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      sideboardCtx.globalCompositeOperation = 'source-over';
      sideboardCtx.strokeStyle = s.color;
    }
    sideboardCtx.lineWidth = Math.max(1.5, s.width * 0.4);
    sideboardCtx.lineCap = 'round';
    sideboardCtx.lineJoin = 'round';

    for (const seg of s.segments) {
      const ax = seg.aNorm.x * rect.width;
      const ay = seg.aNorm.y * rect.height;
      const bx = seg.bNorm.x * rect.width;
      const by = seg.bNorm.y * rect.height;
      sideboardCtx.beginPath();
      sideboardCtx.moveTo(ax, ay);
      sideboardCtx.lineTo(bx + 0.01, by + 0.01);
      sideboardCtx.stroke();
    }
    sideboardCtx.restore();
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

  padCanvas.width = w;
  padCanvas.height = h;
  padCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redrawPadCanvas();
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

  sideboardCanvas.width = w;
  sideboardCanvas.height = h;
  sideboardCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redrawSideboardCanvas();
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

function queueStroke(aNorm, bNorm, color, width, tool, strokeId) {
  strokeBatch.push({
    id: strokeId,
    a: { x: Math.round(aNorm.x * 1000) / 1000, y: Math.round(aNorm.y * 1000) / 1000 },
    b: { x: Math.round(bNorm.x * 1000) / 1000, y: Math.round(bNorm.y * 1000) / 1000 },
    c: color,
    w: width,
    t: tool,
  });
  if (!strokeFlushTimer) {
    strokeFlushTimer = setTimeout(() => {
      strokeFlushTimer = null;
      flushStrokeBatch();
    }, 25);
  }
}

function padStroke(a, b, color, width, tool = 'pen', strokeId = '') {
  if (!padCtx) {
    return;
  }
  padCtx.save();
  if (tool === 'eraser') {
    padCtx.globalCompositeOperation = 'destination-out';
    padCtx.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    padCtx.globalCompositeOperation = 'source-over';
    padCtx.strokeStyle = color;
  }
  padCtx.lineWidth = width;
  padCtx.lineCap = 'round';
  padCtx.lineJoin = 'round';
  padCtx.beginPath();
  padCtx.moveTo(a.x, a.y);
  padCtx.lineTo(b.x + 0.01, b.y + 0.01);
  padCtx.stroke();
  padCtx.restore();

  if (padCanvas) {
    const rect = padCanvas.getBoundingClientRect();
    if (tool === 'eraser' && padColorMode === 'split') {
      drawDivider(rect.width, rect.height);
    }
    if (rect.width > 0 && rect.height > 0) {
      const aNorm = { x: a.x / rect.width, y: a.y / rect.height };
      const bNorm = { x: b.x / rect.width, y: b.y / rect.height };
      queueStroke(aNorm, bNorm, color, width, tool, strokeId);
      if (streamChannel) {
        try {
          streamChannel.postMessage({ type: 'stroke', from: padColorMode, aNorm, bNorm, color, width, tool, id: strokeId });
        } catch (err) {}
      }
    }
  }
}

function sideboardStroke(a, b, color, width = 4, tool = 'pen') {
  if (!sideboardCtx) {
    return;
  }
  sideboardCtx.save();
  if (tool === 'eraser') {
    sideboardCtx.globalCompositeOperation = 'destination-out';
    sideboardCtx.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    sideboardCtx.globalCompositeOperation = 'source-over';
    sideboardCtx.strokeStyle = color;
  }
  sideboardCtx.lineWidth = Math.max(1.5, width * 0.4);
  sideboardCtx.lineCap = 'round';
  sideboardCtx.lineJoin = 'round';
  sideboardCtx.beginPath();
  sideboardCtx.moveTo(a.x, a.y);
  sideboardCtx.lineTo(b.x + 0.01, b.y + 0.01);
  sideboardCtx.stroke();
  sideboardCtx.restore();
}

export function renderIncomingStroke(from, aNorm, bNorm, color, width = 4, tool = 'pen') {
  if (!sideboardCtx || !sideboardCanvas || from === padColorMode) {
    return;
  }
  const rect = sideboardCanvas.getBoundingClientRect();
  const sa = { x: aNorm.x * rect.width, y: aNorm.y * rect.height };
  const sb = { x: bNorm.x * rect.width, y: bNorm.y * rect.height };
  sideboardStroke(sa, sb, color, width, tool);
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
    const tool = item.t || 'pen';
    const color = item.c || PAD_TOP_INK;
    const width = item.w || 4;
    sideboardStroke(sa, sb, color, width, tool);

    const strokeId = item.id;
    const lastOpponentStroke = opponentStrokeHistory[opponentStrokeHistory.length - 1];
    if (lastOpponentStroke && strokeId && lastOpponentStroke.id === strokeId) {
      lastOpponentStroke.segments.push({ aNorm: item.a, bNorm: item.b });
    } else {
      opponentStrokeHistory.push({
        id: strokeId,
        tool,
        color,
        width,
        segments: [{ aNorm: item.a, bNorm: item.b }],
      });
    }
  }
}

export function undoPad() {
  if (strokeFlushTimer) {
    clearTimeout(strokeFlushTimer);
    strokeFlushTimer = null;
  }
  strokeBatch = [];
  if (strokeHistory.length === 0) return;
  strokeHistory.pop();
  redrawPadCanvas();
  if (typeof sendP2P === 'function') {
    sendP2P('UNDO', { from: padColorMode });
  }
  if (streamChannel) {
    try {
      streamChannel.postMessage({ type: 'undo', from: padColorMode });
    } catch (err) {}
  }
}

export function renderIncomingUndo(from) {
  if (from === padColorMode) return;
  if (opponentStrokeHistory.length > 0) {
    opponentStrokeHistory.pop();
  }
  redrawSideboardCanvas();
}

function clearPad() {
  if (strokeFlushTimer) {
    clearTimeout(strokeFlushTimer);
    strokeFlushTimer = null;
  }
  strokeBatch = [];
  strokeHistory.length = 0;
  if (padCtx && padCanvas) {
    const rect = padCanvas.getBoundingClientRect();
    padCtx.clearRect(0, 0, rect.width, rect.height);
    drawDivider(rect.width, rect.height);
  }

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
  opponentStrokeHistory.length = 0;
  if (!sideboardCtx || !sideboardCanvas) {
    return;
  }
  const rect = sideboardCanvas.getBoundingClientRect();
  sideboardCtx.clearRect(0, 0, rect.width, rect.height);
}

export function resetDuoPad() {
  if (strokeFlushTimer) {
    clearTimeout(strokeFlushTimer);
    strokeFlushTimer = null;
  }
  strokeBatch = [];
  strokeHistory.length = 0;
  opponentStrokeHistory.length = 0;
  padPointers.clear();
  redrawPadCanvas();
  redrawSideboardCanvas();
}

export function getPadSnapshot() {
  if (!padCanvas || strokeHistory.length === 0) return null;
  try {
    return padCanvas.toDataURL('image/png');
  } catch (err) {
    return null;
  }
}

export function getCurrentStrokes() {
  return JSON.parse(JSON.stringify(strokeHistory));
}

export function openDuoPad({
  colorMode = 'split',
  opponentTitle = '',
  opponentColor = '',
} = {}) {
  padColorMode = colorMode;
  padShown = true;
  const pad = padEl('duo-pad');
  if (pad) pad.hidden = false;
  applyPadModeUI(opponentTitle, opponentColor);
  requestAnimationFrame(padLayout);
}

export function closeDuoPad() {
  if (!padShown) {
    return;
  }
  flushStrokeBatch();
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
          sideboardStroke(sa, sb, msg.color, msg.width, msg.tool);

          const strokeId = msg.id;
          const lastOpponentStroke = opponentStrokeHistory[opponentStrokeHistory.length - 1];
          if (lastOpponentStroke && strokeId && lastOpponentStroke.id === strokeId) {
            lastOpponentStroke.segments.push({ aNorm: msg.aNorm, bNorm: msg.bNorm });
          } else {
            opponentStrokeHistory.push({
              id: strokeId,
              tool: msg.tool,
              color: msg.color,
              width: msg.width,
              segments: [{ aNorm: msg.aNorm, bNorm: msg.bNorm }],
            });
          }
        } else if (msg.type === 'undo') {
          renderIncomingUndo(msg.from);
        } else if (msg.type === 'clear') {
          clearIncomingSideboard(msg.from);
        }
      };
    } catch (err) {
      streamChannel = null;
    }
  }

  const penBtn = padEl('pad-tool-pen');
  const eraserBtn = padEl('pad-tool-eraser');
  if (penBtn && eraserBtn) {
    penBtn.onclick = () => {
      currentTool = 'pen';
      penBtn.classList.add('is-active');
      eraserBtn.classList.remove('is-active');
    };
    eraserBtn.onclick = () => {
      currentTool = 'eraser';
      eraserBtn.classList.add('is-active');
      penBtn.classList.remove('is-active');
    };
  }

  const sizeBtns = document.querySelectorAll('.pad-size-btn');
  sizeBtns.forEach((btn) => {
    btn.onclick = () => {
      sizeBtns.forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      currentSize = btn.dataset.size || 'md';
    };
  });

  const swatches = document.querySelectorAll('.pad-color-swatch');
  swatches.forEach((swatch) => {
    swatch.onclick = () => {
      swatches.forEach((s) => s.classList.remove('is-active'));
      swatch.classList.add('is-active');
      currentColor = swatch.dataset.color || 'team';
      currentTool = 'pen';
      if (penBtn) penBtn.classList.add('is-active');
      if (eraserBtn) eraserBtn.classList.remove('is-active');
    };
  });

  const undoBtn = padEl('pad-undo');
  if (undoBtn) undoBtn.onclick = undoPad;

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
      const color = resolveColor(p.y, rect.height);
      const width = resolveWidth();
      const tool = currentTool;
      const strokeId = 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

      const aNorm = rect.width > 0 && rect.height > 0 ? { x: p.x / rect.width, y: p.y / rect.height } : { x: 0, y: 0 };
      const bNorm = rect.width > 0 && rect.height > 0 ? { x: (p.x + 0.01) / rect.width, y: (p.y + 0.01) / rect.height } : { x: 0, y: 0 };

      const currentStroke = {
        id: strokeId,
        tool,
        color,
        width,
        segments: [{ aNorm, bNorm }],
      };

      padPointers.set(e.pointerId, { ...p, color, width, tool, strokeId, stroke: currentStroke });
      try {
        padCanvas.setPointerCapture(e.pointerId);
      } catch (err) {
        /* capture is a nicety; drawing works without it */
      }
      padStroke(p, p, color, width, tool, strokeId);
    });

    padCanvas.addEventListener('pointermove', (e) => {
      const last = padPointers.get(e.pointerId);
      if (!last || !padCtx) {
        return;
      }
      e.preventDefault();
      const p = padPos(e);
      const rect = padCanvas.getBoundingClientRect();
      padStroke(last, p, last.color, last.width, last.tool, last.strokeId);

      if (rect.width > 0 && rect.height > 0) {
        const aNorm = { x: last.x / rect.width, y: last.y / rect.height };
        const bNorm = { x: p.x / rect.width, y: p.y / rect.height };
        if (last.stroke) {
          last.stroke.segments.push({ aNorm, bNorm });
        }
      }

      last.x = p.x;
      last.y = p.y;
    });

    const endPointer = (e) => {
      const last = padPointers.get(e.pointerId);
      if (last && last.stroke && last.stroke.segments.length > 0) {
        strokeHistory.push(last.stroke);
      }
      padPointers.delete(e.pointerId);
    };

    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => {
      padCanvas.addEventListener(ev, endPointer);
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

