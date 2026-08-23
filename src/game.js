/**
 * game.js - state machine and UI wiring.
 *
 * Three modes share one screen graph:
 *
 *   solo   one phone, both drawers huddle. The picking team chooses a theme
 *          and a card; prompts come from a mutable used-set.
 *   host   one phone per team. Rounds derive themselves from a seed so every
 *          device agrees without talking. This phone keeps the tally.
 *   guest  a joined device. Shows the same word and its own clock, nothing else.
 *
 * Screens advance one way: setup -> handoff -> [theme -> pick] -> draw ->
 * result -> handoff, with an exit to the win screen from any of them.
 * All mutable state lives in `S`, which is what makes saving a one-liner.
 */

import { ALL_THEMES, THEMES, mashupWord, poolSize, TIER_LADDER } from './words.js';
import { pick, shuffle } from './rng.js';
import { createStore, ADAPTERS } from './storage.js';
import { webAdapter, sessionAdapter } from './storage-web.js';
import { blip, tock, buzz, settings, wireButtonHaptics, hapticsSupported } from './feedback.js';
import { tallySVG } from './tally.js';
import { renderShareCard, exportCard, fontsReady } from './share.js';
import { roundFor, syncCode, resetReplay } from './sync.js';
import {
  newSeed,
  encodeJoinCode,
  decodeJoinCode,
  formatJoinCode,
  joinUrl,
  codeFromHash,
} from './joincode.js';
import { encodeQR, qrToSVG } from './qr.js';
import { startScanner, scanAvailable } from './scan.js';
import { wireDuoPad, openDuoPad, closeDuoPad } from './duo.js';

/* ============================================================== constants */

const SAVE_KEY = 'games';
const LAST_JOIN_KEY = 'lastJoin';
const MAX_SAVES = 8;

const TIER_LABEL = { 1: 'warm-up', 2: 'fair fight', 3: 'tricky', 4: 'good luck' };

/** At N seconds left, tick every `gap` ms at `vol`. */
const TICK_PHASES = [
  { from: 20, gap: 1000, vol: 0.045 },
  { from: 10, gap: 500, vol: 0.06 },
  { from: 5, gap: 250, vol: 0.085 },
];

const TEAM_COLORS = ['var(--red)', 'var(--blue)'];
const TEAM_HEX = ['#FF4262', '#3D9BFF'];

const ANY_THEME = { id: 'any', name: 'Anything goes', icon: '🎯', any: true };

const store = createStore([ADAPTERS.host, webAdapter, sessionAdapter, ADAPTERS.memory]);

/* ================================================================== state */

const S = {
  /** @type {'solo'|'host'|'guest'} */
  mode: 'solo',
  id: null,
  seed: null,
  code: null,

  teams: [
    { name: 'Red', score: 0, drawn: 0, color: TEAM_COLORS[0] },
    { name: 'Blue', score: 0, drawn: 0, color: TEAM_COLORS[1] },
  ],
  picker: 0,
  round: 1,

  len: 90,
  diff: 'medium',
  rounds: 10,
  target: 15,

  used: new Set(),
  history: [],
  endReason: '',

  themeOpts: [],
  theme: null,
  cards: [],
  card: null,

  endsAt: 0,
  ticker: null,
  pausedMs: null,
  pinned: false,
  adjusting: false,
  scanner: null,
};

const isGuest = () => S.mode === 'guest';
const isSynced = () => S.mode !== 'solo';

/* ================================================================ helpers */

const $ = (id) => document.getElementById(id);

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('is-active'));
  $(id).classList.add('is-active');
  window.scrollTo(0, 0);
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
}

/**
 * Modal confirmation. Resolves true only on an explicit yes.
 * Restores focus to whatever opened it, so keyboard users aren't dropped.
 */
function confirmSheet({ title, body, yes, no }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    $('m-title').textContent = title;
    $('m-body').textContent = body;
    $('m-yes').textContent = yes;
    $('m-no').textContent = no;

    const modal = $('modal');
    modal.classList.add('on');

    const onKey = (e) => e.key === 'Escape' && close(false);
    function close(value) {
      modal.classList.remove('on');
      $('m-yes').onclick = null;
      $('m-no').onclick = null;
      modal.onclick = null;
      document.removeEventListener('keydown', onKey);
      if (opener && opener.focus) opener.focus();
      resolve(value);
    }

    $('m-yes').onclick = () => close(true);
    $('m-no').onclick = () => close(false);
    modal.onclick = (e) => e.target === modal && close(false);
    document.addEventListener('keydown', onKey);
    $('m-no').focus();
  });
}

const leader = () => (S.teams[0].score >= S.teams[1].score ? S.teams[0] : S.teams[1]);

/* ============================================================ scoreboard */

