/**
 * duo.js - shared or single-team touch drawing surface with real-time sideboard.
 *
 * Solo mode (one phone):
 *   The canvas splits into two halves (Red top, Blue bottom) with multi-touch
 *   so both artists draw on the shared screen simultaneously.
 *   Each team has its own independent toolbar: Brush sizes, Pen/Eraser tools,
 *   color palettes, team-isolated Undo, and team-isolated Clear buttons.
 *
 * Multi-device mode (phone per team):
 *   Each team draws on a major full-screen board in their team color (Red on host,
 *   Blue on guest), while a compact read-only sideboard displays the opponent's
 *   live strokes in real time with exact aspect ratio and scaled stroke widths.
 *   Direct in-pad scoring buttons allow players to claim points or mark "Other Team Guessed".
 *
 * In all modes, the secret word is deliberately not shown on the drawing pad.
 */

import { sendP2P } from './p2p.js';

const PAD_TOP_INK = '#FF4262';
const PAD_BOTTOM_INK = '#3D9BFF';
const PAD_DIVIDER = 'rgba(247,244,236,.28)';

const PEN_SIZES = { sm: 2.5, md: 5, lg: 9 };
const ERASER_SIZES = { sm: 16, md: 26, lg: 40 };

/** pointerId -> {x, y, team, color, width, tool, strokeId, stroke} */
const padPointers = new Map();

let padCanvas = null;
let padCtx = null;
let sideboardCanvas = null;
let sideboardCtx = null;
let padShown = false;
let padColorMode = 'split'; // 'split' | 'red' | 'blue'

// Single / Multi-device active tools
let singleTool = 'pen';
let singleSize = 'md';
let singleColor = 'team';

// Solo split team tools (independent per team)
const redState = {
  tool: 'pen',
  size: 'md',
  color: '#FF4262',
};

const blueState = {
  tool: 'pen',
  size: 'md',
  color: '#3D9BFF',
};

const strokeHistory = [];
const opponentStrokeHistory = [];

let onScoreCallback = null;

function padEl(id) {
  return document.getElementById(id);
}

export function setPadScoreCallback(fn) {
  onScoreCallback = fn;
}

export function duoPadIsOpen() {
  return padShown;
}

function resolveSoloTeam(y, height) {
  return y < height / 2 ? 'red' : 'blue';
}

function resolveStrokeSettings(team, y, height) {
  if (padColorMode === 'split') {
    const isRed = team === 'red' || (y < height / 2);
    const state = isRed ? redState : blueState;
    const tool = state.tool;
    const width = tool === 'eraser' ? ERASER_SIZES[state.size] : PEN_SIZES[state.size];
    const color = tool === 'eraser' ? 'eraser' : state.color;
    return { team: isRed ? 'red' : 'blue', tool, width, color };
  }

  const tool = singleTool;
  const width = tool === 'eraser' ? ERASER_SIZES[singleSize] : PEN_SIZES[singleSize];
  let color = singleColor;
  if (tool === 'eraser') {
    color = 'eraser';
  } else if (singleColor === 'team') {
    color = padColorMode === 'red' ? PAD_TOP_INK : PAD_BOTTOM_INK;
  }
  return { team: padColorMode, tool, width, color };
}

