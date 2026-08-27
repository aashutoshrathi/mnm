/**
 * storage.js - saved games.
 *
 * The app talks to an adapter, never to a storage API directly, because the
 * available API depends on where this is running. Two adapters ship here; a
 * third (localStorage, for your own deployment) lives in storage-web.js and
 * is wired up by changing one line in game.js. See README, "Persistence".
 */

/** Host-provided key/value store, present in some embedded runtimes. */
const hostAdapter = {
  name: 'host',
  available: () =>
    typeof window !== 'undefined' && !!window.storage && typeof window.storage.get === 'function',
  async get(key) {
    try {
      const r = await window.storage.get(key);
      return r ? JSON.parse(r.value) : null;
    } catch (e) {
      return null;
    }
  },
  async set(key, value) {
    try {
      await window.storage.set(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  },
};

/** Last resort. Survives navigation within a session, nothing beyond that. */
const memoryAdapter = (() => {
  const map = new Map();
  return {
    name: 'memory',
    available: () => true,
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async set(key, value) {
      map.set(key, value);
      return true;
    },
  };
})();

export const ADAPTERS = { host: hostAdapter, memory: memoryAdapter };

/**
 * @param {Array} candidates adapters in order of preference
 * @returns {{get:Function, set:Function, name:string, durable:boolean}}
 *
 * The first available adapter is selected once at construction time and never
 * re-evaluated. If a more durable backend becomes available later (e.g. a
 * sandboxed iframe is granted localStorage access), the store will not switch.
 * Re-create the store if that matters for your runtime.
 */
export function createStore(candidates = [hostAdapter, memoryAdapter]) {
  const chosen = candidates.find((a) => a.available()) || memoryAdapter;
  return {
    name: chosen.name,
    durable: chosen.name !== 'memory',
    get: (key) => chosen.get(key),
    set: (key, value) => chosen.set(key, value),
  };
}
