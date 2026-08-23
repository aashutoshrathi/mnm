# Marker & Mayhem

A Pictionary host that runs in a browser tab. It deals the prompts, runs the
clock, keeps the tally, and — the part that makes it different — keeps a phone
per team showing the same word at the same time **with no network between them**.

No build step required, no dependencies, no accounts, no backend. One HTML file
and a folder of ES modules.

```
npm test          # 45 unit tests
npm run test:dom  # 16 integration tests in jsdom
npm run build     # bundle to dist/index.html
```

---

## The rule that shapes everything

Both teams draw the **same word at the same time**, for the same 90 seconds.
First team to shout it takes the points.

That one change does a lot of work. Nobody sits idle waiting their turn, the two
drawings are directly comparable, and the room stays loud for the whole round.
It also means the app's only hard job is getting the same word onto every phone
at the same moment — which is the whole design problem below.

## Run it

Any static host works, because it's all static.

```bash
python3 -m http.server 8080     # then open http://localhost:8080
```

Or push the repo to GitHub Pages and open the URL. Or run `npm run build` and
open `dist/index.html` straight off the filesystem — a single self-contained
file with the CSS and JS inlined, useful for AirDropping to someone.

> Serve it over `http(s)` rather than `file://` if you want multi-device play.
> The invite QR encodes a URL, and a `file://` path is not one.

## How a round goes

1. **Handoff** — whose turn it is to pick, plus the running tally in chalk marks.
2. **Theme** — the picking team gets four random themes and "Anything goes".
   The theme is announced out loud; the word is not.
3. **Cards** — three prompts at 1, 2 and 3 points. Harder word, more points.
   Reshuffle if all three are duds.
4. **Draw** — 90 seconds, ticking faster over the last 20. Hold the button to
   re-read the word. A panic button blanks the screen if someone walks past.
5. **Result** — who got it, what it was, updated tally.

Games end on a round cap, a score target, or "wrap up" from any screen.

## Multi-device play

Pick **Phone per team** at setup. The host phone shows a QR and an eight-character
code; every other drawer joins and gets their own screen.

**Nothing is transmitted after the join.** Both phones hold the same 24-bit seed,
and round *N* is a pure function of `(seed, difficulty, N)`. Two devices computing
the same function on the same inputs get the same word, forever, with the radios
off.

### Joining

| Route | How | Needs |
|---|---|---|
| Camera app | Point the phone's built-in camera at the QR | Nothing — it's a URL, so the OS opens the game already joined |
| In-app scan | "Scan the code instead" on the join screen | `BarcodeDetector` (Chromium) |
| Typed code | Eight characters, e.g. `1GN5 6NDK` | Nothing. Works everywhere, always |

The typed code is the reason there's no QR *decoder* in this repo. Reading eight
characters across a room takes about as long as lining up a camera, so scanning
is the fast path rather than the only one.

### What synced mode changes

Rounds **deal themselves** — no theme or card picking. That isn't a limitation
worked around, it's the point: the picking team's choice is the only state that
would need a live channel, and removing it removes the need for one. For all-play
it's arguably fairer anyway, since neither team gets to set the stakes.

Scoring stays on the host phone. The humans in the room already know who shouted
first; a second tally would just be a second thing to disagree with.

### Drift, and why it's visible instead of hidden

If someone double-taps "next round", their phone is a round ahead and shows a
different word. With no channel there is no way to detect that automatically —
so the app makes it obvious instead of pretending otherwise.

Every device shows a four-character **sync code** derived from `(seed, round)`.
Matching codes mean matching words. If they differ, `- round` / `+ round` on the
guest screen fixes it in about three seconds.

### The join code

Forty bits, rendered as eight Crockford base32 characters:

```
   24 bits  seed
    8 bits  difficulty, round length, round cap, score target (2 bits each)
    8 bits  CRC-8
```

The CRC is not decoration. Without it, one mistyped character yields a
valid-looking code that silently starts a *different* game, and the two phones
only find out mid-round. CRC-8 detects every burst error shorter than eight bits,
and a wrong base32 character is a burst of at most five — so every
single-character typo is caught, not merely most of them. There's a test that
walks all 248 of them.

Crockford's alphabet drops `I`, `L`, `O` and `U`, and the decoder folds the
lookalikes back, so `I` reads as `1` and `O` as `0` when a code is read aloud badly.

