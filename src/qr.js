/**
 * qr.js - a QR encoder, byte mode, versions 1-10, EC levels L and M.
 *
 * Written out rather than pulled in because the whole point of the offline
 * mode is that it works with no network, and a CDN script tag would be a lie.
 * Ten versions is far more than the join URL needs (version 4-M carries 62
 * bytes) and leaves headroom for a long GitHub Pages path.
 *
 * Implements ISO/IEC 18004: RS error correction over GF(256), block
 * interleaving, the zigzag data walk, all eight mask patterns scored by the
 * four standard penalty rules, and BCH-protected format and version info.
 */

/* ------------------------------------------------------------ GF(256) maths */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // primitive polynomial for QR
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator polynomial of the given degree. */
function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Remainder of data * x^degree divided by the generator polynomial. */
function reedSolomon(data, degree) {
  const gen = generatorPoly(degree);
  const remainder = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < degree; i++) remainder[i] ^= gfMul(gen[i + 1], factor);
  }
  return remainder;
}

/* ------------------------------------------------------------ version specs */

/**
 * Per version, per EC level: [ecCodewordsPerBlock, group1Blocks,
 * group1DataCodewords, group2Blocks, group2DataCodewords].
 * Values from ISO/IEC 18004 table 9.
 */
const SPECS = {
  L: [
    [7, 1, 19, 0, 0],
    [10, 1, 34, 0, 0],
    [15, 1, 55, 0, 0],
    [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0],
    [18, 2, 68, 0, 0],
    [20, 2, 78, 0, 0],
    [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0],
    [18, 2, 68, 2, 69],
  ],
  M: [
    [10, 1, 16, 0, 0],
    [16, 1, 28, 0, 0],
    [26, 1, 44, 0, 0],
    [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0],
    [18, 4, 31, 0, 0],
    [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37],
    [26, 4, 43, 1, 44],
  ],
};

/** Alignment pattern centre coordinates, indexed by version - 1. */
const ALIGNMENT = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** Unused bits appended after the final codeword, indexed by version - 1. */
const REMAINDER_BITS = [0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

const EC_INDICATOR = { L: 0b01, M: 0b00 };

const MAX_VERSION = 10;

const dataCapacity = (version, level) => {
  const [, g1, d1, g2, d2] = SPECS[level][version - 1];
  return g1 * d1 + g2 * d2;
};

/* --------------------------------------------------------------- bit buffer */

class BitBuffer {
  constructor() {
    this.bits = [];
  }
  put(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() {
    return this.bits.length;
  }
  toBytes() {
    const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, i) => {
      if (bit) bytes[i >> 3] |= 0x80 >> (i & 7);
    });
    return bytes;
  }
}

/* ------------------------------------------------------------- data encoding */

function encodeData(bytes, version, level) {
  const capacity = dataCapacity(version, level);
  const countBits = version < 10 ? 8 : 16;

  const buf = new BitBuffer();
  buf.put(0b0100, 4); // byte mode
  buf.put(bytes.length, countBits);
  for (const b of bytes) buf.put(b, 8);

  const capacityBits = capacity * 8;
  buf.put(0, Math.min(4, capacityBits - buf.length)); // terminator
  while (buf.length % 8 !== 0) buf.put(0, 1);

  const out = Array.from(buf.toBytes());
  const PAD = [0xec, 0x11];
  for (let i = 0; out.length < capacity; i++) out.push(PAD[i % 2]);
  return out;
}

/** Split into RS blocks, compute EC, then interleave both halves. */
function buildCodewords(data, version, level) {
  const [ecPerBlock, g1, d1, g2, d2] = SPECS[level][version - 1];

  const blocks = [];
  let offset = 0;
  for (let i = 0; i < g1; i++, offset += d1) blocks.push(data.slice(offset, offset + d1));
  for (let i = 0; i < g2; i++, offset += d2) blocks.push(data.slice(offset, offset + d2));

  const ecBlocks = blocks.map((b) => reedSolomon(b, ecPerBlock));

  const out = [];
  const longest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return out;
}

/* ------------------------------------------------------- matrix construction */

const FREE = -1;

function blankMatrix(size) {
  return Array.from({ length: size }, () => new Int8Array(size).fill(FREE));
}

