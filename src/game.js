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
import {
  blip,
  tock,
  buzz,
  buzzer,
  victoryFanfare,
  settings,
  loadSettings,
  saveSettings,
  wireButtonHaptics,
  hapticsSupported,
} from './feedback.js';
import { tallySVG } from './tally.js';
import { renderShareCard, renderGalleryCard, exportCard, fontsReady } from './share.js';
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
import {
  wireDuoPad,
  openDuoPad,
  closeDuoPad,
  resetDuoPad,
  getPadSnapshot,
  getCurrentStrokes,
  renderIncomingStroke,
  renderIncomingBatch,
  renderIncomingUndo,
  clearIncomingSideboard,
} from './duo.js';
import { burstConfetti, stopConfetti } from './confetti.js';
import { connectP2P, disconnectP2P, sendP2P } from './p2p.js';

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
const isHost = () => S.mode === 'host';
const isSynced = () => S.mode !== 'solo';

/* ================================================================ helpers */

const $ = (id) => (typeof document !== 'undefined' && document ? document.getElementById(id) : null);

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function isGameActive() {
  if (typeof document === 'undefined' || !document) return false;
  const setupActive = $('s-setup')?.classList.contains('is-active');
  const winActive = $('s-win')?.classList.contains('is-active');
  const joinActive = $('s-join')?.classList.contains('is-active');
  return !setupActive && !winActive && !joinActive;
}

function show(id) {
  if (id !== 's-win' && typeof stopConfetti === 'function') {
    stopConfetti();
  }
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('is-active'));
  $(id).classList.add('is-active');
  window.scrollTo(0, 0);
  if (id !== 's-setup' && id !== 's-join' && id !== 's-win') {
    try {
      history.pushState({ inGame: true }, '');
    } catch (err) {}
  }
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

let persistQueue = Promise.resolve();

function persist() {
  persistQueue = persistQueue
    .then(async () => {
      if (!S.id || isGuest()) return;
      const games = (await store.get(SAVE_KEY)) || [];
      const i = games.findIndex((g) => g.id === S.id);
      if (i >= 0) games[i] = snapshot();
      else games.unshift(snapshot());
      games.sort((a, b) => b.at - a.at);
      await store.set(SAVE_KEY, games.slice(0, MAX_SAVES));
    })
    .catch(() => {});
  return persistQueue;
}

function clearCurrentSave() {
  const targetId = S.id;
  persistQueue = persistQueue
    .then(async () => {
      if (!targetId || isGuest()) return;
      const games = ((await store.get(SAVE_KEY)) || []).filter((g) => g.id !== targetId);
      await store.set(SAVE_KEY, games);
    })
    .catch(() => {});
  return persistQueue;
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

/* ================================================================ invite & p2p */

let hostReadyState = false;
let guestReadyState = false;
let countdownTimer = null;
let guestInLobby = false;

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
    count--;
    if (count > 0) {
      num.textContent = count;
      blip(520, 0.08);
    } else if (count === 0) {
      num.textContent = 'GO!';
      blip(1040, 0.15);
    } else {
      clearInterval(countdownTimer);
      overlay.hidden = true;
      onComplete();
    }
  }, 1000);
}

function startHostSyncedRound() {
  if (!S.card) {
    const r = roundFor(S.seed, S.diff, S.round);
    S.theme = r.theme;
    S.card = { tier: r.tier, pts: r.pts, word: r.word };
  }
  startRound(S.card);
  const endsAt = Date.now() + 3400 + S.len * 1000;
  if (typeof sendP2P === 'function') {
    sendP2P('START_COUNTDOWN', { round: S.round, endsAt, len: S.len, card: S.card, theme: S.theme });
  }
  triggerSynchronizedCountdown(() => {
    S.endsAt = endsAt;
    runClock();
  });
}

function startGuestSyncedRound() {
  startGuestRound();
  triggerSynchronizedCountdown(() => {});
}