function renderBoard(el) {
  el.innerHTML = S.teams
    .map(
      (t, i) => `
      <div class="teamrow">
        <div class="tmeta">
          <div class="tname">${esc(t.name)}</div>
          <div class="tally">${tallySVG(t.score, TEAM_HEX[i], t.drawn)}</div>
        </div>
        <div class="adjust${S.adjusting ? ' on' : ''}" data-team="${i}">
          <button data-step="-1" aria-label="Subtract a point from ${esc(t.name)}">−</button>
          <button data-step="1" aria-label="Add a point to ${esc(t.name)}">+</button>
        </div>
        <div class="tnum" style="color:${t.color}">${t.score}</div>
      </div>`
    )
    .join('');

  S.teams.forEach((t) => (t.drawn = t.score));

  el.querySelectorAll('.adjust button').forEach((b) => {
    b.onclick = () => {
      const i = Number(b.parentElement.dataset.team);
      S.teams[i].score = Math.max(0, S.teams[i].score + Number(b.dataset.step));
      S.teams[i].drawn = S.teams[i].score;
      renderBoard(el);
      persist();
    };
  });
}

/* =========================================================== saved games */

function snapshot() {
  return {
    id: S.id,
    mode: S.mode,
    seed: S.seed,
    code: S.code,
    teams: S.teams.map((t) => ({ name: t.name, score: t.score })),
    picker: S.picker,
    round: S.round,
    len: S.len,
    diff: S.diff,
    rounds: S.rounds,
    target: S.target,
    used: [...S.used],
    history: S.history,
    at: Date.now(),
  };
}

async function persist() {
  if (!S.id || isGuest()) return;
  const games = (await store.get(SAVE_KEY)) || [];
  const i = games.findIndex((g) => g.id === S.id);
  if (i >= 0) games[i] = snapshot();
  else games.unshift(snapshot());
  games.sort((a, b) => b.at - a.at);
  await store.set(SAVE_KEY, games.slice(0, MAX_SAVES));
}

async function clearCurrentSave() {
  if (!S.id) return;
  const games = ((await store.get(SAVE_KEY)) || []).filter((g) => g.id !== S.id);
  await store.set(SAVE_KEY, games);
}

async function renderSaves() {
  const games = (await store.get(SAVE_KEY)) || [];
  const field = $('saves-field');
  if (!games.length) {
    field.hidden = true;
    $('saves').innerHTML = '';
    return;
  }
  field.hidden = false;

  const rows = games
    .map((g) => {
      const d = new Date(g.at);
      const when =
        d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) +
        ' ' +
        d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      const label = `${esc(g.teams[0].name)} vs ${esc(g.teams[1].name)}`;
      const kind = g.mode === 'host' ? ' &middot; multi-device' : '';
      return `
        <div class="save">
          <div class="meta">
            <div class="stitle">${label}</div>
            <div class="smeta">Round ${g.round}${g.rounds ? ' of ' + g.rounds : ''}
              &middot; ${g.teams[0].score}-${g.teams[1].score}${kind}
              &middot; ${when}</div>
          </div>
          <button class="resume" data-id="${g.id}">Resume</button>
          <button class="del" data-id="${g.id}" data-label="${label}" aria-label="Delete ${label}">✕</button>
        </div>`;
    })
    .join('');

  $('saves').innerHTML =
    rows +
    `<div style="text-align:center;margin-top:8px">
      <button class="linkbtn" id="clear-all-saves">Clear all saved games</button>
    </div>`;

  $('saves')
    .querySelectorAll('.resume')
    .forEach((b) => (b.onclick = () => resumeGame(b.dataset.id)));

  $('saves')
    .querySelectorAll('.del')
    .forEach(
      (b) =>
        (b.onclick = async () => {
          const ok = await confirmSheet({
            title: 'Delete this game?',
            body: `"${b.dataset.label}" goes for good: scores, round history and its used-word list. This cannot be undone.`,
            yes: 'Delete it',
            no: 'Keep it',
          });
          if (!ok) return;
          const rest = ((await store.get(SAVE_KEY)) || []).filter((g) => g.id !== b.dataset.id);
          await store.set(SAVE_KEY, rest);
          renderSaves();
          toast('Game deleted');
        })
    );

  const clearAllBtn = $('clear-all-saves');
  if (clearAllBtn) {
    clearAllBtn.onclick = async () => {
      const ok = await confirmSheet({
        title: 'Clear all saved games?',
        body: 'All saved games in browser storage will be deleted permanently. This cannot be undone.',
        yes: 'Clear all',
        no: 'Keep them',
      });
      if (!ok) return;
      await store.set(SAVE_KEY, []);
      renderSaves();
      toast('All saved games cleared');
    };
  }
}