/**
 * A finder pattern plus its separator. The 7x7 box carries the concentric
 * squares; anything outside it in the 9x9 footprint is separator and must be
 * light, so the box test has to come before the ring test.
 */
function placeFinder(m, row, col) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const y = row + r;
      const x = col + c;
      if (y < 0 || y >= m.length || x < 0 || x >= m.length) continue;

      const insideBox = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      if (!insideBox) {
        m[y][x] = 0;
        continue;
      }
      const ring = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      m[y][x] = ring || core ? 1 : 0;
    }
  }
}

function placeAlignment(m, version) {
  const centres = ALIGNMENT[version - 1];
  const last = centres.length - 1;
  for (let i = 0; i <= last; i++) {
    for (let j = 0; j <= last; j++) {
      const skipCorner =
        (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
      if (skipCorner) continue;
      const cy = centres[i];
      const cx = centres[j];
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const ring = Math.max(Math.abs(r), Math.abs(c));
          m[cy + r][cx + c] = ring === 1 ? 0 : 1;
        }
      }
    }
  }
}

function placeFunctionPatterns(m, version) {
  const size = m.length;
  placeFinder(m, 0, 0);
  placeFinder(m, 0, size - 7);
  placeFinder(m, size - 7, 0);
  placeAlignment(m, version);

  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0;
    m[6][i] = bit;
    m[i][6] = bit;
  }

  m[size - 8][8] = 1; // the always-dark module

  // reserve format areas so the data walk skips them
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === FREE) m[8][i] = 0;
    if (m[i][8] === FREE) m[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === FREE) m[8][size - 1 - i] = 0;
    if (m[size - 1 - i][8] === FREE) m[size - 1 - i][8] = 0;
  }

  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        m[size - 11 + j][i] = 0;
        m[i][size - 11 + j] = 0;
      }
    }
  }
}

/** Upward/downward zigzag over two-module columns, skipping the timing column. */
function placeData(matrix, reserved, codewords) {
  const size = matrix.length;
  let bitIndex = 0;
  let upward = true;

  const nextBit = () => {
    const byte = codewords[bitIndex >> 3];
    const bit = byte === undefined ? 0 : (byte >>> (7 - (bitIndex & 7))) & 1;
    bitIndex++;
    return bit;
  };

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing pattern occupies column 6
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let c = 0; c < 2; c++) {
        const col = right - c;
        if (reserved[row][col]) continue;
        matrix[row][col] = nextBit();
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** The four penalty rules from the spec, summed. Lower is better. */
function penalty(m) {
  const size = m.length;
  let score = 0;

  const runScore = (run) => (run >= 5 ? 3 + (run - 5) : 0);

  for (let i = 0; i < size; i++) {
    let rowRun = 1;
    let colRun = 1;
    for (let j = 1; j < size; j++) {
      if (m[i][j] === m[i][j - 1]) rowRun++;
      else {
        score += runScore(rowRun);
        rowRun = 1;
      }
      if (m[j][i] === m[j - 1][i]) colRun++;
      else {
        score += runScore(colRun);
        colRun = 1;
      }
    }
    score += runScore(rowRun) + runScore(colRun);
  }

  for (let i = 0; i < size - 1; i++) {
    for (let j = 0; j < size - 1; j++) {
      const v = m[i][j];
      if (v === m[i][j + 1] && v === m[i + 1][j] && v === m[i + 1][j + 1]) score += 3;
    }
  }

  const FINDER = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const REVERSED = FINDER.slice().reverse();
  const matches = (get, start) =>
    FINDER.every((v, k) => get(start + k) === v) || REVERSED.every((v, k) => get(start + k) === v);

  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 11; j++) {
      if (matches((k) => m[i][k], j)) score += 40;
      if (matches((k) => m[k][i], j)) score += 40;
    }
  }

  let dark = 0;
  for (const row of m) for (const v of row) dark += v;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/** BCH(15,5) with the format-info generator, XOR-masked per spec. */
function formatBits(level, mask) {
  const data = (EC_INDICATOR[level] << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  return ((data << 10) | rem) ^ 0x5412;
}

/** BCH(18,6) with the version-info generator. */
function versionBits(version) {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12);
  return (version << 12) | rem;
}

