/**
 * feedback.js — sound and haptics.
 *
 * Haptics note: navigator.vibrate is supported on Android browsers and not on
 * iOS Safari, where every call is a silent no-op. There is no web API that
 * reaches the iPhone taptic engine, so iOS users get audio only.
 */

export const settings = { sound: true, haptics: true };

/* ---------------------------------------------------------------- audio -- */

let ac = null;

function ctx() {
  if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
  if (ac.state === 'suspended') ac.resume();
  return ac;
}

/** Short square-wave tone. Used for confirmations and the final buzzer. */
export function blip(freq, dur, vol = 0.05) {
  if (!settings.sound) return;
  try {
    const c = ctx();
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    o.connect(g);
    g.connect(c.destination);
    o.start();
    o.stop(c.currentTime + dur);
  } catch (e) {
    /* audio is a nicety, never a failure */
  }
}

/** Dry clock tick. The fast pitch drop is what makes it read as a click. */
export function tock(freq, vol) {
  if (!settings.sound) return;
  try {
    const c = ctx();
    const t = c.currentTime;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.35, t + 0.03);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g);
    g.connect(c.destination);
    o.start(t);
    o.stop(t + 0.06);
  } catch (e) {
    /* no-op */
  }
}

/* -------------------------------------------------------------- haptics -- */

export function buzz(pattern) {
  if (!settings.haptics || !navigator.vibrate) return;
  try {
    navigator.vibrate(pattern);
  } catch (e) {
    /* no-op */
  }
}

/** True if this device can actually vibrate. Used to hide a dead toggle. */
export const hapticsSupported = typeof navigator !== 'undefined' && !!navigator.vibrate;

/**
 * One delegated listener gives every button a tap response, including buttons
 * rendered later. Weight is taken from data-haptic, otherwise inferred from
 * how prominent the control is.
 */
export function wireButtonHaptics(root = document) {
  root.addEventListener(
    'pointerdown',
    (e) => {
      const b = e.target.closest('button, .save .resume, .save .del');
      if (!b || b.disabled) return;
      if (b.dataset.haptic) return buzz(Number(b.dataset.haptic));
      if (b.classList.contains('btn')) return buzz(14);
      if (b.classList.contains('linkbtn') || b.classList.contains('info')) return buzz(7);
      buzz(10);
    },
    { passive: true }
  );
}
