/**
 * tally.js — the scoreboard is kept in hand-struck tally marks.
 *
 * Geometry lives here once and is consumed twice: as SVG paths on screen and
 * as canvas strokes on the shareable card. Both must look identical, so
 * neither gets to own the maths.
 */

const GROUP_W = 38;
const GROUP_H = 36;

/** Deterministic wobble per stroke, so marks don't dance on re-render. */
function jitter(seed) {
  return ((Math.sin(seed * 47.3) * 1000) % 1) * 2.2;
}

/**
 * Break a score into groups of five.
 * @returns {Array<Array<Object>>} groups of stroke descriptors, each stroke
 *   either {kind:'line', x1,y1,x2,y2} or {kind:'curve', x1,y1,cx,cy,x2,y2}.
 *   The fifth stroke in a group is the diagonal across the other four.
 */
export function tallyGroups(score) {
  const groups = [];
  for (let g = 0; g < Math.ceil(score / 5); g++) {
    const count = Math.min(5, score - g * 5);
    const strokes = [];
    for (let j = 0; j < count; j++) {
      const index = g * 5 + j;
      const k = jitter(index);
      if (j < 4) {
        const x = 5 + j * 8.5;
        strokes.push({ kind: 'line', index, x1: x + k * 0.4, y1: 4, x2: x - k * 0.5, y2: 32 });
      } else {
        strokes.push({ kind: 'curve', index, x1: 1, y1: 30, cx: 17, cy: 18 + k, x2: 34, y2: 6 });
      }
    }
    groups.push(strokes);
  }
  return groups;
}

/**
 * Scoreboard markup. Strokes at or past `animateFrom` draw themselves in.
 */
export function tallySVG(score, color, animateFrom = score) {
  if (score <= 0) return '<span class="zero">no marks yet</span>';
  return tallyGroups(score)
    .map((strokes) => {
      const paths = strokes
        .map((s) => {
          const isNew = s.index >= animateFrom;
          const cls = isNew ? ' class="new"' : '';
          const delay = isNew ? ` style="animation-delay:${(s.index - animateFrom) * 70}ms"` : '';
          const d =
            s.kind === 'line'
              ? `M${s.x1.toFixed(1)} ${s.y1} L${s.x2.toFixed(1)} ${s.y2}`
              : `M${s.x1} ${s.y1} Q${s.cx} ${s.cy.toFixed(1)} ${s.x2} ${s.y2}`;
          return `<path${cls}${delay} d="${d}"/>`;
        })
        .join('');
      return (
        `<svg width="${GROUP_W}" height="${GROUP_H}" viewBox="0 0 ${GROUP_W} ${GROUP_H}" ` +
        `stroke="${color}" aria-hidden="true">${paths}</svg>`
      );
    })
    .join('');
}

/** Same marks, painted onto a canvas at an arbitrary scale. */
export function tallyCanvas(ctx, score, color, x, y, scale = 1, gap = 8) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3.2 * scale;
  ctx.lineCap = 'round';
  tallyGroups(score).forEach((strokes, g) => {
    const ox = x + g * (GROUP_W + gap) * scale;
    strokes.forEach((s) => {
      ctx.beginPath();
      ctx.moveTo(ox + s.x1 * scale, y + s.y1 * scale);
      if (s.kind === 'line') ctx.lineTo(ox + s.x2 * scale, y + s.y2 * scale);
      else ctx.quadraticCurveTo(ox + s.cx * scale, y + s.cy * scale, ox + s.x2 * scale, y + s.y2 * scale);
      ctx.stroke();
    });
  });
  ctx.restore();
}

/** Width in px a score's marks will occupy at a given scale. */
export function tallyWidth(score, scale = 1, gap = 8) {
  const groups = Math.ceil(score / 5);
  return groups <= 0 ? 0 : (groups * GROUP_W + (groups - 1) * gap) * scale;
}