function padPos(e) {
  if (!padCanvas) return { x: 0, y: 0 };
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

function applyPadModeUI(opponentTitle = '', opponentColor = '', team0Name = 'Red', team1Name = 'Blue') {
  const isSplit = padColorMode === 'split';
  const topLabel = padEl('zlabel-top');
  const bottomLabel = padEl('zlabel-bottom');
  if (topLabel) {
    topLabel.hidden = !isSplit;
    topLabel.textContent = `${team0Name} draws up here`;
  }
  if (bottomLabel) {
    bottomLabel.hidden = !isSplit;
    bottomLabel.textContent = `${team1Name} draws down here`;
  }

  // Toggle Solo Split controls vs Single/Multi-device controls
  const redControls = padEl('pad-red-controls');
  const blueControls = padEl('pad-blue-controls');
  const singleControls = padEl('pad-single-controls');
  const scoreActions = padEl('pad-score-actions');

  if (redControls) redControls.hidden = !isSplit;
  if (blueControls) blueControls.hidden = !isSplit;
  if (singleControls) singleControls.hidden = isSplit;
  if (scoreActions) scoreActions.hidden = false;

  const redBarLabel = padEl('red-bar-label');
  if (redBarLabel) redBarLabel.textContent = team0Name;
  const blueBarLabel = padEl('blue-bar-label');
  if (blueBarLabel) blueBarLabel.textContent = team1Name;

  // Set up in-pad score buttons
  const myTeamBtn = padEl('pad-btn-myteam');
  const otherTeamBtn = padEl('pad-btn-otherteam');

  if (myTeamBtn && otherTeamBtn) {
    if (isSplit) {
      myTeamBtn.textContent = `${team0Name} Got It!`;
      myTeamBtn.style.background = PAD_TOP_INK;
      myTeamBtn.style.color = '#FFFFFF';
      otherTeamBtn.textContent = `${team1Name} Got It!`;
      otherTeamBtn.style.background = PAD_BOTTOM_INK;
      otherTeamBtn.style.color = '#12142A';
    } else if (padColorMode === 'red') {
      myTeamBtn.textContent = `${team0Name} Got It!`;
      myTeamBtn.style.background = PAD_TOP_INK;
      myTeamBtn.style.color = '#FFFFFF';
      otherTeamBtn.textContent = 'Other Team Guessed';
      otherTeamBtn.style.background = 'rgba(247, 244, 236, 0.16)';
      otherTeamBtn.style.color = '#FFFFFF';
    } else {
      myTeamBtn.textContent = `${team1Name} Got It!`;
      myTeamBtn.style.background = PAD_BOTTOM_INK;
      myTeamBtn.style.color = '#12142A';
      otherTeamBtn.textContent = 'Other Team Guessed';
      otherTeamBtn.style.background = 'rgba(247, 244, 236, 0.16)';
      otherTeamBtn.style.color = '#FFFFFF';
    }
  }

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
        titleEl.textContent = opponentTitle || (padColorMode === 'red' ? team1Name : team0Name);
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

  const scaleRatio = padCanvas && padCanvas.getBoundingClientRect().width > 0
    ? rect.width / padCanvas.getBoundingClientRect().width
    : 0.35;

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
    sideboardCtx.lineWidth = Math.max(1.5, s.width * scaleRatio);
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

/** Match backing stores to element layout and synchronize aspect ratios */
function padLayout() {
  if (!padCtx || !padCanvas) {
    return;
  }
  const rect = padCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));

  // Sync sideboard aspect ratio to main pad stage
  const sideBody = padEl('sideboard-body');
  if (sideBody && rect.width > 0 && rect.height > 0) {
    sideBody.style.aspectRatio = `${rect.width} / ${rect.height}`;
  }

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
    a: { x: Math.round(aNorm.x * 10000) / 10000, y: Math.round(aNorm.y * 10000) / 10000 },
    b: { x: Math.round(bNorm.x * 10000) / 10000, y: Math.round(bNorm.y * 10000) / 10000 },
    c: color,
    w: width,
    t: tool,
  });
  if (!strokeFlushTimer) {
    strokeFlushTimer = setTimeout(() => {
      strokeFlushTimer = null;
      flushStrokeBatch();
    }, 20);
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
    if (rect.width > 0 && rect.height > 0 && padColorMode !== 'split') {
      const aNorm = { x: a.x / rect.width, y: a.y / rect.height };
      const bNorm = { x: b.x / rect.width, y: b.y / rect.height };
      queueStroke(aNorm, bNorm, color, width, tool, strokeId);
    }
  }
}

