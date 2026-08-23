/**
 * sync.js — deriving rounds that every device agrees on.
 *
 * The rule that makes this work: a round is a pure function of (seed, round
 * number, difficulty). Nothing about *this* device may leak into it — not how
 * many words it has drawn, not when it joined, not which themes anyone picked.
 * A phone that joins at round 7 must compute round 7 exactly as the host did.
 *
 * That rules out the solo-mode approach of drawing from a mutable used-set,
 * because two devices accumulate different sets. Instead the used-set is itself
 * derived: to play round N, replay rounds 1..N. Every device replays the same
 * history and lands in the same place. Replay is memoised, so the cost is one
 * derivation per round, not N.
 *
 * The trade is that nobody picks the theme or the card — the round deals
 * itself. For all-play that is arguably fairer anyway: neither team gets to
 * choose the stakes.
 */

import { createRng, hashSeed } from './rng.js';
import { ALL_THEMES, THEMES, mashupWord, TIER_LADDER } from './words.js';

/** Weighting for the 1, 2 and 3 point slots. Middle stakes come up most. */
const STAKE_WEIGHTS = [0.34, 0.4, 0.26];

const SYNC_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * @typedef {Object} SyncedRound
 * @property {number} n round number, 1-based
 * @property {string} word the prompt
 * @property {Object} theme theme it came from
 * @property {number} pts stake, 1-3
 * @property {number} tier difficulty tier the word was drawn from
 */

/** Per (seed, difficulty) replay state, so we never redo work. */
const replays = new Map();

function replayFor(seed, diff) {
  const key = `${seed}:${diff}`;
  let state = replays.get(key);
  if (!state) {
    state = { rounds: [], used: new Set() };
    replays.set(key, state);
  }
  return state;
}

/** Drop memoised state. Only needed when a game is abandoned. */
export function resetReplay(seed, diff) {
  if (seed === undefined) replays.clear();
  else replays.delete(`${seed}:${diff}`);
}

function stakeIndex(rng) {
  const roll = rng.next();
  let acc = 0;
  for (let i = 0; i < STAKE_WEIGHTS.length; i++) {
    acc += STAKE_WEIGHTS[i];
    if (roll < acc) return i;
  }
  return STAKE_WEIGHTS.length - 1;
}

function tierFor(diff, slot, rng) {
  if (diff !== 'mixed') return TIER_LADDER[diff][slot];
  return Math.min(4, slot + 1 + (rng.next() < 0.5 ? 0 : 1));
}

/**
 * Draw one unused prompt using only this round's generator.
 * Cascades the same way solo mode does, so a drained theme degrades instead of
 * repeating: requested tier, other tiers, other themes, then mashups.
 */
function drawFrom(theme, tier, used, rng) {
  const fresh = (t) => {
    for (let i = 0; i < 120; i++) {
      const w = mashupWord(t, rng);
      if (!used.has(w)) return w;
    }
    return mashupWord(4, rng);
  };

  if (theme.gen) return fresh(tier);

  const order = [Math.min(tier, 3), 3, 2, 1];
  const take = (t) => {
    for (const k of order) {
      const pool = (t.words[k] || []).filter((w) => !used.has(w));
      if (pool.length) return rng.pick(pool);
    }
    return null;
  };

  const direct = take(theme);
  if (direct) return direct;

  for (const other of rng.shuffle(THEMES)) {
    const w = take(other);
    if (w) return w;
  }

  return fresh(tier);
}

/**
 * The round every device will show.
 * @param {number} seed
 * @param {string} diff
 * @param {number} n 1-based round number
 * @returns {SyncedRound}
 */
export function roundFor(seed, diff, n) {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`Round must be a positive integer, got ${n}`);

  const state = replayFor(seed, diff);

  for (let r = state.rounds.length + 1; r <= n; r++) {
    const rng = createRng(hashSeed(`mm:${seed}:${diff}:${r}`));
    const theme = rng.pick(ALL_THEMES);
    const slot = stakeIndex(rng);
    const tier = tierFor(diff, slot, rng);
    const word = drawFrom(theme, tier, state.used, rng);

    state.used.add(word);
    state.rounds.push({ n: r, word, theme, pts: slot + 1, tier });
  }

  return state.rounds[n - 1];
}

/** Every round up to and including n. Used for the recap on a guest device. */
export function roundsThrough(seed, diff, n) {
  roundFor(seed, diff, n);
  return replayFor(seed, diff).rounds.slice(0, n);
}

/**
 * A four-character fingerprint of (seed, round), shown on every device.
 *
 * There is no channel to detect drift automatically, so this makes it visible:
 * matching codes mean matching words. If two phones disagree, one of them
 * double-tapped "next round" and can step back.
 *
 * @returns {string} e.g. "A7F2"
 */
export function syncCode(seed, n) {
  let h = hashSeed(`sync:${seed}:${n}`);
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += SYNC_ALPHABET[h & 31];
    h >>>= 5;
  }
  return out;
}