function handleP2PMessage(msg) {
  if (!msg || !msg.type || typeof document === 'undefined' || !document) return;

  switch (msg.type) {
    case 'PEER_PING':
    case 'PEER_JOINED':
      if (isHost()) {
        guestInLobby = true;
        const teamName = msg.name || S.teams[1].name || 'Team 2';
        const lgName = $('lobby-guest-name');
        if (lgName) lgName.textContent = teamName;
        const lgStatus = $('lobby-guest-status');
        if (lgStatus) {
          lgStatus.textContent = '✓ Joined';
          lgStatus.className = 'lobby-status ready';
        }
        sendP2P('HOST_ACK', { name: S.teams[0].name });
        sendP2P('ROOM_STATE', {
          round: S.round,
          picker: S.picker,
          theme: S.theme,
          card: S.card,
          hostReady: hostReadyState,
          team0Name: S.teams[0].name,
          team1Name: S.teams[1].name,
          team0Score: S.teams[0].score,
          team1Score: S.teams[1].score,
        });
      }
      break;

    case 'SYNC_REQUEST':
      if (isHost()) {
        sendP2P('ROOM_STATE', {
          round: S.round,
          picker: S.picker,
          theme: S.theme,
          card: S.card,
          hostReady: hostReadyState,
          team0Name: S.teams[0].name,
          team1Name: S.teams[1].name,
          team0Score: S.teams[0].score,
          team1Score: S.teams[1].score,
        });
      }
      break;

    case 'HOST_ACK':
      if (isGuest() && msg.name) {
        S.teams[0].name = msg.name;
        const oName = $('gr-other-name');
        if (oName) oName.textContent = msg.name;
      }
      break;

    case 'ROOM_STATE':
      if (isGuest()) {
        if (msg.round) S.round = msg.round;
        if (msg.picker !== undefined) S.picker = msg.picker;
        if (msg.theme) S.theme = msg.theme;
        if (msg.card) S.card = msg.card;
        if (msg.team0Name) S.teams[0].name = msg.team0Name;
        if (msg.team1Name) S.teams[1].name = msg.team1Name;
        if (msg.team0Score !== undefined) S.teams[0].score = msg.team0Score;
        if (msg.team1Score !== undefined) S.teams[1].score = msg.team1Score;
        hostReadyState = Boolean(msg.hostReady);

        const oName = $('gr-other-name');
        if (oName) oName.textContent = S.teams[0].name;
        const oStatus = $('gr-other-status');
        if (oStatus) {
          oStatus.textContent = hostReadyState ? '✓ Ready' : 'Waiting for drawer…';
          oStatus.className = hostReadyState ? 'ready-status ready' : 'ready-status waiting';
        }

        const isDrawing = $('s-draw').classList.contains('is-active');
        const isTheme = $('s-theme').classList.contains('is-active');
        const isPick = $('s-pick').classList.contains('is-active');
        if (!isDrawing && !isTheme && !isPick) {
          toGuestReady();
        }
      }
      break;

    case 'DRAWER_READY':
      if (isHost() && msg.role === 'guest') {
        guestReadyState = Boolean(msg.ready);
        const statusEl = $('hr-guest-status');
        if (statusEl) {
          statusEl.textContent = guestReadyState ? '✓ Ready' : 'Waiting for drawer…';
          statusEl.className = guestReadyState ? 'ready-status ready' : 'ready-status waiting';
        }
        if (hostReadyState && guestReadyState) {
          startHostSyncedRound();
        }
      } else if (isGuest() && msg.role === 'host') {
        hostReadyState = Boolean(msg.ready);
        const statusEl = $('gr-other-status');
        if (statusEl) {
          statusEl.textContent = hostReadyState ? '✓ Ready' : 'Waiting for drawer…';
          statusEl.className = hostReadyState ? 'ready-status ready' : 'ready-status waiting';
        }
        if (hostReadyState && guestReadyState) {
          startGuestSyncedRound();
        }
      }
      break;

    case 'WORD_SELECTED':
      if (S.round === msg.round || !S.round) {
        S.round = msg.round;
        S.picker = msg.picker;
        S.theme = msg.theme;
        S.card = msg.card;
        if (isHost()) {
          toHandoff();
        } else {
          toGuestReady();
        }
        toast(`${S.teams[msg.picker].name} picked ${msg.theme.name}!`);
        blip(700, 0.08);
      }
      break;

    case 'START_COUNTDOWN':
      if (isGuest()) {
        if (msg.round) S.round = msg.round;
        if (msg.theme) S.theme = msg.theme;
        if (msg.card) S.card = msg.card;
        startGuestRound();
        triggerSynchronizedCountdown(() => {
          if (msg.endsAt) {
            S.endsAt = msg.endsAt;
            runClock();
          }
        });
      }
      break;

    case 'START_ROUND':
      if (isGuest()) {
        if (S.round !== msg.round) S.round = msg.round;
        startGuestRound();
        if (msg.endsAt) {
          S.endsAt = msg.endsAt;
          runClock();
        }
      }
      break;

    case 'STROKES':
      if (msg.pts && Array.isArray(msg.pts)) {
        renderIncomingBatch(msg.from, msg.pts);
      }
      break;

    case 'STROKE':
      renderIncomingStroke(msg.from, msg.aNorm, msg.bNorm, msg.color);
      break;

    case 'CLEAR':
      clearIncomingSideboard(msg.from);
      break;

    case 'UNDO':
      renderIncomingUndo(msg.from);
      break;

    case 'SCORE':
      if (isGuest()) {
        stopClock();
        if (msg.team0Score !== undefined) S.teams[0].score = msg.team0Score;
        if (msg.team1Score !== undefined) S.teams[1].score = msg.team1Score;
        if (Array.isArray(msg.history)) {
          S.history = msg.history;
        } else if (S.card) {
          const strokes = typeof getCurrentStrokes === 'function' ? getCurrentStrokes() : [];
          S.history.push({ r: msg.round, w: S.card.word, t: S.theme?.name || '', win: msg.winner, p: msg.pts, strokes });
        }
        if (msg.winner === null) {
          $('res-eyebrow').textContent = `Round ${msg.round}`;
          $('verdict').textContent = 'Nobody got it';
          $('verdict').style.color = 'rgba(247,244,236,.35)';
        } else {
          $('res-eyebrow').textContent = `${S.teams[msg.winner].name} got there first`;
          $('verdict').textContent = `+${msg.pts}`;
          $('verdict').style.color = S.teams[msg.winner].color;
        }
        $('res-word').textContent = (S.card && S.card.word) || '';
        renderBoard($('board2'));
        show('s-result');
      }
      break;

    case 'NEXT_ROUND':
      if (isGuest()) {
        S.round = msg.round;
        saveLastJoin();
        toGuestReady();
      }
      break;

    case 'RENAME_TEAM':
      if (msg.teamIndex !== undefined && msg.name) {
        S.teams[msg.teamIndex].name = msg.name;
        renderBoard($('board'));
        renderBoard($('board2'));
        renderBoard($('board3'));
        const teamNameEl = $('guest-team-name');
        if (teamNameEl) teamNameEl.textContent = S.teams[1].name;
        const grMyName = $('gr-my-name');
        if (grMyName) grMyName.textContent = S.teams[1].name;
        toast(`${msg.name} updated their team name`);
      }
      break;

    case 'END_GAME':
      if (isGuest()) {
        stopClock();
        if (msg.team0Score !== undefined) S.teams[0].score = msg.team0Score;
        if (msg.team1Score !== undefined) S.teams[1].score = msg.team1Score;
        endGame(S.teams[msg.champIndex] || leader(), msg.reason);
      }
      break;
  }
}