### Transports considered and rejected

- **Web Bluetooth** — central-only in browsers. A page can talk to a peripheral,
  but two phones are both centrals, so phone-to-phone is impossible by design.
- **Wi-Fi Direct / Aware** — no web API at all.
- **WebRTC** — needs a signalling server and a shared network. The premise here
  is that there isn't one.
- **Ultrasonic data** — genuinely works, but it's a lot of DSP to move 40 bits
  that a QR moves instantly and a human can read aloud.

The seed approach beats all of them by needing no ongoing channel whatsoever.

## Layout

```
index.html              markup only
build.mjs               flattens src/ into a single-file dist/index.html
sw.js                   service worker - offline shell
manifest.webmanifest    installable to a home screen
src/
  game.js               state machine, screens, wiring (solo | host | guest)
  words.js              prompt bank, themes, mashup generator
  sync.js               deterministic round derivation, sync codes
  joincode.js           40-bit payload codec, CRC-8, invite URLs
  qr.js                 QR encoder, from scratch (see below)
  scan.js               BarcodeDetector camera scanner, degrades gracefully
  rng.js                mulberry32 + isolated generator instances
  tally.js              chalk tally marks, one geometry for SVG and canvas
  feedback.js           blips, ticks, haptics
  share.js              1080x1350 result card
  storage.js            save adapter with in-memory fallback
  storage-web.js        localStorage/sessionStorage adapters
  styles.css
test/
  run.mjs               45 unit tests, zero dependencies
  dom.mjs               16 integration tests in jsdom
```

## The QR encoder

Written out rather than imported, because the whole promise is that this works
with no network, and a CDN `<script>` tag would make that a lie.

It implements ISO/IEC 18004 for byte mode, versions 1-10, EC levels L and M:
Reed-Solomon over GF(256), block interleaving, the zigzag data walk, all eight
mask patterns scored by the four standard penalty rules, and BCH-protected
format and version blocks.

It's verified two ways. The unit tests assert on each stage independently -
generator polynomials, RS vectors, the published format and version bit tables,
block structure, finder and timing patterns. Separately, during development every
version/EC combination was filled to exact capacity, rendered, and decoded with
OpenCV's `QRCodeDetector`: **20/20 round-trip**.

Three bugs that survived a careful reading and were only caught by decoding:

- The finder-pattern ring test ran before the bounds test, so `r === 0` painted
  the separator column dark along with the top row.
- Format bits were written LSB-first; the spec places bit 14 adjacent to the
  top-left finder and walks outward.
- Copy 2 of the format block had an off-by-one in the 7/8 column-row split.

Worth knowing if you ever compare against `segno`: `boost_error` defaults to
`True`, so asking for level M can silently hand you an H symbol. That cost a
while.

## The prompt bank

1,045 curated prompts across 11 themes in three difficulty tiers, plus a
combinatorial generator (50 adjectives x 119 nouns x 35 actions) that pushes the
total pool past **219,000** distinct prompts.

Ten thousand hand-written words was the original ask and it was the wrong ask -
past a couple of thousand you're padding the list with things nobody can draw.
Curated entries carry the quality; the generator carries the volume and produces
the genuinely funny ones ("smug helicopter juggling").

Nothing repeats within a game. In solo mode that's a used-set; in synced mode the
used-set is itself derived by replaying rounds 1..N, so a phone that joins at
round 7 has the same history as one that played through. Verified over a
300-round game.

## Persistence

The default build stores saves through a host-provided `window.storage` where
available, then `localStorage`, then `sessionStorage`, falling back to memory.
Sandboxed iframes can throw on storage access, so each one is probed before use.

Self-hosting? The chain above is already wired in `game.js`; to drop the
host adapter, change one line:

```js
const store = createStore([webAdapter, sessionAdapter, ADAPTERS.memory]);
```

## Browser notes

- **Haptics** - `navigator.vibrate` doesn't exist in Safari. The Buzz toggle
  hides itself rather than pretending.
- **In-app QR scanning** - `BarcodeDetector` is Chromium-only. The camera-app
  and typed-code routes cover everyone else.
- **Audio** - starts on first tap, as every mobile browser requires.
- **Offline** - the service worker precaches the shell, so a guest can load the
  app and join with the network down. Only active over `http(s)`.

## Licence

MIT. See `LICENSE`.
