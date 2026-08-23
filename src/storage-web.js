/**
 * storage-web.js — localStorage + sessionStorage adapters.
 *
 * NOT imported by the default build historically; now wired in game.js ahead
 * of the memory fallback so saved games survive closing the tab in the wild.
 * Some runtimes sandbox the iframe such that localStorage throws on access,
 * hence the probe in each `available()` and the sessionStorage step between
 * durable and in-memory storage.
 */

const PREFIX = 'mm:';

function probe(area) {
  try {
    const probeKey = PREFIX + '__probe';
    area.setItem(probeKey, '1');
    area.removeItem(probeKey);
    return true;
  } catch (e) {
    return false;
  }
}

function areaAdapter(name, getArea) {
  return {
    name,
    available() {
      try {
        return typeof window !== 'undefined' && !!getArea() && probe(getArea());
      } catch (e) {
        return false;
      }
    },
    async get(key) {
      try {
        const raw = getArea().getItem(PREFIX + key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    },
    async set(key, value) {
      try {
        getArea().setItem(PREFIX + key, JSON.stringify(value));
        return true;
      } catch (e) {
        return false;
      }
    },
  };
}

export const webAdapter = areaAdapter('localStorage', () => window.localStorage);

export const sessionAdapter = areaAdapter('sessionStorage', () => window.sessionStorage);