async function resumeGame(id) {
  const g = ((await store.get(SAVE_KEY)) || []).find((x) => x.id === id);
  if (!g) return toast('That game is gone');

  Object.assign(S, {
    id: g.id,
    mode: g.mode || 'solo',
    seed: g.seed ?? null,
    code: g.code ?? null,
    picker: g.picker,
    round: g.round,
    len: g.len,
    diff: g.diff,
    target: g.target,
    rounds: g.rounds ?? 0,
    used: new Set(g.used || []),
    history: g.history || [],
    endReason: '',
  });
  g.teams.forEach((t, i) => Object.assign(S.teams[i], { name: t.name, score: t.score, drawn: t.score }));

  applyMode();
  toHandoff();
  toast(`Picked up at round ${g.round}`);
}

/* ================================================================== setup */

function segment(id, key, cast, onChange) {
  const wrap = $(id);
  wrap.querySelectorAll('button').forEach((b) => {
    b.setAttribute('aria-pressed', String(cast(b.dataset.v) === S[key]));
    b.onclick = () => {
      const value = cast(b.dataset.v);
      if (onChange) onChange(value);
      else S[key] = value;
      wrap.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    };
  });
}

function applyFeedbackMode(mode) {
  settings.sound = mode === 'both' || mode === 'sound';
  settings.haptics = mode === 'both' || mode === 'buzz';
  syncFeedbackLabels();
}

function syncFeedbackLabels() {
  $('sound-toggle').textContent = `Sound: ${settings.sound ? 'on' : 'off'}`;
  $('buzz-toggle').textContent = `Buzz: ${settings.haptics ? 'on' : 'off'}`;
}

/** Body classes drive the handful of layout differences between modes. */
function applyMode() {
  document.body.classList.toggle('mode-guest', isGuest());
  document.body.classList.toggle('mode-synced', isSynced());
}

function initSetup() {
  segment('seg-len', 'len', Number);
  segment('seg-diff', 'diff', String);
  segment('seg-rounds', 'rounds', Number);
  segment('seg-target', 'target', Number);
  segment('seg-devices', 'mode', String);
  segment('seg-feedback', null, String, applyFeedbackMode);

  $('seg-feedback')
    .querySelectorAll('button')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === 'both')));

  if (!hapticsSupported) $('buzz-toggle').hidden = true;

  $('go').onclick = startNewGame;

  document.querySelectorAll('.info').forEach((b) => {
    b.onclick = () => {
      const hint = b.closest('.lbl').nextElementSibling;
      if (!hint || !hint.classList.contains('hint')) return;
      b.setAttribute('aria-expanded', String(hint.classList.toggle('on')));
    };
  });
}

function startNewGame() {
  S.teams[0].name = $('n0').value.trim() || 'Red';
  S.teams[1].name = $('n1').value.trim() || 'Blue';
  S.teams.forEach((t) => Object.assign(t, { score: 0, drawn: 0 }));

  Object.assign(S, {
    id: 'g' + Date.now(),
    picker: 0,
    round: 1,
    used: new Set(),
    history: [],
    endReason: '',
    seed: null,
    code: null,
  });

  applyMode();
  blip(660, 0.09);

  if (S.mode === 'host') {
    S.seed = newSeed();
    resetReplay(S.seed, S.diff);
    S.code = encodeJoinCode({
      seed: S.seed,
      diff: S.diff,
      len: S.len,
      rounds: S.rounds,
      target: S.target,
    });
    persist();
    return showInvite();
  }

  persist();
  toHandoff();
}

/* ================================================================ invite */

function showInvite() {
  $('invite-code').textContent = formatJoinCode(S.code);

  const url = joinUrl(S.code);
  const shareable = /^https?:$/.test(window.location.protocol);
  const holder = $('invite-qr');

  if (shareable) {
    try {
      holder.innerHTML = qrToSVG(encodeQR(url, { level: 'M' }), { scale: 6, quiet: 3 });
      $('invite-url').textContent = url;
      $('invite-qr-note').textContent = 'Point any camera at this - it opens the game already joined.';
    } catch (err) {
      holder.innerHTML = '';
      $('invite-url').textContent = '';
      $('invite-qr-note').textContent = 'Could not build a QR for this address. Use the code below.';
    }
  } else {
    holder.innerHTML = '';
    $('invite-url').textContent = '';
    $('invite-qr-note').textContent =
      'Opened from a file rather than a web address, so there is no link to share. Type the code below on the other phones.';
  }

  show('s-invite');
}

/* ============================================================= turn loop */

function toHandoff() {
  const t = S.teams[S.picker];
  $('roundlabel').textContent = `Round ${S.round}${S.rounds ? ` of ${S.rounds}` : ''}`;
  $('turn-team').textContent = t.name;
  $('turn-swatch').style.background = t.color;
  $('theme-who').textContent = `${t.name} picks the theme`;

  if (isSynced()) {
    $('handoff-head').textContent = 'Everyone ready?';
    $('handoff-sub').textContent =
      'Each drawer holds their own phone. Check the sync code matches before you deal.';
    $('reveal').textContent = 'Deal round ' + S.round;
    $('sync-badge').hidden = false;
    $('sync-code').textContent = syncCode(S.seed, S.round);
  } else {
    $('handoff-head').textContent = 'Both drawers, huddle up';
    $('handoff-sub').textContent =
      'One drawer from each team looks at the screen together. Everyone else: eyes off.';
    $('reveal').textContent = "We're the drawers - deal us in";
    $('sync-badge').hidden = true;
  }

  renderBoard($('board'));
  show('s-handoff');
}

