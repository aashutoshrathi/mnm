/**
 * rng.js — all randomness in the app funnels through here.
 *
 * Two shapes, for two jobs:
 *
 *   - `pick` / `shuffle` are ordinary unseeded helpers. Solo play uses them,
 *     because one phone drawing from a mutable used-set needs no reproducibility.
 *   - `createRng(seed)` is an isolated generator. Synced play derives each round
 *     from its own instance, so a round depends only on (seed, round) and never
 *     on how many draws happened to come before it on this particular device.
 *
 * The second shape is what makes multi-device play work with no network: two
 * phones holding the same seed compute the same rounds forever.
 */

/** Small, fast, well-distributed PRNG. Public domain. */
function mulberry32(a) {
  let state = a >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a. Turns a string into a 32-bit seed.
 * @param {string} str
 * @returns {number} unsigned 32-bit integer
 */
export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * An independent generator. Nothing outside can perturb its sequence, which is
 * the property synced rounds depend on.
 *
 * @param {string|number} seedValue
 * @returns {{next: () => number, pick: Function, shuffle: Function, int: (n:number) => number}}
 */
export function createRng(seedValue) {
  const next = mulberry32(typeof seedValue === 'string' ? hashSeed(seedValue) : seedValue >>> 0);
  return {
    next,
    /** @template T @param {T[]} arr @returns {T} */
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** Fisher-Yates on a copy. @template T @param {T[]} arr @returns {T[]} */
    shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    /** Integer in [0, n). */
    int: (n) => Math.floor(next() * n),
  };
}

/* ------------------------------------------------------------ unseeded */

/** @template T @param {T[]} arr @returns {T} */
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Fisher-Yates on a copy. @template T @param {T[]} arr @returns {T[]} */
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
