/**
 * nav.js - back navigation for the installed app.
 *
 * Two problems, one module.
 *
 * The app is a stack of <section class="screen"> elements and, until now, the
 * only way out of one was whatever button that screen happened to offer.
 * Installed to a home screen there is no browser chrome to fall back on, so a
 * player who wandered into the join form had nothing to press. Every screen
 * now carries a back button and all of them call goBack().
 *
 * The second problem is the OS back gesture. index.html is a single document
 * with a single history entry, so an edge swipe pops that entry and unloads
 * the app - on Android, an installed PWA closes outright, mid-round. The fix
 * is to keep a spare entry underneath at all times: arm() pushes one, and
 * every popstate re-arms before doing anything else, so the gesture always
 * has something to consume that is not the app itself. Net entry count stays
 * flat (one popped, one pushed), and what the gesture *means* is decided here
 * rather than by the browser.
 *
 * The old approach did the opposite: show() pushed an entry per screen change,
 * so the stack grew all game and back had to be pressed once per screen
 * visited before anything happened.
 */

/** Marks the entries we own, so a foreign entry is at least recognisable. */
const NAV_STATE = { markerAndMayhemNav: true };

/** Dismissable things stacked above the screens, checked in this order. */
const navLayers = [];

let navCurrent = null;
let navPrevious = null;
let navBackHandler = null;
let navArmed = false;
let navUrl = null;

const hasHistory = () => typeof window !== 'undefined' && !!window.history;

/**
 * Put a spare entry under the current one. Idempotent per pop: called once at
 * boot and once from every popstate, never twice for the same entry.
 *
 * It re-states the canonical URL rather than inheriting whatever the pop left
 * in the address bar. A guest arriving on `#join=CODE` has that hash on the
 * entry underneath ours, so popping to it puts a spent invite back in the URL
 * - and back on screen, and back in anything they copy from there.
 */
function arm() {
  if (!hasHistory()) return;
  try {
    window.history.pushState(NAV_STATE, '', navUrl || undefined);
    navArmed = true;
  } catch (err) {
    /* Some file:// and sandboxed contexts refuse pushState. In-app back
       still works from the buttons; only the gesture is lost. */
  }
}

/**
 * Register something that back should close before it touches the screens -
 * a modal, the drawing pad, the hidden-screen veil. Registration order is
 * priority order, so register the most modal first.
 *
 * @param {{ isOpen: () => boolean, close: () => void }} layer
 */
export function registerNavLayer(layer) {
  navLayers.push(layer);
}

/** Close the topmost open layer. True if one was open. */
export function dismissTopLayer() {
  for (const layer of navLayers) {
    if (layer.isOpen()) {
      layer.close();
      return true;
    }
  }
  return false;
}

/**
 * The one function that decides what back means for the screens themselves.
 *
 * @param {(current: string, previous: string|null) => void|Promise<void>} fn
 */
export function setNavBackHandler(fn) {
  navBackHandler = fn;
}

/** show() reports here so back knows where it is and where it came from. */
export function noteScreen(id) {
  if (id === navCurrent) return;
  navPrevious = navCurrent;
  navCurrent = id;
}

export const currentScreen = () => navCurrent;
export const previousScreen = () => navPrevious;

/**
 * Back, from any source: the gesture, the hardware key, a back button.
 * Layers first - a player with the drawing pad open means the pad, not the
 * round underneath it.
 */
export async function goBack() {
  if (dismissTopLayer()) return;
  if (navBackHandler) await navBackHandler(navCurrent, navPrevious);
}

/**
 * replaceState that keeps our marker on the entry, for the one caller that
 * rewrites the URL (stripping an invite hash after joining).
 */
export function replaceNavUrl(url) {
  if (!hasHistory()) return;
  try {
    window.history.replaceState(navArmed ? NAV_STATE : null, '', url);
    navUrl = url;
  } catch (err) {
    /* A URL the browser will not accept is not worth failing a join over. */
  }
}

/**
 * Arm the guard and route every pop through goBack().
 *
 * @param {string} [initialScreen] - the screen already active in the markup,
 *   which never went through show() and so was never noted.
 */
export function initNav(initialScreen) {
  if (typeof window === 'undefined') return;
  if (initialScreen) noteScreen(initialScreen);
  arm();
  window.addEventListener('popstate', () => {
    // Re-arm first: whatever goBack() does next (including awaiting a
    // confirmation the player may decline) must not leave us unguarded.
    arm();
    goBack();
  });
}