function unusedCount(theme) {
  let n = 0;
  Object.values(theme.words).forEach((list) => list.forEach((w) => !S.used.has(w) && n++));
  return n;
}

function dealThemes() {
  S.themeOpts = [...shuffle(ALL_THEMES).slice(0, 4), ANY_THEME];
  $('themes').innerHTML = S.themeOpts
    .map((t, i) => {
      const note = t.any
        ? 'Anything from the whole bank'
        : t.gen
        ? 'Absurd combinations, freshly built'
        : `${unusedCount(t)} words left in this game`;
      return `
        <button class="theme${t.any ? ' any' : ''}" data-i="${i}">
          <span class="ic">${t.icon}</span>
          <span><span class="tt">${t.name}</span><span class="td">${note}</span></span>
        </button>`;
    })
    .join('');

  $('themes')
    .querySelectorAll('.theme')
    .forEach(
      (b) =>
        (b.onclick = () => {
          S.theme = S.themeOpts[Number(b.dataset.i)];
          blip(520, 0.06);
          dealCards();
          show('s-pick');
        })
    );
}

function tiersForRound() {
  if (S.diff !== 'mixed') return TIER_LADDER[S.diff];
  const bump = () => (Math.random() < 0.5 ? 0 : 1);
  return [1 + bump(), 2 + bump(), 3 + bump()];
}

function generatedWord(tier) {
  for (let i = 0; i < 80; i++) {
    const w = mashupWord(tier);
    if (!S.used.has(w)) {
      S.used.add(w);
      return w;
    }
  }
  const w = mashupWord(4);
  S.used.add(w);
  return w;
}

/**
 * Solo-mode draw. Cascades outward when a pool runs dry: requested tier, other
 * tiers in the theme, any other theme, then generated mashups, which never run
 * out - so "no repeats" always holds.
 */
function drawWord(theme, tier) {
  const source = theme.any ? pick(ALL_THEMES) : theme;
  if (source.gen) return generatedWord(tier);

  const order = [Math.min(tier, 3), 3, 2, 1];
  const take = (t) => {
    for (const k of order) {
      const pool = (t.words[k] || []).filter((w) => !S.used.has(w));
      if (pool.length) {
        const w = pick(pool);
        S.used.add(w);
        return w;
      }
    }
    return null;
  };

  return take(source) || shuffle(THEMES).map(take).find(Boolean) || generatedWord(tier);
}

function dealCards() {
  $('pick-who').textContent = `${S.theme.name} - both teams draw it`;
  S.cards = tiersForRound().map((tier, i) => ({ tier, pts: i + 1, word: drawWord(S.theme, tier) }));

  $('cards').innerHTML = S.cards
    .map(
      (c, i) => `
      <button class="card" data-i="${i}">
        <span class="pts">${c.pts}<small>PT${c.pts > 1 ? 'S' : ''}</small></span>
        <span>
          <span class="word">${esc(c.word)}</span>
          <span class="tier">${TIER_LABEL[Math.min(c.tier, 4)]}</span>
        </span>
      </button>`
    )
    .join('');

  $('cards')
    .querySelectorAll('.card')
    .forEach((b) => (b.onclick = () => startRound(S.cards[Number(b.dataset.i)])));
}

/** Synced mode skips the picking entirely - the round deals itself. */
function dealSyncedRound() {
  const r = roundFor(S.seed, S.diff, S.round);
  S.theme = r.theme;
  startRound({ tier: r.tier, pts: r.pts, word: r.word });
}

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

  el.textContent = formatClock(left);
  el.className = 'clock' + (left <= 5 ? ' hot shake' : left <= 10 ? ' hot' : left <= 20 ? ' warn' : '');
  $('stroke').style.transform = `scaleX(${ms / (S.len * 1000)})`;
  $('stroke').style.background = left <= 10 ? '#FF4262' : left <= 20 ? '#FFD23F' : '#F7F4EC';

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

    const phase = TICK_PHASES.filter((p) => left <= p.from).pop();
    if (phase && left > 0 && Date.now() >= nextTock) {
      nextTock = Date.now() + phase.gap;
      tock(high ? 2300 : 1700, phase.vol);
      high = !high;
      if (left <= 5) buzz(12);
    }

    if (left <= 0) {
      stopClock();
      buzz([90, 60, 90]);
      blip(200, 0.5, 0.07);
      if (isGuest()) endGuestRound();
      else finishRound(null);
    }
  }, 50);
}