/**
 * The fifteen format modules appear twice: split around the top-left finder,
 * and again along the bottom-left column and top-right row. Both copies are
 * written most-significant bit first, starting adjacent to the top-left finder
 * and walking away from it.
 */
function formatPositions(size) {
  const aroundTopLeft = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  const split = [
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8],
    [size - 5, 8], [size - 6, 8], [size - 7, 8],
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5],
    [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ];
  return [aroundTopLeft, split];
}

function writeFormat(m, level, mask) {
  const bits = formatBits(level, mask);
  for (const copy of formatPositions(m.length)) {
    copy.forEach(([r, c], i) => {
      m[r][c] = (bits >>> (14 - i)) & 1;
    });
  }
  m[m.length - 8][8] = 1; // fixed dark module, not part of either copy
}

function writeVersion(m, version) {
  if (version < 7) return;
  const size = m.length;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const bit = (bits >>> i) & 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    m[size - 11 + c][r] = bit;
    m[r][size - 11 + c] = bit;
  }
}

/* -------------------------------------------------------------------- public */

const toBytes = (text) =>
  typeof TextEncoder !== 'undefined'
    ? Array.from(new TextEncoder().encode(text))
    : Array.from(unescape(encodeURIComponent(text)), (c) => c.charCodeAt(0));

/**
 * Encode text as a QR matrix.
 * @param {string} text
 * @param {{level?: 'L'|'M', minVersion?: number}} [options]
 * @returns {{size:number, modules:Int8Array[], version:number, level:string, mask:number}}
 * @throws {RangeError} if the text exceeds version 10 capacity
 */
export function encodeQR(text, { level = 'M', minVersion = 1 } = {}) {
  if (!SPECS[level]) throw new RangeError(`Unsupported EC level: ${level}`);

  const bytes = toBytes(text);
  let version = 0;
  for (let v = Math.max(1, minVersion); v <= MAX_VERSION; v++) {
    const countBits = v < 10 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCapacity(v, level) * 8) {
      version = v;
      break;
    }
  }
  if (!version) {
    throw new RangeError(`${bytes.length} bytes exceeds version ${MAX_VERSION}-${level} capacity`);
  }

  const size = 17 + version * 4;
  const data = encodeData(bytes, version, level);
  const codewords = buildCodewords(data, version, level);

  const base = blankMatrix(size);
  placeFunctionPatterns(base, version);
  const reserved = base.map((row) => Array.from(row, (v) => v !== FREE));

  const withData = base.map((row) => Int8Array.from(row));
  const padded = codewords.concat(new Array(Math.ceil(REMAINDER_BITS[version - 1] / 8)).fill(0));
  placeData(withData, reserved, padded);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = withData.map((row) => Int8Array.from(row));
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!reserved[r][c] && MASKS[mask](r, c)) candidate[r][c] ^= 1;
      }
    }
    writeFormat(candidate, level, mask);
    writeVersion(candidate, version);

    const score = penalty(candidate);
    if (!best || score < best.score) best = { score, mask, modules: candidate };
  }

  return { size, modules: best.modules, version, level, mask: best.mask };
}

/**
 * Internals, exported for the test suite only.
 *
 * The encoder has four stages that can each be wrong in ways the final matrix
 * hides, so the tests assert on codewords and the reserved map directly rather
 * than only round-tripping the finished image.
 */
export const __internals = {
  encodeData,
  buildCodewords,
  reedSolomon,
  generatorPoly,
  formatBits,
  versionBits,
  dataCapacity,
  SPECS,
};

/**
 * Render a matrix as a standalone SVG string.
 * @param {ReturnType<encodeQR>} qr
 * @param {{scale?:number, quiet?:number, dark?:string, light?:string}} [options]
 */
export function qrToSVG(qr, { scale = 8, quiet = 4, dark = '#12142A', light = '#F7F4EC' } = {}) {
  const total = (qr.size + quiet * 2) * scale;
  let path = '';
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.modules[r][c]) {
        path += `M${(c + quiet) * scale} ${(r + quiet) * scale}h${scale}v${scale}h-${scale}z`;
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
    `width="${total}" height="${total}" shape-rendering="crispEdges" role="img" ` +
    `aria-label="QR code to join the game">` +
    `<rect width="${total}" height="${total}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/></svg>`
  );
}