function sideboardStroke(a, b, color, width = 4, tool = 'pen') {
  if (!sideboardCtx || !sideboardCanvas) {
    return;
  }
  const scaleRatio = padCanvas && padCanvas.getBoundingClientRect().width > 0
    ? sideboardCanvas.getBoundingClientRect().width / padCanvas.getBoundingClientRect().width
    : 0.35;

  sideboardCtx.save();
  if (tool === 'eraser') {
    sideboardCtx.globalCompositeOperation = 'destination-out';
    sideboardCtx.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    sideboardCtx.globalCompositeOperation = 'source-over';
    sideboardCtx.strokeStyle = color;
  }
  sideboardCtx.lineWidth = Math.max(1.5, width * scaleRatio);
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
  if (from === padColorMode || !Array.isArray(pts) || pts.length === 0) {
    return;
  }
  for (const item of pts) {
    if (!item || !item.a || !item.b) continue;
    const tool = item.t || 'pen';
    const color = item.c || (padColorMode === 'red' ? PAD_BOTTOM_INK : PAD_TOP_INK);
    const width = item.w || 4;

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

  if (!sideboardCtx || !sideboardCanvas) return;
  const rect = sideboardCanvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (sideboardCanvas.width !== w || sideboardCanvas.height !== h) {
    sideboardCanvas.width = w;
    sideboardCanvas.height = h;
    sideboardCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redrawSideboardCanvas();
    return;
  }

  for (const item of pts) {
    if (!item || !item.a || !item.b) continue;
    const sa = { x: item.a.x * rect.width, y: item.a.y * rect.height };
    const sb = { x: item.b.x * rect.width, y: item.b.y * rect.height };
    const tool = item.t || 'pen';
    const color = item.c || (padColorMode === 'red' ? PAD_BOTTOM_INK : PAD_TOP_INK);
    const width = item.w || 4;
    sideboardStroke(sa, sb, color, width, tool);
  }
}

/** Undo last stroke for Red in solo split mode */
export function undoRed() {
  for (let i = strokeHistory.length - 1; i >= 0; i--) {
    if (strokeHistory[i].team === 'red') {
      strokeHistory.splice(i, 1);
      break;
    }
  }
  redrawPadCanvas();
}

/** Undo last stroke for Blue in solo split mode */
export function undoBlue() {
  for (let i = strokeHistory.length - 1; i >= 0; i--) {
    if (strokeHistory[i].team === 'blue') {
      strokeHistory.splice(i, 1);
      break;
    }
  }
  redrawPadCanvas();
}

/** Clear all strokes for Red in solo split mode */
export function clearRed() {
  for (let i = strokeHistory.length - 1; i >= 0; i--) {
    if (strokeHistory[i].team === 'red') {
      strokeHistory.splice(i, 1);
    }
  }
  redrawPadCanvas();
}

/** Clear all strokes for Blue in solo split mode */
export function clearBlue() {
  for (let i = strokeHistory.length - 1; i >= 0; i--) {
    if (strokeHistory[i].team === 'blue') {
      strokeHistory.splice(i, 1);
    }
  }
  redrawPadCanvas();
}

export function undoPad() {
  if (padColorMode === 'split') {
    undoRed();
    return;
  }
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
}

export function renderIncomingUndo(from) {
  if (from === padColorMode) return;
  if (opponentStrokeHistory.length > 0) {
    opponentStrokeHistory.pop();
  }
  redrawSideboardCanvas();
}

export function clearPad() {
  if (padColorMode === 'split') {
    clearRed();
    clearBlue();
    return;
  }
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
  team0Name = 'Red',
  team1Name = 'Blue',
} = {}) {
  padColorMode = colorMode;
  padShown = true;
  const pad = padEl('duo-pad');
  if (pad) pad.hidden = false;

  applyPadModeUI(opponentTitle, opponentColor, team0Name, team1Name);
  requestAnimationFrame(() => {
    padLayout();
    sideboardLayout();
  });
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

  // Multi-device Single Team Tool Controls
  const penBtn = padEl('pad-tool-pen');
  const eraserBtn = padEl('pad-tool-eraser');
  if (penBtn && eraserBtn) {
    penBtn.onclick = () => {
      singleTool = 'pen';
      penBtn.classList.add('is-active');
      eraserBtn.classList.remove('is-active');
    };
    eraserBtn.onclick = () => {
      singleTool = 'eraser';
      eraserBtn.classList.add('is-active');
      penBtn.classList.remove('is-active');
    };
  }

  const sizeBtns = document.querySelectorAll('.pad-size-btn:not([data-team])');
  sizeBtns.forEach((btn) => {
    btn.onclick = () => {
      sizeBtns.forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      singleSize = btn.dataset.size || 'md';
    };
  });

  const swatches = document.querySelectorAll('.pad-color-swatch:not([data-team])');
  swatches.forEach((swatch) => {
    swatch.onclick = () => {
      swatches.forEach((s) => s.classList.remove('is-active'));
      swatch.classList.add('is-active');
      singleColor = swatch.dataset.color || 'team';
      singleTool = 'pen';
      if (penBtn) penBtn.classList.add('is-active');
      if (eraserBtn) eraserBtn.classList.remove('is-active');
    };
  });

  // Solo Split Red Controls
  const redPen = padEl('red-tool-pen');
  const redEraser = padEl('red-tool-eraser');
  if (redPen && redEraser) {
    redPen.onclick = () => {
      redState.tool = 'pen';
      redPen.classList.add('is-active');
      redEraser.classList.remove('is-active');
    };
    redEraser.onclick = () => {
      redState.tool = 'eraser';
      redEraser.classList.add('is-active');
      redPen.classList.remove('is-active');
    };
  }

  const redSizeBtns = document.querySelectorAll('.pad-size-btn[data-team="red"]');
  redSizeBtns.forEach((btn) => {
    btn.onclick = () => {
      redSizeBtns.forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      redState.size = btn.dataset.size || 'md';
    };
  });

  const redSwatches = document.querySelectorAll('.pad-color-swatch[data-team="red"]');
  redSwatches.forEach((swatch) => {
    swatch.onclick = () => {
      redSwatches.forEach((s) => s.classList.remove('is-active'));
      swatch.classList.add('is-active');
      redState.color = swatch.dataset.color || '#FF4262';
      redState.tool = 'pen';
      if (redPen) redPen.classList.add('is-active');
      if (redEraser) redEraser.classList.remove('is-active');
    };
  });

  const redUndo = padEl('red-undo');
  if (redUndo) redUndo.onclick = undoRed;
  const redClear = padEl('red-clear');
  if (redClear) redClear.onclick = clearRed;

  // Solo Split Blue Controls
  const bluePen = padEl('blue-tool-pen');
  const blueEraser = padEl('blue-tool-eraser');
  if (bluePen && blueEraser) {
    bluePen.onclick = () => {
      blueState.tool = 'pen';
      bluePen.classList.add('is-active');
      blueEraser.classList.remove('is-active');
    };
    blueEraser.onclick = () => {
      blueState.tool = 'eraser';
      blueEraser.classList.add('is-active');
      bluePen.classList.remove('is-active');
    };
  }

  const blueSizeBtns = document.querySelectorAll('.pad-size-btn[data-team="blue"]');
  blueSizeBtns.forEach((btn) => {
    btn.onclick = () => {
      blueSizeBtns.forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      blueState.size = btn.dataset.size || 'md';
    };
  });

  const blueSwatches = document.querySelectorAll('.pad-color-swatch[data-team="blue"]');
  blueSwatches.forEach((swatch) => {
    swatch.onclick = () => {
      blueSwatches.forEach((s) => s.classList.remove('is-active'));
      swatch.classList.add('is-active');
      blueState.color = swatch.dataset.color || '#3D9BFF';
      blueState.tool = 'pen';
      if (bluePen) bluePen.classList.add('is-active');
      if (blueEraser) blueEraser.classList.remove('is-active');
    };
  });

  const blueUndo = padEl('blue-undo');
  if (blueUndo) blueUndo.onclick = undoBlue;
  const blueClear = padEl('blue-clear');
  if (blueClear) blueClear.onclick = clearBlue;

  // Global / Single Actions
  const undoBtn = padEl('pad-undo');
  if (undoBtn) undoBtn.onclick = undoPad;

  const clearBtn = padEl('pad-clear');
  if (clearBtn) clearBtn.onclick = clearPad;
  const doneBtn = padEl('pad-done');
  if (doneBtn) doneBtn.onclick = closeDuoPad;

  // In-Pad Score Action Buttons
  const myTeamBtn = padEl('pad-btn-myteam');
  if (myTeamBtn) {
    myTeamBtn.onclick = () => {
      if (typeof onScoreCallback === 'function') {
        onScoreCallback('mine');
      }
    };
  }

  const otherTeamBtn = padEl('pad-btn-otherteam');
  if (otherTeamBtn) {
    otherTeamBtn.onclick = () => {
      if (typeof onScoreCallback === 'function') {
        onScoreCallback('other');
      }
    };
  }

  const giveUpBtn = padEl('pad-btn-giveup');
  if (giveUpBtn) {
    giveUpBtn.onclick = () => {
      if (typeof onScoreCallback === 'function') {
        onScoreCallback('nobody');
      }
    };
  }

  if (padCanvas) {
    padCanvas.addEventListener('pointerdown', (e) => {
      if (!padCtx) {
        return;
      }
      e.preventDefault();
      const p = padPos(e);
      const rect = padCanvas.getBoundingClientRect();
      const team = padColorMode === 'split' ? resolveSoloTeam(p.y, rect.height) : padColorMode;
      const settings = resolveStrokeSettings(team, p.y, rect.height);
      const strokeId = 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

      const aNorm = rect.width > 0 && rect.height > 0 ? { x: p.x / rect.width, y: p.y / rect.height } : { x: 0, y: 0 };
      const bNorm = rect.width > 0 && rect.height > 0 ? { x: (p.x + 0.01) / rect.width, y: (p.y + 0.01) / rect.height } : { x: 0, y: 0 };

      const currentStroke = {
        id: strokeId,
        team: settings.team,
        tool: settings.tool,
        color: settings.color,
        width: settings.width,
        segments: [{ aNorm, bNorm }],
      };

      padPointers.set(e.pointerId, {
        ...p,
        team: settings.team,
        color: settings.color,
        width: settings.width,
        tool: settings.tool,
        strokeId,
        stroke: currentStroke,
      });

      try {
        padCanvas.setPointerCapture(e.pointerId);
      } catch (err) {
        /* capture is a nicety; drawing works without it */
      }
      padStroke(p, p, settings.color, settings.width, settings.tool, strokeId);
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
      flushStrokeBatch();
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