function stopClock() {
  clearInterval(S.ticker);
  S.ticker = null;
  S.pausedMs = null;
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
  $('draw-theme').textContent = S.theme.any ? '🎯 Anything goes' : `${S.theme.icon} ${S.theme.name}`;
  $('draw-worth').textContent = `Worth ${card.pts}`;
  $('got0').textContent = `${S.teams[0].name} got it`;
  $('got1').textContent = `${S.teams[1].name} got it`;

  S.pinned = isGuest();
  applyPeek();

  S.endsAt = Date.now() + S.len * 1000;
  S.pausedMs = null;
  show('s-draw');
  runClock();
}

/**
 * The word control. Solo phones sit on the table, so hold-to-peek is right.
 * A guest phone is in the drawer's hand, so it defaults to pinned.
 */
function applyPeek() {
  const el = $('peek');
  if (S.pinned && S.card) {
    el.classList.add('showing');
    el.textContent = S.card.word;
  } else {
    el.classList.remove('showing');
    el.textContent = 'Hold to see the word';
  }
  $('pin-toggle').textContent = S.pinned ? 'Hide the word' : 'Keep it on screen';
  $('pin-toggle').setAttribute('aria-pressed', String(S.pinned));
}

/* ================================================================ results */

function finishRound(winner) {
  const pts = S.card.pts;

  if (winner === null) {
    $('res-eyebrow').textContent = `Round ${S.round}`;
    $('verdict').textContent = 'Nobody got it';
    $('verdict').style.color = 'rgba(247,244,236,.35)';
  } else {
    S.teams[winner].score += pts;
    $('res-eyebrow').textContent = `${S.teams[winner].name} got there first`;
    $('verdict').textContent = `+${pts}`;
    $('verdict').style.color = S.teams[winner].color;
  }

  S.history.push({ r: S.round, w: S.card.word, t: S.theme.name, win: winner, p: pts });
  $('res-word').textContent = S.card.word;
  renderBoard($('board2'));
  persist();

  if (winner !== null && S.target && S.teams[winner].score >= S.target) {
    return endGame(S.teams[winner], `First to ${S.target}.`);
  }

  const isLast = S.rounds && S.round >= S.rounds;
  $('next').textContent = isLast ? 'See the final tally' : 'Next round';
  show('s-result');
}

function nextRound() {
  if (!$('s-result').classList.contains('is-active')) {
    return;
  }
  if (S.rounds && S.round >= S.rounds) {
    return endGame(leader(), `All ${S.rounds} rounds played.`);
  }
  S.picker = 1 - S.picker;
  S.round++;
  persist();
  toHandoff();
}

function endGame(champ, reason) {
  S.endReason = reason || '';
  clearCurrentSave().catch(() => {});
  const other = S.teams[1 - S.teams.indexOf(champ)];
  const tie = champ.score === other.score;

  $('win-name').textContent = tie ? 'Dead heat' : champ.name;
  $('win-name').style.color = tie ? 'var(--paper)' : champ.color;
  $('win-line').textContent =
    (tie ? `Level at ${champ.score} each.` : `${champ.name} takes it, ${champ.score} to ${other.score}.`) +
    (S.endReason ? ` ${S.endReason}` : '');

  renderBoard($('board3'));
  renderLog();
  show('s-win');
  [0, 120, 240].forEach((d, i) => setTimeout(() => blip(660 + i * 220, 0.14, 0.06), d));
}

function renderLog() {
  $('log').innerHTML = S.history
    .slice()
    .reverse()
    .slice(0, 40)
    .map((h) => {
      const who =
        h.win === null
          ? '<span class="dim">nobody</span>'
          : `<span style="color:${S.teams[h.win].color}">${esc(S.teams[h.win].name)}</span>`;
      return `
        <div class="logrow">
          <span class="lw">${esc(h.w)} <span class="dim">· ${esc(h.t)}</span></span>
          <span style="font-size:12px">${who}</span>
          <span class="lp">${h.win === null ? '-' : '+' + h.p}</span>
        </div>`;
    })
    .join('');
}

/* ================================================================ wrap up */

async function wrapUp() {
  if (isGuest()) return leaveGame();

  const live = !!S.ticker;
  if (live) pauseClock();

  const [a, b] = S.teams;
  const standing =
    a.score === b.score
      ? `Level at ${a.score} each: a tie is a legitimate result.`
      : `${leader().name} leads ${Math.max(a.score, b.score)}-${Math.min(a.score, b.score)}.`;

  const ok = await confirmSheet({
    title: 'Wrap up the game?',
    body:
      standing +
      (live ? ' This round is still running; its word scores nothing.' : '') +
      ' Scores stand as they are and we go to the final tally.',
    yes: 'Wrap it up',
    no: 'Keep playing',
  });

  if (ok) {
    stopClock();
    clearCurrentSave().catch(() => {});
    endGame(leader(), 'Wrapped up early.');
  } else if (live) {
    resumeClock();
  }
}

