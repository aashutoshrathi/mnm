/**
 * feedback.js - sound, haptics, and audio settings persistence.
 *
 * Haptics note: navigator.vibrate is supported on Android browsers and not on
 * iOS Safari, where every call is a silent no-op. There is no web API that
 * reaches the iPhone taptic engine, so iOS users get audio only.
 */

const SETTINGS_STORAGE_KEY = 'mnm_audio_settings';

export const settings = {
  sound: true,
  haptics: true,
  buzzer: true,
  fanfare: true,
  volume: 0.75,
};

export function loadSettings() {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (typeof data.sound === 'boolean') settings.sound = data.sound;
    if (typeof data.haptics === 'boolean') settings.haptics = data.haptics;
    if (typeof data.buzzer === 'boolean') settings.buzzer = data.buzzer;
    if (typeof data.fanfare === 'boolean') settings.fanfare = data.fanfare;
    if (typeof data.volume === 'number' && data.volume >= 0 && data.volume <= 1) {
      settings.volume = data.volume;
    }
  } catch (err) {
    /* fallback to defaults */
  }
}

export function saveSettings() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (err) {
    /* no-op */
  }
}

// Initial load
loadSettings();

/* ---------------------------------------------------------------- audio -- */

let ac = null;

function ctx() {
  if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
  if (ac.state === 'suspended') ac.resume();
  return ac;
}

/** Short square-wave tone. Used for confirmations and UI clicks. */
export function blip(freq, dur = 0.08, vol = 0.05) {
  if (!settings.sound) return;
  try {
    const c = ctx();
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    const effectiveVol = vol * (settings.volume || 0.75);
    g.gain.setValueAtTime(effectiveVol, c.currentTime);
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
export function tock(freq, vol = 0.06) {
  if (!settings.sound) return;
  try {
    const c = ctx();
    const t = c.currentTime;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.35, t + 0.03);
    const effectiveVol = vol * (settings.volume || 0.75);
    g.gain.setValueAtTime(effectiveVol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g);
    g.connect(c.destination);
    o.start(t);
    o.stop(t + 0.06);
  } catch (e) {
    /* no-op */
  }
}

/** Game timer expiry buzzer tone with haptics. */
export function buzzer() {
  if (settings.haptics) buzz([80, 50, 140]);
  if (!settings.sound || !settings.buzzer) return;
  try {
    const c = ctx();
    const t = c.currentTime;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(220, t);
    o.frequency.linearRampToValueAtTime(180, t + 0.38);
    const effectiveVol = 0.08 * (settings.volume || 0.75);
    g.gain.setValueAtTime(effectiveVol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o.connect(g);
    g.connect(c.destination);
    o.start(t);
    o.stop(t + 0.42);
  } catch (e) {}
}

/** Triumphant major arpeggio fanfare for game victory. */
export function victoryFanfare() {
  if (settings.haptics) buzz([40, 30, 40, 30, 100]);
  if (!settings.sound || !settings.fanfare) return;
  try {
    const c = ctx();
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6
    notes.forEach((freq, idx) => {
      const t = c.currentTime + idx * 0.11;
      const dur = idx === notes.length - 1 ? 0.7 : 0.22;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(freq, t);
      const effectiveVol = 0.09 * (settings.volume || 0.75);
      g.gain.setValueAtTime(effectiveVol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g);
      g.connect(c.destination);
      o.start(t);
      o.stop(t + dur);
    });
  } catch (e) {}
}

/* -------------------------------------------------------------- haptics -- */

export function buzz(pattern) {
  if (!settings.haptics) return;
  if (typeof navigator === 'undefined' || !navigator.vibrate) return;
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
