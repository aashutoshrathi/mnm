/**
 * test/run.mjs — no framework, no dependencies.
 *
 *   node test/run.mjs
 *
 * Covers the parts where a silent bug is expensive: the join codec (a bad
 * decode starts a divergent game), round determinism (the whole premise of
 * multi-device play), and the QR encoder (written here rather than imported).
 */

import { strict as assert } from 'node:assert';
import {
  JOIN_CODE_LENGTH,
  newSeed,
  encodeJoinCode,
  decodeJoinCode,
  formatJoinCode,
  joinUrl,
  codeFromHash,
} from '../src/joincode.js';
import { roundFor, roundsThrough, syncCode, resetReplay } from '../src/sync.js';
import { encodeQR, qrToSVG, __internals } from '../src/qr.js';
import { poolSize, THEMES, ALL_THEMES, mashupWord } from '../src/words.js';
import { createRng, hashSeed } from '../src/rng.js';
import { tallyGroups, tallyWidth } from '../src/tally.js';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message.split('\n')[0]}`);
  }
}

function group(name) {
  console.log(`\n${name}`);
}

/* ============================================================ join codec */

group('join code');

test('round-trips every settings combination', () => {
  const diffs = ['easy', 'medium', 'hard', 'mixed'];
  const lens = [60, 90, 120, 180];
  const caps = [5, 10, 15, 0];
  const targets = [10, 15, 20, 0];
  let n = 0;
  for (const diff of diffs)
    for (const len of lens)
      for (const rounds of caps)
        for (const target of targets) {
          const payload = { seed: 0xa1b2c3, diff, len, rounds, target };
          assert.deepEqual(decodeJoinCode(encodeJoinCode(payload)), payload);
          n++;
        }
  assert.equal(n, 256);
});

test('round-trips seeds across the full 24-bit range', () => {
  for (const seed of [0, 1, 0xffffff, 0x7fffff, 123456, 0xa5a5a5]) {
    const code = encodeJoinCode({ seed, diff: 'medium', len: 90, rounds: 10, target: 15 });
    assert.equal(decodeJoinCode(code).seed, seed);
  }
});

test('produces a code of exactly the advertised length', () => {
  const code = encodeJoinCode({ seed: 999, diff: 'hard', len: 60, rounds: 5, target: 0 });
  assert.equal(code.length, JOIN_CODE_LENGTH);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]+$/);
});

test('is case- and separator-insensitive', () => {
  const code = encodeJoinCode({ seed: 0x0f0f0f, diff: 'easy', len: 120, rounds: 15, target: 20 });
  const expected = decodeJoinCode(code);
  for (const variant of [code.toLowerCase(), formatJoinCode(code), `${code.slice(0, 4)}-${code.slice(4)}`, ` ${code} `]) {
    assert.deepEqual(decodeJoinCode(variant), expected);
  }
});

test('forgives the ambiguous characters Crockford base32 excludes', () => {
  // A code containing 1, 0 and V should also accept I/L, O and U in their place.
  const code = encodeJoinCode({ seed: 0x10ff01, diff: 'medium', len: 90, rounds: 10, target: 15 });
  const swapped = code.replace(/1/g, 'I').replace(/0/g, 'O');
  assert.deepEqual(decodeJoinCode(swapped), decodeJoinCode(code));
});

test('rejects every single-character corruption', () => {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const code = encodeJoinCode({ seed: 0x2b7f10, diff: 'medium', len: 90, rounds: 10, target: 15 });
  let caught = 0;
  let tried = 0;
  for (let i = 0; i < code.length; i++) {
    for (const ch of alphabet) {
      if (ch === code[i]) continue;
      tried++;
      const bad = code.slice(0, i) + ch + code.slice(i + 1);
      try {
        decodeJoinCode(bad);
      } catch (e) {
        caught++;
      }
    }
  }
  // A CRC-8 detects any burst shorter than 8 bits, and a base32 character is
  // 5 bits, so this must be exhaustive rather than merely likely.
  assert.equal(caught, tried, `${tried - caught} of ${tried} typos slipped through`);
});

test('rejects wrong-length and malformed input', () => {
  assert.throws(() => decodeJoinCode(''), SyntaxError);
  assert.throws(() => decodeJoinCode('ABC'), SyntaxError);
  assert.throws(() => decodeJoinCode('ABCDEFGHIJKL'), SyntaxError);
  assert.throws(() => decodeJoinCode('!!!!!!!!'), SyntaxError);
  assert.throws(() => decodeJoinCode(null), SyntaxError);
});

test('refuses to encode out-of-range values', () => {
  assert.throws(() => encodeJoinCode({ seed: 0x1000000, diff: 'medium', len: 90, rounds: 10, target: 15 }), RangeError);
  assert.throws(() => encodeJoinCode({ seed: 1, diff: 'brutal', len: 90, rounds: 10, target: 15 }), RangeError);
  assert.throws(() => encodeJoinCode({ seed: 1, diff: 'medium', len: 45, rounds: 10, target: 15 }), RangeError);
});

test('extracts a code from an invite URL fragment', () => {
  assert.equal(codeFromHash('#join=K7M3QP2X'), 'K7M3QP2X');
  assert.equal(codeFromHash('#a=1&join=ABCD1234'), 'ABCD1234');
  assert.equal(codeFromHash('#nothing'), null);
  assert.equal(codeFromHash(''), null);
});

/* ======================================================= round determinism */

group('synced rounds');

test('two devices derive identical rounds from one seed', () => {
  const seed = 0x3f2a1b;
  resetReplay();
  const deviceA = Array.from({ length: 25 }, (_, i) => roundFor(seed, 'medium', i + 1));
  resetReplay();
  const deviceB = Array.from({ length: 25 }, (_, i) => roundFor(seed, 'medium', i + 1));
  assert.deepEqual(
    deviceA.map((r) => [r.word, r.pts, r.theme.id]),
    deviceB.map((r) => [r.word, r.pts, r.theme.id])
  );
});

test('a device joining late computes the same round as one that played through', () => {
  const seed = 0x991122;
  resetReplay();
  for (let i = 1; i <= 12; i++) roundFor(seed, 'hard', i);
  const playedThrough = roundFor(seed, 'hard', 12);

  resetReplay();
  const joinedLate = roundFor(seed, 'hard', 12); // first call is round 12
  assert.equal(joinedLate.word, playedThrough.word);
  assert.equal(joinedLate.pts, playedThrough.pts);
  assert.equal(joinedLate.theme.id, playedThrough.theme.id);
});

test('different seeds diverge', () => {
  resetReplay();
  const a = roundsThrough(0x111111, 'medium', 10).map((r) => r.word);
  const b = roundsThrough(0x222222, 'medium', 10).map((r) => r.word);
  assert.notDeepEqual(a, b);
});

test('difficulty changes the sequence', () => {
  resetReplay();
  const easy = roundsThrough(0x424242, 'easy', 10).map((r) => r.word);
  const hard = roundsThrough(0x424242, 'hard', 10).map((r) => r.word);
  assert.notDeepEqual(easy, hard);
});

test('never repeats a word within a game', () => {
  resetReplay();
  const words = roundsThrough(0x5150aa, 'medium', 300).map((r) => r.word);
  assert.equal(new Set(words).size, words.length, 'duplicate prompt in a 300-round game');
});

test('stakes stay in range and vary', () => {
  resetReplay();
  const pts = roundsThrough(0x777777, 'medium', 100).map((r) => r.pts);
  assert.ok(pts.every((p) => p >= 1 && p <= 3));
  assert.ok(new Set(pts).size === 3, 'all three stake values should appear over 100 rounds');
});

test('rejects a non-positive round number', () => {
  assert.throws(() => roundFor(1, 'medium', 0), RangeError);
  assert.throws(() => roundFor(1, 'medium', -3), RangeError);
  assert.throws(() => roundFor(1, 'medium', 1.5), RangeError);
});

test('sync codes agree across devices and differ across rounds', () => {
  const seed = 0xabc123;
  assert.equal(syncCode(seed, 7), syncCode(seed, 7));
  assert.notEqual(syncCode(seed, 7), syncCode(seed, 8));
  assert.notEqual(syncCode(seed, 7), syncCode(seed + 1, 7));
  for (let n = 1; n <= 50; n++) assert.match(syncCode(seed, n), /^[0-9A-HJKMNP-TV-Z]{4}$/);
});

test('sync codes rarely collide between adjacent rounds', () => {
  let collisions = 0;
  for (let seed = 0; seed < 400; seed++) {
    for (let n = 1; n <= 20; n++) if (syncCode(seed, n) === syncCode(seed, n + 1)) collisions++;
  }
  assert.ok(collisions === 0, `${collisions} adjacent-round collisions`);
});

/* ================================================================ rng */

group('rng');

test('isolated generators do not interfere', () => {
  const a = createRng(42);
  const b = createRng(42);
  a.next();
  a.next();
  assert.equal(createRng(42).next(), b.next(), 'a fresh generator should be unaffected by another');
});

test('hashSeed is stable and spreads', () => {
  assert.equal(hashSeed('abc'), hashSeed('abc'));
  const seen = new Set(Array.from({ length: 500 }, (_, i) => hashSeed('mm:' + i)));
  assert.ok(seen.size > 495, `only ${seen.size}/500 distinct hashes`);
});

test('shuffle preserves membership', () => {
  const rng = createRng(7);
  const input = Array.from({ length: 50 }, (_, i) => i);
  const out = rng.shuffle(input);
  assert.equal(out.length, input.length);
  assert.deepEqual(out.slice().sort((x, y) => x - y), input);
  assert.notDeepEqual(out, input);
});

/* ================================================================ words */

group('prompt bank');

test('pool is as advertised', () => {
  const p = poolSize();
  assert.ok(p.curated > 1000, `only ${p.curated} curated prompts`);
  assert.ok(p.total > 200000, `only ${p.total} total prompts`);
});

test('no theme has duplicates within itself', () => {
  for (const t of THEMES) {
    const all = Object.values(t.words).flat();
    assert.equal(new Set(all).size, all.length, `duplicate inside theme "${t.id}"`);
  }
});

test('every theme has all three tiers populated', () => {
  for (const t of THEMES) {
    for (const tier of [1, 2, 3]) {
      assert.ok(Array.isArray(t.words[tier]) && t.words[tier].length >= 25, `theme ${t.id} tier ${tier} is thin`);
    }
  }
});

test('no prompt has stray whitespace or empty entries', () => {
  for (const t of THEMES) {
    for (const w of Object.values(t.words).flat()) {
      assert.ok(w.length > 0, `empty prompt in ${t.id}`);
      assert.equal(w, w.trim(), `padded prompt "${w}" in ${t.id}`);
    }
  }
});

test('mashups accept an injected generator', () => {
  const a = mashupWord(2, createRng(9));
  const b = mashupWord(2, createRng(9));
  assert.equal(a, b);
  assert.ok(a.split(' ').length >= 2);
});

test('the Mashups theme is in the rotation', () => {
  assert.equal(ALL_THEMES.length, THEMES.length + 1);
  assert.ok(ALL_THEMES.some((t) => t.gen));
});

/* ================================================================ tally */

group('tally marks');

test('stroke count always equals the score', () => {
  for (let n = 0; n <= 40; n++) {
    const strokes = tallyGroups(n).reduce((sum, g) => sum + g.length, 0);
    assert.equal(strokes, n);
  }
});

test('every fifth stroke is the diagonal', () => {
  for (const n of [5, 10, 15, 23]) {
    const diagonals = tallyGroups(n)
      .flat()
      .filter((s) => s.kind === 'curve').length;
    assert.equal(diagonals, Math.floor(n / 5));
  }
});

test('width grows with groups', () => {
  assert.equal(tallyWidth(0), 0);
  assert.ok(tallyWidth(6) > tallyWidth(5));
  assert.ok(tallyWidth(5) === tallyWidth(4));
});

/* =================================================================== qr */

group('qr encoder');

test('generator polynomial has the expected degree', () => {
  for (const d of [7, 10, 15, 26]) {
    assert.equal(__internals.generatorPoly(d).length, d + 1);
  }
});

test('reed-solomon matches a known vector', () => {
  // "HELLO" as version 1-M data codewords
  const data = [0x40, 0x54, 0x84, 0x54, 0xc4, 0xc4, 0xf0, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec];
  const ec = __internals.reedSolomon(data, 10);
  assert.deepEqual(ec, [0x23, 0x73, 0x23, 0x99, 0xec, 0x08, 0xc9, 0xf7, 0x37, 0xdf]);
});

test('format bits match the published table', () => {
  const M = [
    0b101010000010010, 0b101000100100101, 0b101111001111100, 0b101101101001011,
    0b100010111111001, 0b100000011001110, 0b100111110010111, 0b100101010100000,
  ];
  M.forEach((expected, mask) => assert.equal(__internals.formatBits('M', mask), expected));
});

test('version bits match the published table', () => {
  assert.equal(__internals.versionBits(7), 0b000111110010010100);
  assert.equal(__internals.versionBits(10), 0b001010010011010011);
});

test('data codewords are padded to exact capacity', () => {
  for (const level of ['L', 'M']) {
    for (let v = 1; v <= 10; v++) {
      const out = __internals.encodeData([0x41, 0x42, 0x43], v, level);
      assert.equal(out.length, __internals.dataCapacity(v, level));
    }
  }
});

test('block structure sums to the declared data capacity', () => {
  for (const level of ['L', 'M']) {
    __internals.SPECS[level].forEach((spec, i) => {
      const [ec, g1, d1, g2, d2] = spec;
      const stream = __internals.buildCodewords(
        __internals.encodeData([0x41], i + 1, level),
        i + 1,
        level
      );
      assert.equal(stream.length, g1 * d1 + g2 * d2 + (g1 + g2) * ec, `version ${i + 1}-${level}`);
    });
  }
});

test('picks the smallest version that fits', () => {
  assert.equal(encodeQR('A'.repeat(14), { level: 'M' }).version, 1);
  assert.equal(encodeQR('A'.repeat(15), { level: 'M' }).version, 2);
  assert.equal(encodeQR('A'.repeat(26), { level: 'M' }).version, 2);
  assert.equal(encodeQR('A'.repeat(27), { level: 'M' }).version, 3);
});

test('matrix size follows the version', () => {
  for (let v = 1; v <= 10; v++) {
    const qr = encodeQR('A'.repeat(__internals.dataCapacity(v, 'M') - 3), { level: 'M' });
    assert.equal(qr.size, 17 + qr.version * 4);
    assert.equal(qr.modules.length, qr.size);
    qr.modules.forEach((row) => assert.equal(row.length, qr.size));
  }
});

test('every module is strictly 0 or 1', () => {
  const qr = encodeQR('https://example.com/#join=K7M3QP2X', { level: 'M' });
  for (const row of qr.modules) {
    for (const v of row) assert.ok(v === 0 || v === 1, `stray module value ${v}`);
  }
});

test('finder patterns and their separators are correct', () => {
  const qr = encodeQR('K7M3QP2X', { level: 'M' });
  const m = qr.modules;
  const n = qr.size;
  for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        assert.equal(m[r0 + r][c0 + c], ring || core ? 1 : 0, `finder at ${r0},${c0} module ${r},${c}`);
      }
    }
  }
  // separators are light
  for (let i = 0; i < 8; i++) {
    assert.equal(m[7][i], 0);
    assert.equal(m[i][7], 0);
  }
});

test('timing patterns alternate', () => {
  const qr = encodeQR('K7M3QP2X', { level: 'M' });
  for (let i = 8; i < qr.size - 8; i++) {
    assert.equal(qr.modules[6][i], i % 2 === 0 ? 1 : 0);
    assert.equal(qr.modules[i][6], i % 2 === 0 ? 1 : 0);
  }
});

test('the fixed dark module is set', () => {
  for (let v = 1; v <= 10; v++) {
    const qr = encodeQR('A'.repeat(__internals.dataCapacity(v, 'M') - 3), { level: 'M' });
    assert.equal(qr.modules[qr.size - 8][8], 1, `version ${qr.version}`);
  }
});

test('rejects a payload larger than version 10', () => {
  assert.throws(() => encodeQR('A'.repeat(400), { level: 'M' }), RangeError);
  assert.throws(() => encodeQR('A', { level: 'Q' }), RangeError);
});

test('encodes multi-byte characters as UTF-8', () => {
  const qr = encodeQR('café ☕', { level: 'M' });
  assert.ok(qr.size >= 21);
});

test('SVG output is well-formed and sized correctly', () => {
  const qr = encodeQR('K7M3QP2X', { level: 'M' });
  const svg = qrToSVG(qr, { scale: 4, quiet: 2 });
  const expected = (qr.size + 4) * 4;
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.trimEnd().endsWith('</svg>'));
  assert.ok(svg.includes(`viewBox="0 0 ${expected} ${expected}"`));
  assert.equal((svg.match(/<path/g) || []).length, 1);
});

/* ================================================================ report */

console.log(`\n${'─'.repeat(52)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('');
  failures.forEach(({ name, err }) => {
    console.log(`✗ ${name}`);
    console.log(`  ${err.message}`);
  });
  process.exit(1);
}