/* ============================================================= guest mode */

function toGuestReady() {
  const overCap = Boolean(S.rounds && S.round > S.rounds);
  const head = $('guest-head');
  const sub = $('guest-sub');
  const startBtn = $('guest-start');

  if (overCap) {
    $('guest-round').textContent = `Round ${S.rounds} of ${S.rounds}`;
    $('guest-sync').textContent = 'DONE';
    if (head) head.textContent = 'Game complete';
    if (sub) sub.textContent = 'All rounds have been played. Check the host phone for the final tally and podium.';
    $('guest-theme').textContent = '🏁 All done';
    $('guest-worth').textContent = 'Game over';
    startBtn.textContent = 'Leave game';
    startBtn.onclick = leaveGame;
    show('s-guest');
    return;
  }

  if (head) head.textContent = "You're a drawer";
  if (sub) sub.textContent = 'Check the sync code matches the host\'s. If it doesn\'t, step this phone\'s round to line up.';
  startBtn.textContent = 'Show the word and start';
  startBtn.onclick = startGuestRound;

  const r = roundFor(S.seed, S.diff, S.round);
  S.theme = r.theme;
  $('guest-round').textContent = `Round ${S.round}${S.rounds ? ` of ${S.rounds}` : ''}`;
  $('guest-sync').textContent = syncCode(S.seed, S.round);
  $('guest-theme').textContent = `${r.theme.icon} ${r.theme.name}`;
  $('guest-worth').textContent = `Worth ${r.pts}`;

  const teamNameEl = $('guest-team-name');
  if (teamNameEl) teamNameEl.textContent = S.teams[1].name;
  const teamDotEl = $('guest-team-dot');
  if (teamDotEl) teamDotEl.style.background = S.teams[1].color;

  show('s-guest');
}

function startGuestRound() {
  const r = roundFor(S.seed, S.diff, S.round);
  S.theme = r.theme;
  startRound({ tier: r.tier, pts: r.pts, word: r.word });
}

function endGuestRound() {
  stopClock();
  S.round++;
  saveLastJoin();
  toGuestReady();
}

async function leaveGame() {
  const ok = await confirmSheet({
    title: 'Leave the game?',
    body: 'This phone stops following along. The code still works if you want to rejoin.',
    yes: 'Leave',
    no: 'Stay in',
  });
  if (!ok) return;
  stopClock();
  S.mode = 'solo';
  S.seed = null;
  S.code = null;
  applyMode();
  await renderSaves();
  show('s-setup');
}

/** Step the round counter when phones drift out of sync. */
function nudgeRound(delta) {
  const next = S.round + delta;
  if (next < 1) return;
  S.round = next;
  saveLastJoin();
  toGuestReady();
}

async function saveLastJoin() {
  if (!isGuest()) return;
  await store.set(LAST_JOIN_KEY, { code: S.code, round: S.round, at: Date.now() });
}

/* ================================================================= joining */

function openJoin(prefill) {
  $('join-code').value = prefill ? formatJoinCode(prefill) : '';
  $('join-error').textContent = '';
  show('s-join');
  scanAvailable().then((ok) => {
    $('join-scan').hidden = !ok;
  });
}

/**
 * Accept either a raw code or a full invite URL, since a guest might paste
 * either one.
 */
function applyJoinInput(raw) {
  const fromUrl = codeFromHash(raw) || (raw.includes('#') ? null : raw);
  const candidate = fromUrl ?? raw;
  return decodeJoinCode(candidate);
}

async function submitJoin(raw) {
  let payload;
  try {
    payload = applyJoinInput(raw);
  } catch (err) {
    $('join-error').textContent = err.message;
    buzz([40, 60, 40]);
    return;
  }
  await enterGuestMode(encodeJoinCode(payload), payload, 1, true);
}

async function enterGuestMode(code, payload, round, playSound = true) {
  stopScanner();
  Object.assign(S, {
    mode: 'guest',
    seed: payload.seed,
    code,
    diff: payload.diff,
    len: payload.len,
    rounds: payload.rounds,
    target: payload.target,
    round: Math.max(1, round || 1),
    history: [],
  });
  resetReplay(S.seed, S.diff);
  applyMode();
  await saveLastJoin();
  if (playSound) blip(760, 0.09);
  toGuestReady();
  toast(`Joined ${formatJoinCode(code)}. Review and edit your team name below if you want to.`);
}

function stopScanner() {
  if (S.scanner) {
    S.scanner.stop();
    S.scanner = null;
  }
  $('scan-wrap').hidden = true;
}

async function beginScan() {
  $('join-error').textContent = '';
  $('scan-wrap').hidden = false;
  try {
    S.scanner = await startScanner($('scan-video'), (value) => {
      stopScanner();
      submitJoin(value);
    });
  } catch (err) {
    stopScanner();
    $('join-error').textContent = err.message;
  }
}

