/**
 * share.js — turns the final scoreboard into a PNG worth posting.
 *
 * Drawn by hand on a canvas rather than screenshotting the DOM, which keeps
 * the repo dependency-free and gives a composition that suits a phone screen
 * instead of a cropped web page.
 */

import { tallyCanvas, tallyWidth } from './tally.js';

const W = 1080;
const H = 1350;
const PAD = 84;

const INK = '#12142A';
const PAPER = '#F7F4EC';
const MUTED = 'rgba(247,244,236,0.45)';
const HAIR = 'rgba(247,244,236,0.13)';

const display = (size, weight = 800) =>
  `${weight} ${size}px "Bricolage Grotesque", system-ui, sans-serif`;
const body = (size, weight = 500) => `${weight} ${size}px "Space Grotesk", system-ui, sans-serif`;

/** Letter-spaced small caps, which canvas has no native support for. */
function tracked(ctx, text, x, y, spacing) {
  let cursor = x;
  for (const ch of text) {
    ctx.fillText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + spacing;
  }
  return cursor - spacing - x;
}

function hairline(ctx, y) {
  ctx.strokeStyle = HAIR;
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 9]);
  ctx.beginPath();
  ctx.moveTo(PAD, y);
  ctx.lineTo(W - PAD, y);
  ctx.stroke();
  ctx.setLineDash([]);
}

function truncate(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s + '…';
}

/**
 * @param {Object} game
 * @param {Array<{name:string,score:number,color:string}>} game.teams
 * @param {number} game.rounds rounds actually played
 * @param {number} game.wordsUsed
 * @param {string} game.reason why the game ended
 * @param {Array<{w:string,win:number|null,p:number}>} game.history
 * @returns {HTMLCanvasElement}
 */
export function renderShareCard(game) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  /* ground */
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 44) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, H);
    ctx.stroke();
  }
  for (let y = 0; y <= H; y += 44) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(W, y + 0.5);
    ctx.stroke();
  }

  const [a, b] = game.teams;
  const tie = a.score === b.score;
  const champ = a.score >= b.score ? a : b;
  const loser = champ === a ? b : a;

  /* masthead */
  ctx.fillStyle = MUTED;
  ctx.font = body(24, 700);
  tracked(ctx, 'MARKER & MAYHEM', PAD, 108, 5.5);

  /* headline */
  ctx.fillStyle = tie ? PAPER : champ.color;
  ctx.font = display(104);
  ctx.fillText(truncate(ctx, tie ? 'Dead heat' : champ.name, W - PAD * 2), PAD, 232);

  ctx.fillStyle = 'rgba(247,244,236,0.62)';
  ctx.font = body(30);
  const sub = tie
    ? `Level at ${a.score} each`
    : `takes it, ${champ.score} to ${loser.score}`;
  ctx.fillText(sub, PAD, 286);

  if (game.reason) {
    ctx.fillStyle = MUTED;
    ctx.font = body(24);
    ctx.fillText(game.reason, PAD, 328);
  }

  hairline(ctx, 380);

  /* team blocks */
  const blockTop = [430, 620];
  game.teams.forEach((t, i) => {
    const y = blockTop[i];

    ctx.fillStyle = PAPER;
    ctx.font = display(46);
    ctx.fillText(truncate(ctx, t.name, W - PAD * 2 - 220), PAD, y);

    ctx.fillStyle = t.color;
    ctx.font = display(94);
    const num = String(t.score);
    ctx.fillText(num, W - PAD - ctx.measureText(num).width, y + 22);

    if (t.score > 0) {
      const scale = Math.min(1.7, (W - PAD * 2 - 260) / Math.max(1, tallyWidth(t.score, 1, 8)));
      tallyCanvas(ctx, t.score, t.color, PAD, y + 30, scale, 8);
    } else {
      ctx.fillStyle = 'rgba(247,244,236,0.25)';
      ctx.font = body(24);
      ctx.fillText('no marks', PAD, y + 62);
    }

    if (i === 0) hairline(ctx, 552);
  });

  hairline(ctx, 790);

  /* stats strip */
  const stats = [
    ['ROUNDS', String(game.rounds)],
    ['WORDS USED', String(game.wordsUsed)],
    ['DATE', new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })],
  ];
  stats.forEach(([label, value], i) => {
    const x = PAD + i * ((W - PAD * 2) / 3);
    ctx.fillStyle = MUTED;
    ctx.font = body(19, 700);
    tracked(ctx, label, x, 842, 3.5);
    ctx.fillStyle = PAPER;
    ctx.font = display(42);
    ctx.fillText(value, x, 894);
  });

  /* recap */
  const recap = (game.history || []).slice(-6).reverse();
  if (recap.length) {
    hairline(ctx, 946);
    ctx.fillStyle = MUTED;
    ctx.font = body(19, 700);
    tracked(ctx, 'LAST WORDS', PAD, 992, 3.5);

    recap.forEach((h, i) => {
      const y = 1044 + i * 46;
      ctx.fillStyle = PAPER;
      ctx.font = body(27);
      ctx.fillText(truncate(ctx, h.w, W - PAD * 2 - 260), PAD, y);

      const tag = h.win === null ? 'nobody' : game.teams[h.win].name;
      const pts = h.win === null ? '—' : `+${h.p}`;
      ctx.font = display(27);
      ctx.fillStyle = h.win === null ? 'rgba(247,244,236,0.3)' : game.teams[h.win].color;
      ctx.fillText(pts, W - PAD - ctx.measureText(pts).width, y);
      ctx.font = body(23);
      const tagW = ctx.measureText(tag).width;
      ctx.fillText(tag, W - PAD - 70 - tagW, y);
    });
  }

  ctx.fillStyle = 'rgba(247,244,236,0.28)';
  ctx.font = body(21);
  ctx.fillText('Marker & Mayhem — one word, both teams, 90 seconds', PAD, H - 58);

  return canvas;
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/**
 * Try the nicest available export. Falls through gracefully: native share
 * sheet, then a file download, then nothing (the caller always shows the
 * image inline, so long-press-to-save still works).
 * @returns {Promise<'shared'|'downloaded'|'preview'>}
 */
export async function exportCard(canvas, filename = 'marker-and-mayhem.png') {
  const blob = await canvasToBlob(canvas);
  if (!blob) return 'preview';

  const file = new File([blob], filename, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Marker & Mayhem — final tally' });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'shared';
    }
  }

  try {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return 'downloaded';
  } catch (e) {
    return 'preview';
  }
}

/** Web fonts must be resolved or canvas silently falls back to a system face. */
export async function fontsReady() {
  if (document.fonts && document.fonts.ready) {
    try {
      await document.fonts.ready;
    } catch (e) {
      /* no-op */
    }
  }
}
