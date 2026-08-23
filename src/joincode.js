/**
 * joincode.js — the thing that crosses the air gap.
 *
 * Everything a second phone needs to compute the same rounds as the host packs
 * into 40 bits: a 24-bit seed, 8 bits of settings, and an 8-bit checksum. That
 * renders as 8 Crockford base32 characters — "K7M3QP2X" — short enough to read
 * aloud across a room and short enough to keep the QR at a low version.
 *
 * The checksum is not decoration. Without it a mistyped character produces a
 * valid-looking code that silently generates a *different* game, and the two
 * phones only discover it mid-round. Better to reject the typo up front.
 */

/** Crockford base32: no I, L, O or U, so 1/l, 0/O and U/V can't be confused. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Normalising map for the characters people actually type. */
const CANON = { I: '1', L: '1', O: '0', U: 'V' };

export const JOIN_CODE_LENGTH = 8;

/**
 * Settings that must match for two devices to derive identical rounds.
 * Order is part of the wire format — append only, never reorder.
 */
const DIFFICULTIES = ['easy', 'medium', 'hard', 'mixed'];
const LENGTHS = [60, 90, 120, 180];
const ROUND_CAPS = [5, 10, 15, 0];
const TARGETS = [10, 15, 20, 0];

const indexOrThrow = (list, value, label) => {
  const i = list.indexOf(value);
  if (i < 0) throw new RangeError(`Cannot encode ${label}: ${value}`);
  return i;
};

/**
 * CRC-8 (polynomial 0x07, zero init). Chosen over an ad-hoc sum because a CRC
 * detects every burst error shorter than its width, and a mistyped base32
 * character is a burst of at most five bits. That turns "probably catches
 * typos" into "catches all of them".
 *
 * Appending the remainder makes the whole message divisible, so verification is
 * simply crc8(payload + checksum) === 0.
 */
function crc8(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function toBase32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of text) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new SyntaxError(`Unexpected character: ${ch}`);
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return out;
}

/**
 * @typedef {Object} JoinPayload
 * @property {number} seed 24-bit game seed
 * @property {'easy'|'medium'|'hard'|'mixed'} diff
 * @property {number} len seconds per round
 * @property {number} rounds round cap, 0 for none
 * @property {number} target early-finish score, 0 for none
 */

/** A fresh 24-bit seed. */
export function newSeed() {
  return Math.floor(Math.random() * 0x1000000);
}

/**
 * @param {JoinPayload} payload
 * @returns {string} 8 base32 characters
 */
export function encodeJoinCode({ seed, diff, len, rounds, target }) {
  const s = seed >>> 0;
  if (s > 0xffffff) throw new RangeError('Seed must fit in 24 bits');

  const flags =
    (indexOrThrow(DIFFICULTIES, diff, 'difficulty') << 6) |
    (indexOrThrow(LENGTHS, len, 'round length') << 4) |
    (indexOrThrow(ROUND_CAPS, rounds, 'round cap') << 2) |
    indexOrThrow(TARGETS, target, 'score target');

  const bytes = [(s >> 16) & 0xff, (s >> 8) & 0xff, s & 0xff, flags];
  bytes.push(crc8(bytes));
  return toBase32(bytes);
}

/**
 * Parse a code typed by a human: case-insensitive, ignores spaces and dashes,
 * and forgives the character confusions Crockford base32 is designed around.
 *
 * @param {string} input
 * @returns {JoinPayload}
 * @throws {SyntaxError} malformed input
 * @throws {RangeError} checksum mismatch
 */
export function decodeJoinCode(input) {
  const cleaned = String(input || '')
    .toUpperCase()
    .replace(/[\s\-_]/g, '')
    .replace(/[ILOU]/g, (c) => CANON[c]);

  if (cleaned.length !== JOIN_CODE_LENGTH) {
    throw new SyntaxError(`A join code is ${JOIN_CODE_LENGTH} characters; got ${cleaned.length}`);
  }

  const bytes = fromBase32(cleaned);
  if (crc8(bytes) !== 0) {
    throw new RangeError("That code doesn't check out — one character is probably off");
  }

  const body = bytes.slice(0, 4);
  const flags = body[3];
  return {
    seed: (body[0] << 16) | (body[1] << 8) | body[2],
    diff: DIFFICULTIES[(flags >> 6) & 3],
    len: LENGTHS[(flags >> 4) & 3],
    rounds: ROUND_CAPS[(flags >> 2) & 3],
    target: TARGETS[flags & 3],
  };
}

/** "K7M3QP2X" -> "K7M3 QP2X", for reading aloud. */
export const formatJoinCode = (code) => `${code.slice(0, 4)} ${code.slice(4)}`;

/**
 * The URL a guest's camera app will open. Built from the page's own location so
 * it works on any host, including a LAN address or a file path.
 * @param {string} code
 * @param {Location|URL} [location]
 */
export function joinUrl(code, location = window.location) {
  const base = `${location.origin}${location.pathname}`;
  return `${base}#join=${code}`;
}

/**
 * Pull a join code out of a URL fragment, if present.
 * @param {string} hash e.g. "#join=K7M3QP2X"
 * @returns {string|null}
 */
export function codeFromHash(hash) {
  const match = /[#&]join=([0-9A-Za-z\-_]+)/.exec(hash || '');
  return match ? match[1] : null;
}