function showInvite() {
  $('invite-code').textContent = formatJoinCode(S.code);

  const lhName = $('lobby-host-name');
  if (lhName) lhName.textContent = `${S.teams[0].name} (Host)`;
  const lgName = $('lobby-guest-name');
  if (lgName) lgName.textContent = S.teams[1].name;
  const lgStatus = $('lobby-guest-status');
  if (lgStatus) {
    lgStatus.textContent = guestInLobby ? '✓ Joined' : 'Waiting for join…';
    lgStatus.className = guestInLobby ? 'lobby-status ready' : 'lobby-status waiting';
  }

  if (isHost() && S.code && typeof connectP2P === 'function') {
    connectP2P({ code: S.code, role: 'host', onMessage: handleP2PMessage });
  }

  const url = joinUrl(S.code);
  const shareable = /^https?:$/.test(window.location.protocol);
  const holder = $('invite-qr');

  if (shareable) {
    try {
      holder.innerHTML = qrToSVG(encodeQR(url, { level: 'M' }), { scale: 6, quiet: 3 });
      $('invite-url').textContent = url;
      $('invite-qr-note').textContent = 'Point any camera at this: it opens the game already joined.';
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
  hostReadyState = false;
  guestReadyState = false;
  if (typeof resetDuoPad === 'function') resetDuoPad();

  S.picker = (S.round - 1) % 2;
  const t = S.teams[S.picker];
  $('roundlabel').textContent = `Round ${S.round}${S.rounds ? ` of ${S.rounds}` : ''}`;
  $('turn-team').textContent = t.name;
  $('turn-swatch').style.background = t.color;
  $('theme-who').textContent = `${t.name} picks the theme`;

  const hostWordBox = $('host-word-box');
  const hostReadyBox = $('host-ready-box');

  if (isSynced()) {
    $('sync-badge').hidden = false;
    $('sync-code').textContent = syncCode(S.seed, S.round);

    if (!S.card) {
      if (hostWordBox) hostWordBox.hidden = true;
      if (hostReadyBox) hostReadyBox.hidden = true;

      if (S.picker === 0) {
        $('handoff-head').textContent = `Your turn to pick, ${S.teams[0].name}!`;
        $('handoff-sub').textContent = 'Choose a theme and word for both teams to draw.';
        $('reveal').textContent = 'Pick theme and word';
        $('reveal').hidden = false;
      } else {
        $('handoff-head').textContent = `${S.teams[1].name} is choosing…`;
        $('handoff-sub').textContent = `Waiting for ${S.teams[1].name} to choose the theme and word.`;
        $('reveal').textContent = 'Pick on this phone instead';
        $('reveal').hidden = false;
      }
    } else {
      if (hostWordBox) {
        hostWordBox.hidden = false;
        $('host-word-theme').textContent = `${S.theme.icon || '🎨'} ${S.theme.name} · Worth ${S.card.pts}`;
        $('host-word-text').textContent = S.card.word;
      }
      $('handoff-head').textContent = 'Both drawers, ready?';
      $('handoff-sub').textContent = 'Mark ready when set. The host starts the countdown when both are ready.';
      $('reveal').textContent = 'Start game';
      $('reveal').hidden = false;

      if (hostReadyBox) {
        hostReadyBox.hidden = false;
        const hrHost = $('hr-host-name');
        if (hrHost) hrHost.textContent = S.teams[0].name;
        const hrGuest = $('hr-guest-name');
        if (hrGuest) hrGuest.textContent = S.teams[1].name;
        const hrHostBtn = $('hr-host-btn');
        if (hrHostBtn) hrHostBtn.textContent = "I'm ready";
        const hrGuestStatus = $('hr-guest-status');
        if (hrGuestStatus) {
          hrGuestStatus.textContent = guestReadyState ? '✓ Ready' : 'Waiting for drawer…';
          hrGuestStatus.className = guestReadyState ? 'ready-status ready' : 'ready-status waiting';
        }
      }
    }
  } else {
    if (hostWordBox) hostWordBox.hidden = true;
    if (hostReadyBox) hostReadyBox.hidden = true;
    $('handoff-head').textContent = 'Both drawers, huddle up';
    $('handoff-sub').textContent =
      'One drawer from each team looks at the screen together. Everyone else: eyes off.';
    $('reveal').textContent = "We're the drawers: deal us in";
    $('reveal').hidden = false;
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
          <span style="min-width:0;flex:1"><span class="tt">${t.name}</span><span class="td">${note}</span></span>
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
  $('pick-who').textContent = `${S.theme.name}: both teams draw it`;
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
    .forEach((b) => (b.onclick = () => selectCard(S.cards[Number(b.dataset.i)])));
}

function selectCard(card) {
  S.card = card;
  if (isSynced()) {
    if (typeof sendP2P === 'function') {
      sendP2P('WORD_SELECTED', {
        round: S.round,
        picker: S.picker,
        theme: S.theme,
        card: S.card,
      });
    }
    if (isHost()) {
      toHandoff();
    } else {
      toGuestReady();
    }
  } else {
    startRound(card);
  }
}

function dealSyncedRound() {
  if (S.card) {
    startHostSyncedRound();
  } else {
    dealThemes();
    show('s-theme');
  }
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
      buzzer();
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

  if (isHost() && typeof sendP2P === 'function') {
    sendP2P('START_ROUND', { round: S.round, endsAt: S.endsAt, len: S.len });
  }
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

  const strokes = typeof getCurrentStrokes === 'function' ? getCurrentStrokes() : [];
  S.history.push({ r: S.round, w: S.card.word, t: S.theme.name, win: winner, p: pts, strokes });
  $('res-word').textContent = S.card.word;
  renderBoard($('board2'));
  persist();

  if (isHost() && typeof sendP2P === 'function') {
    sendP2P('SCORE', {
      winner,
      pts,
      round: S.round,
      team0Score: S.teams[0].score,
      team1Score: S.teams[1].score,
      history: S.history,
    });
  }

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
  S.card = null;
  S.theme = null;
  persist();
  toHandoff();

  if (isHost() && typeof sendP2P === 'function') {
    sendP2P('NEXT_ROUND', { round: S.round });
  }
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
  victoryFanfare();
  burstConfetti(champ.color || '#FF4262', other ? other.color : '#3D9BFF');

  if (isHost() && typeof sendP2P === 'function') {
    sendP2P('END_GAME', {
      champIndex: S.teams.indexOf(champ),
      reason: S.endReason,
      team0Score: S.teams[0].score,
      team1Score: S.teams[1].score,
    });
  }
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
  if (typeof resetDuoPad === 'function') resetDuoPad();
  const overCap = Boolean(S.rounds && S.round > S.rounds);
  const head = $('guest-head');
  const sub = $('guest-sub');
  const startBtn = $('guest-start');
  const guestWordBox = $('guest-word-box');
  const guestReadyBox = $('guest-ready-box');
  const guestPreviewBox = $('guest-preview-box');
  const guestActionStack = $('guest-action-stack');

  S.picker = (S.round - 1) % 2;

  if (overCap) {
    $('guest-round').textContent = `Round ${S.rounds} of ${S.rounds}`;
    $('guest-sync').textContent = 'DONE';
    if (head) head.textContent = 'Game complete';
    if (sub) sub.textContent = 'All rounds have been played. Check the host phone for the final tally and podium.';
    if (guestWordBox) guestWordBox.hidden = true;
    if (guestReadyBox) guestReadyBox.hidden = true;
    if (guestPreviewBox) guestPreviewBox.hidden = false;
    $('guest-theme').textContent = '🏁 All done';
    $('guest-worth').textContent = 'Game over';
    if (guestActionStack) guestActionStack.hidden = false;
    startBtn.textContent = 'Leave game';
    startBtn.onclick = leaveGame;
    show('s-guest');
    return;
  }

  $('guest-round').textContent = `Round ${S.round}${S.rounds ? ` of ${S.rounds}` : ''}`;
  $('guest-sync').textContent = syncCode(S.seed, S.round);

  const teamNameEl = $('guest-team-name');
  if (teamNameEl) teamNameEl.textContent = S.teams[1].name;
  const teamDotEl = $('guest-team-dot');
  if (teamDotEl) teamDotEl.style.background = S.teams[1].color;

  const grMyName = $('gr-my-name');
  if (grMyName) grMyName.textContent = S.teams[1].name;
  const grMyDot = $('gr-my-dot');
  if (grMyDot) grMyDot.style.background = S.teams[1].color;
  const grOtherName = $('gr-other-name');
  if (grOtherName) grOtherName.textContent = S.teams[0].name;
  const grMyBtn = $('gr-my-btn');
  if (grMyBtn) grMyBtn.textContent = guestReadyState ? '✓ Ready (waiting)' : "I'm ready";
  const grOtherStatus = $('gr-other-status');
  if (grOtherStatus) {
    grOtherStatus.textContent = hostReadyState ? '✓ Ready' : 'Waiting for drawer…';
    grOtherStatus.className = hostReadyState ? 'ready-status ready' : 'ready-status waiting';
  }

  if (!S.card) {
    if (guestWordBox) guestWordBox.hidden = true;
    if (guestReadyBox) guestReadyBox.hidden = true;
    if (guestPreviewBox) guestPreviewBox.hidden = false;

    if (S.picker === 1) {
      if (head) head.textContent = `Your turn to pick, ${S.teams[1].name}!`;
      if (sub) sub.textContent = 'Choose a theme and word for both teams to draw.';
      $('guest-theme').textContent = '❓ Choose theme';
      $('guest-worth').textContent = 'Select card';
      if (guestActionStack) guestActionStack.hidden = false;
      startBtn.textContent = 'Pick theme and word';
      startBtn.onclick = () => {
        dealThemes();
        show('s-theme');
      };
    } else {
      if (head) head.textContent = `${S.teams[0].name} is choosing…`;
      if (sub) sub.textContent = `Waiting for ${S.teams[0].name} to choose the theme and word.`;
      $('guest-theme').textContent = '⏳ Waiting for pick';
      $('guest-worth').textContent = '...';
      if (guestActionStack) guestActionStack.hidden = false;
      startBtn.textContent = 'Pick on this phone instead';
      startBtn.onclick = () => {
        dealThemes();
        show('s-theme');
      };
    }
  } else {
    if (guestWordBox) {
      guestWordBox.hidden = false;
      $('guest-word-theme').textContent = `${S.theme.icon || '🎨'} ${S.theme.name} · Worth ${S.card.pts}`;
      $('guest-word-text').textContent = S.card.word;
    }
    if (guestPreviewBox) guestPreviewBox.hidden = true;
    if (guestActionStack) guestActionStack.hidden = true;

    if (head) head.textContent = "You're a drawer";
    if (sub) sub.textContent = 'Mark ready when set. The host will start the countdown for both teams.';
    if (guestReadyBox) guestReadyBox.hidden = false;
  }

  show('s-guest');
}

function startGuestRound() {
  if (!S.card) {
    const r = roundFor(S.seed, S.diff, S.round);
    S.theme = r.theme;
    S.card = { tier: r.tier, pts: r.pts, word: r.word };
  }
  startRound(S.card);
}

function endGuestRound() {
  stopClock();
  S.round++;
  S.card = null;
  S.theme = null;
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
  if (typeof disconnectP2P === 'function') disconnectP2P();
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
  if (typeof connectP2P === 'function') {
    connectP2P({ code: S.code, role: 'guest', onMessage: handleP2PMessage });
    sendP2P('PEER_JOINED', { name: S.teams[1].name });
    sendP2P('SYNC_REQUEST', { round: S.round });
  }
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

let activeShareTab = 'tally';

async function updateShareCard() {
  const shot = $('shot');
  shot.innerHTML = '';
  $('sh-hint').textContent = 'Rendering…';

  await fontsReady();
  const gameData = {
    teams: S.teams.map((t, i) => ({ name: t.name, score: t.score, color: TEAM_HEX[i] })),
    rounds: S.history.length,
    wordsUsed: isSynced() ? S.history.length : S.used.size,
    reason: S.endReason,
    history: S.history,
  };

  const canvas = activeShareTab === 'gallery' ? renderGalleryCard(gameData) : renderShareCard(gameData);
  shot.appendChild(canvas);
  $('sh-hint').textContent = 'Long-press the image to save it, or use the button below.';

  $('sh-share').onclick = async () => {
    const filename = `marker-mayhem-${activeShareTab}-${Date.now()}.png`;
    const result = await exportCard(canvas, filename);
    if (result === 'shared') {
      toast('Shared');
    } else if (result === 'downloaded') {
      toast('Image saved');
    } else if (result !== 'cancelled') {
      toast('Long-press the image to save it');
    }
  };
}

async function openShare() {
  const modal = $('share-modal');
  modal.classList.add('on');
  activeShareTab = 'tally';
  const tabTally = $('tab-tally');
  const tabGallery = $('tab-gallery');
  if (tabTally) tabTally.classList.add('is-active');
  if (tabGallery) tabGallery.classList.remove('is-active');

  await updateShareCard();
}

const closeShare = () => $('share-modal').classList.remove('on');

/* =============================================================== settings */

function openSettings() {
  const modal = $('settings-modal');
  if (!modal) return;
  loadSettings();

  const soundToggle = $('set-sound');
  if (soundToggle) soundToggle.checked = settings.sound;

  const volumeSlider = $('set-volume');
  const volumeVal = $('set-volume-val');
  if (volumeSlider) {
    volumeSlider.value = Math.round((settings.volume || 0.75) * 100);
    if (volumeVal) volumeVal.textContent = `${volumeSlider.value}%`;
  }

  const buzzerToggle = $('set-buzzer');
  if (buzzerToggle) buzzerToggle.checked = settings.buzzer;

  const fanfareToggle = $('set-fanfare');
  if (fanfareToggle) fanfareToggle.checked = settings.fanfare;

  const hapticsRow = $('haptics-row');
  const hapticsToggle = $('set-haptics');
  if (hapticsRow) {
    hapticsRow.hidden = !hapticsSupported;
  }
  if (hapticsToggle) {
    hapticsToggle.checked = settings.haptics;
  }

  modal.classList.add('on');
}

function closeSettings() {
  const modal = $('settings-modal');
  if (modal) modal.classList.remove('on');
}

function wireSettings() {
  const openBtn = $('open-settings');
  if (openBtn) openBtn.onclick = openSettings;

  const closeBtn = $('settings-close');
  if (closeBtn) closeBtn.onclick = closeSettings;

  const modal = $('settings-modal');
  if (modal) {
    modal.onclick = (e) => e.target === modal && closeSettings();
  }

  const soundToggle = $('set-sound');
  if (soundToggle) {
    soundToggle.onchange = () => {
      settings.sound = soundToggle.checked;
      saveSettings();
      if (settings.sound) blip(520, 0.05);
    };
  }

  const volumeSlider = $('set-volume');
  const volumeVal = $('set-volume-val');
  if (volumeSlider) {
    volumeSlider.oninput = () => {
      const val = Number(volumeSlider.value);
      settings.volume = Math.max(0, Math.min(1, val / 100));
      if (volumeVal) volumeVal.textContent = `${val}%`;
      saveSettings();
    };
    volumeSlider.onchange = () => {
      blip(660, 0.06);
    };
  }

  const buzzerToggle = $('set-buzzer');
  if (buzzerToggle) {
    buzzerToggle.onchange = () => {
      settings.buzzer = buzzerToggle.checked;
      saveSettings();
    };
  }

  const fanfareToggle = $('set-fanfare');
  if (fanfareToggle) {
    fanfareToggle.onchange = () => {
      settings.fanfare = fanfareToggle.checked;
      saveSettings();
    };
  }

  const hapticsToggle = $('set-haptics');
  if (hapticsToggle) {
    hapticsToggle.onchange = () => {
      settings.haptics = hapticsToggle.checked;
      saveSettings();
      if (settings.haptics) buzz(14);
    };
  }

  const tabTally = $('tab-tally');
  const tabGallery = $('tab-gallery');
  if (tabTally && tabGallery) {
    tabTally.onclick = () => {
      if (activeShareTab === 'tally') return;
      activeShareTab = 'tally';
      tabTally.classList.add('is-active');
      tabGallery.classList.remove('is-active');
      updateShareCard();
    };
    tabGallery.onclick = () => {
      if (activeShareTab === 'gallery') return;
      activeShareTab = 'gallery';
      tabGallery.classList.add('is-active');
      tabTally.classList.remove('is-active');
      updateShareCard();
    };
  }
}

/* ================================================================ wiring */

function wireEvents() {
  wireSettings();
  const hrHostBtn = $('hr-host-btn');
  if (hrHostBtn) {
    hrHostBtn.onclick = () => {
      hostReadyState = !hostReadyState;
      hrHostBtn.textContent = hostReadyState ? '✓ Ready (waiting)' : "I'm ready";
      if (typeof sendP2P === 'function') {
        sendP2P('DRAWER_READY', { role: 'host', ready: hostReadyState, round: S.round });
      }
      if (hostReadyState && guestReadyState) {
        startHostSyncedRound();
      }
    };
  }

  $('reveal').onclick = () => {
    if (isSynced()) {
      if (!S.card) {
        if (S.picker === 0) {
          dealThemes();
          show('s-theme');
        } else {
          const r = roundFor(S.seed, S.diff, S.round);
          S.theme = r.theme;
          S.card = { tier: r.tier, pts: r.pts, word: r.word };
          sendP2P('WORD_SELECTED', { round: S.round, picker: S.picker, theme: S.theme, card: S.card });
          toHandoff();
        }
        return;
      }
      hostReadyState = true;
      if (hrHostBtn) hrHostBtn.textContent = '✓ Ready (waiting)';
      if (typeof sendP2P === 'function') {
        sendP2P('DRAWER_READY', { role: 'host', ready: true, round: S.round });
      }
      startHostSyncedRound();
      return;
    }
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
    if (e.key === 'Escape') {
      if ($('share-modal') && $('share-modal').classList.contains('on')) closeShare();
      if ($('settings-modal') && $('settings-modal').classList.contains('on')) closeSettings();
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
      toast('Copy not available: read it out instead');
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

  const grMyBtn = $('gr-my-btn');
  if (grMyBtn) {
    grMyBtn.onclick = () => {
      guestReadyState = !guestReadyState;
      grMyBtn.textContent = guestReadyState ? '✓ Ready (waiting)' : "I'm ready";
      if (typeof sendP2P === 'function') {
        sendP2P('DRAWER_READY', { role: 'guest', ready: guestReadyState, round: S.round });
      }
      if (hostReadyState && guestReadyState) {
        startGuestSyncedRound();
      }
    };
  }

  $('guest-start').onclick = () => {
    if (!S.card) {
      if (S.picker === 1) {
        dealThemes();
        show('s-theme');
      } else {
        const r = roundFor(S.seed, S.diff, S.round);
        S.theme = r.theme;
        S.card = { tier: r.tier, pts: r.pts, word: r.word };
        sendP2P('WORD_SELECTED', { round: S.round, picker: S.picker, theme: S.theme, card: S.card });
        toGuestReady();
      }
      return;
    }
    guestReadyState = true;
    if (grMyBtn) grMyBtn.textContent = '✓ Ready (waiting)';
    if (typeof sendP2P === 'function') {
      sendP2P('DRAWER_READY', { role: 'guest', ready: true, round: S.round });
    }
    if (hostReadyState && guestReadyState) {
      startGuestSyncedRound();
    } else {
      startGuestRound();
    }
  };
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
      if (typeof sendP2P === 'function') {
        sendP2P('RENAME_TEAM', { teamIndex: 1, name: S.teams[1].name });
      }
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
    if (typeof sendP2P === 'function') {
      sendP2P('RENAME_TEAM', { teamIndex: 0, name: S.teams[0].name });
      sendP2P('RENAME_TEAM', { teamIndex: 1, name: S.teams[1].name });
    }
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
    } else {
      if ($('s-draw').classList.contains('is-active') && S.ticker) {
        paintClock();
        requestWakeLock();
      }
      if (typeof sendP2P === 'function') {
        if (isGuest()) {
          sendP2P('SYNC_REQUEST', { round: S.round });
        } else if (isHost()) {
          sendP2P('ROOM_STATE', {
            round: S.round,
            picker: S.picker,
            theme: S.theme,
            card: S.card,
            hostReady: hostReadyState,
            team0Name: S.teams[0].name,
            team1Name: S.teams[1].name,
            team0Score: S.teams[0].score,
            team1Score: S.teams[1].score,
          });
        }
      }
    }
  });

  window.addEventListener('pagehide', () => {
    stopScanner();
    releaseWakeLock();
  });

  window.addEventListener('beforeunload', (e) => {
    if (isGameActive()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  window.addEventListener('popstate', async () => {
    if (isGameActive()) {
      try {
        history.pushState({ inGame: true }, '');
      } catch (err) {}
      const ok = await confirmSheet({
        title: 'Leave the game?',
        body: 'Are you sure you want to leave? Active round progress will be lost.',
        yes: 'Leave game',
        no: 'Stay in game',
      });
      if (ok) {
        stopClock();
        if (typeof disconnectP2P === 'function') disconnectP2P();
        S.mode = 'solo';
        S.seed = null;
        S.code = null;
        applyMode();
        await renderSaves();
        show('s-setup');
      }
    }
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