/** A guest arriving from an invite link. */
async function joinFromHash() {
  const code = codeFromHash(window.location.hash);
  if (!code) return false;
  try {
    const payload = decodeJoinCode(code);
    history.replaceState(null, '', window.location.pathname + window.location.search);
    await enterGuestMode(encodeJoinCode(payload), payload, 1, false);
    return true;
  } catch (err) {
    toast(err.message);
    openJoin(code.toUpperCase());
    return true;
  }
}

async function offerRejoin() {
  const last = await store.get(LAST_JOIN_KEY);
  if (!last || !last.code) return;
  try {
    decodeJoinCode(last.code);
  } catch (e) {
    return;
  }
  $('rejoin-field').hidden = false;
  $('rejoin-label').textContent = `${formatJoinCode(last.code)} · round ${last.round}`;
  $('rejoin').onclick = async () => {
    const payload = decodeJoinCode(last.code);
    await enterGuestMode(last.code, payload, last.round);
  };
}

/* ================================================================== share */

async function openShare() {
  const modal = $('share-modal');
  const shot = $('shot');
  shot.innerHTML = '';
  $('sh-hint').textContent = 'Rendering…';
  modal.classList.add('on');

  await fontsReady();
  const canvas = renderShareCard({
    teams: S.teams.map((t, i) => ({ name: t.name, score: t.score, color: TEAM_HEX[i] })),
    rounds: S.history.length,
    wordsUsed: isSynced() ? S.history.length : S.used.size,
    reason: S.endReason,
    history: S.history,
  });

  shot.appendChild(canvas);
  $('sh-hint').textContent = 'Long-press the image to save it, or use the button below.';

  $('sh-share').onclick = async () => {
    const result = await exportCard(canvas, `marker-mayhem-${Date.now()}.png`);
    if (result === 'shared') {
      toast('Shared');
    } else if (result === 'downloaded') {
      toast('Image saved');
    } else if (result !== 'cancelled') {
      toast('Long-press the image to save it');
    }
  };
}

const closeShare = () => $('share-modal').classList.remove('on');

/* ================================================================ wiring */

function wireEvents() {
  $('reveal').onclick = () => {
    if (isSynced()) return dealSyncedRound();
    dealThemes();
    show('s-theme');
  };
  $('back-theme').onclick = () => {
    dealThemes();
    show('s-theme');
  };
  $('reshuffle').onclick = () => {
    blip(440, 0.05);
    dealCards();
  };

  ['panic1', 'panic2'].forEach((id) => ($(id).onclick = () => $('veil').classList.add('on')));
  $('veil').onclick = () => $('veil').classList.remove('on');

  const peek = $('peek');
  peek.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });
  peek.addEventListener('pointerdown', (e) => {
    if (S.pinned) return;
    e.preventDefault();
    peek.classList.add('showing');
    peek.textContent = S.card ? S.card.word : '';
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) =>
    peek.addEventListener(ev, () => {
      if (!S.pinned) applyPeek();
    })
  );
  $('pin-toggle').onclick = () => {
    S.pinned = !S.pinned;
    applyPeek();
  };

  [0, 1].forEach((i) => {
    $(`got${i}`).onclick = () => {
      if (!S.ticker) {
        return; // this round is already decided
      }
      stopClock();
      buzz(40);
      blip(880, 0.1);
      blip(1170, 0.14);
      finishRound(i);
    };
  });
  $('giveup').onclick = () => {
    if (!S.ticker) {
      return;
    }
    stopClock();
    finishRound(null);
  };
  $('guest-done').onclick = endGuestRound;

  $('next').onclick = nextRound;
  ['wrap-handoff', 'wrap-theme', 'wrap-pick', 'wrap-draw', 'wrap-result'].forEach(
    (id) => ($(id).onclick = wrapUp)
  );

  $('share').onclick = openShare;
  $('sh-close').onclick = closeShare;
  $('share-modal').onclick = (e) => e.target === $('share-modal') && closeShare();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('share-modal').classList.contains('on')) {
      closeShare();
    }
  });

  $('duo-toggle').onclick = () => {
    blip(500, 0.06);
    if (S.mode === 'solo') {
      openDuoPad({ colorMode: 'split', title: 'Shared Drawing Pad' });
    } else if (S.mode === 'host') {
      openDuoPad({
        colorMode: 'red',
        title: `${S.teams[0].name} Drawing Pad`,
        opponentTitle: `${S.teams[1].name} (Other Team)`,
        opponentColor: S.teams[1].color,
      });
    } else {
      openDuoPad({
        colorMode: 'blue',
        title: `${S.teams[1].name} Drawing Pad`,
        opponentTitle: `${S.teams[0].name} (Other Team)`,
        opponentColor: S.teams[0].color,
      });
    }
  };

  $('invite-done').onclick = () => toHandoff();
  $('invite-copy').onclick = async () => {
    const text = $('invite-url').textContent || S.code;
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch (e) {
      toast('Copy not available - read it out instead');
    }
  };
  $('show-invite').onclick = showInvite;

  $('open-join').onclick = () => openJoin();
  $('join-back').onclick = () => {
    stopScanner();
    show('s-setup');
  };
  $('join-go').onclick = () => submitJoin($('join-code').value);
  $('join-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitJoin($('join-code').value);
  });
  $('join-scan').onclick = beginScan;
  $('scan-cancel').onclick = stopScanner;

  $('guest-start').onclick = startGuestRound;
  $('guest-leave').onclick = leaveGame;
  $('guest-back').onclick = () => nudgeRound(-1);
  $('guest-fwd').onclick = () => nudgeRound(1);

  const grToggle = $('guest-rename-toggle');
  if (grToggle) {
    grToggle.onclick = () => {
      const ren = $('guest-renamer');
      const isHidden = ren.hidden;
      ren.hidden = !isHidden;
      if (!ren.hidden) {
        $('gr-name').value = S.teams[1].name;
        $('gr-name').focus();
      }
    };
  }

  const grSave = $('gr-save');
  if (grSave) {
    grSave.onclick = () => {
      const val = $('gr-name').value.trim();
      if (val) {
        S.teams[1].name = val;
      }
      const teamNameEl = $('guest-team-name');
      if (teamNameEl) teamNameEl.textContent = S.teams[1].name;
      $('guest-renamer').hidden = true;
      toast(`Team name set to ${S.teams[1].name}`);
    };
  }

  const grCancel = $('gr-cancel');
  if (grCancel) {
    grCancel.onclick = () => {
      $('guest-renamer').hidden = true;
    };
  }

  $('pause').onclick = async () => {
    await persist();
    await renderSaves();
    show('s-setup');
    const durable = store.name === 'host' || store.name === 'localStorage';
    toast(durable ? 'Saved - resume any time' : 'Saved for this session');
  };

  $('again').onclick = () => {
    S.teams.forEach((t) => Object.assign(t, { score: 0, drawn: 0 }));
    Object.assign(S, { picker: 0, round: 1, history: [], endReason: '', id: 'g' + Date.now() });
    if (isSynced()) {
      S.seed = newSeed();
      resetReplay(S.seed, S.diff);
      S.code = encodeJoinCode({
        seed: S.seed,
        diff: S.diff,
        len: S.len,
        rounds: S.rounds,
        target: S.target,
      });
      persist();
      return showInvite();
    }
    persist();
    toHandoff();
    toast('Fresh scores, same used words');
  };

  $('reset').onclick = async () => {
    await renderSaves();
    show('s-setup');
  };

  $('rename-toggle').onclick = () => {
    const on = $('renamer').classList.toggle('on');
    $('rename-toggle').textContent = on ? 'Cancel rename' : 'Rename teams';
    if (on) {
      $('r0').value = S.teams[0].name;
      $('r1').value = S.teams[1].name;
      $('r0').focus();
    }
  };

  $('rename-save').onclick = () => {
    S.teams[0].name = $('r0').value.trim() || S.teams[0].name;
    S.teams[1].name = $('r1').value.trim() || S.teams[1].name;
    $('renamer').classList.remove('on');
    $('rename-toggle').textContent = 'Rename teams';
    persist();
    toHandoff();
    toast('Names updated');
  };

  $('adjust-toggle').onclick = () => {
    S.adjusting = !S.adjusting;
    $('adjust-toggle').textContent = S.adjusting ? 'Done fixing' : 'Fix a score';
    renderBoard($('board'));
  };

  $('sound-toggle').onclick = () => {
    settings.sound = !settings.sound;
    syncFeedbackLabels();
    if (settings.sound) blip(700, 0.07);
  };

  $('buzz-toggle').onclick = () => {
    settings.haptics = !settings.haptics;
    syncFeedbackLabels();
    if (settings.haptics) buzz(20);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopScanner();
      releaseWakeLock();
    } else if ($('s-draw').classList.contains('is-active') && S.ticker) {
      paintClock();
      requestWakeLock();
    }
  });

  window.addEventListener('pagehide', () => {
    stopScanner();
    releaseWakeLock();
  });
}

/** Offline shell. Only meaningful over http(s); a no-op from the filesystem. */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!/^https?:$/.test(window.location.protocol)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* offline support is a bonus, not a requirement */
    });
  });
}

/* =================================================================== boot */

(async function boot() {
  initSetup();
  wireEvents();
  wireButtonHaptics();
  wireDuoPad();
  syncFeedbackLabels();
  applyMode();
  registerServiceWorker();

  const { total } = poolSize();
  $('poolnote').textContent = `${total.toLocaleString()} prompts in the bank · never repeated within a game`;

  if (await joinFromHash()) return;
  await Promise.all([renderSaves(), offerRejoin()]);
})();
