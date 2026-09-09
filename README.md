# Marker & Mayhem

A Pictionary host that runs in a browser tab. It deals the prompts, runs the
clock, keeps the tally, and, the part that makes it different, keeps a phone
per team showing the same word at the same time **with no network between them**.

No build step required, no dependencies at runtime, no accounts, no backend.
One HTML file and a folder of ES modules.

```
npm test          # 49 unit tests (zero dev dependencies)
npm run test:dom  # 24 integration tests in jsdom
npm run test:esm  # the app as the browser really loads it: index.html + src/
npm run test:meta # link-preview tags vs. the images they promise
npm run test:all  # everything above, plus the multi-device e2e suites
npm run build     # bundle everything into dist/index.html
npm run og        # regenerate og.png and apple-touch-icon.png
npm start         # build + serve on http://localhost:8080
```

---

## Contents

- [The rule that shapes everything](#the-rule-that-shapes-everything)
- [Run it](#run-it)
- [How a round goes](#how-a-round-goes)
- [Drawing on the phone itself](#drawing-on-the-phone-itself)
- [Multi-device play](#multi-device-play)
- [Persistence](#persistence)
- [Layout](#layout)
- [Two builds, one invariant](#two-builds-one-invariant)
- [Link previews](#link-previews)
- [The QR encoder](#the-qr-encoder)
- [The prompt bank](#the-prompt-bank)
- [Browser notes](#browser-notes)
- [Licence](#licence)

## The rule that shapes everything

Both teams draw the **same word at the same time**, for the same 90 seconds.
First team to shout it takes the points.

That one change does a lot of work. Nobody sits idle waiting their turn, the two
drawings are directly comparable, and the room stays loud for the whole round.
It also means the app's only hard job is getting the same word onto every phone
at the same moment: which is the whole design problem below.

## Run it

Any static host works, because it's all static.

```bash
python3 -m http.server 8080     # then open http://localhost:8080
```

Or push the repo to GitHub Pages and open the URL. Or run `npm run build` and
open `dist/index.html` straight off the filesystem: a single self-contained
file with the CSS and JS inlined, useful for AirDropping to someone.

> Serve it over `http(s)` rather than `file://` if you want multi-device play.
> The invite QR encodes a URL, and a `file://` path is not one.

### Settings

| Setting | Options | Notes |
|---|---|---|
| Teams | Custom names (e.g. Foxes vs Owls) | Editable on setup or mid-game |
| Devices | One phone / Phone per team | See [Multi-device play](#multi-device-play) |
| Rounds | 5 / 10 / 15 / No cap | Whoever leads when the cap hits wins |
| Difficulty | Easy / Medium / Hard / Mixed | Sets which tier the three cards draw from |
| Seconds to draw | 60 / 90 / 120 | The clock ticks faster over the last 20 seconds |
| Early finish at | 10 / 15 / 20 / No target | A knockout score; ends the game the moment it's reached |
| Feedback | Sound + buzz / either / Silent | Vibration is Android-only; iOS gets sound |

Setup groups the core decisions (Teams, Devices, Rounds, Word difficulty) upfront,
placing secondary parameters inside a collapsible *More options* drawer.
Games end on the round cap, the score target, or "wrap up" from any screen.
Active games save themselves after every round, and finished or wrapped-up games
are automatically cleared from the resume list: see [Persistence](#persistence).

## How a round goes

1. **Handoff**: whose turn it is to pick, plus the running tally in chalk marks.
2. **Theme**: the picking team gets four random themes and "Anything goes".
   The theme is announced out loud; the word is not.
3. **Cards**: three prompts at 1, 2 and 3 points. Harder word, more points.
   Reshuffle if all three are duds.
4. **Draw**: 90 seconds, ticking faster over the last 20. Hold the button to
   re-read the word. A panic button blanks the screen if someone walks past.
   Tap **"No paper? Draw it right here"** to draw directly on the screen.
5. **Result**: who got it, what it was, updated tally.

Nothing repeats within a game: in solo mode via a used-set, in synced mode by
deriving the whole history deterministically (see below).

## Drawing on the phone itself

When paper is missing, tap **"No paper? Draw it right here"** on the draw
screen to turn the phone into an instant digital drawing surface:

- **Solo mode (One phone)**: The canvas splits into two halves along a dashed
  line (Red draws above, Blue draws below) with multi-touch so both artists sketch
  on the shared screen at once.
- **Multi-device mode (Phone per team)**: Each artist gets a full-screen canvas
  in their team color (Red on Host, Blue on Guest).
- **Real-Time Opponent Sideboard**: In multi-device mode, a compact picture-in-picture
  preview in the top-right corner displays the other team's drawing live in real time
  via `BroadcastChannel` (syncing across tabs with zero server).
- **Cheat-Proof Canvas**: The secret word is never visible on the drawing pad,
  allowing teammates and guessers to look directly at the phone screen and shout guesses
  without spoiling the answer.
- **Screen Wake Lock**: Mobile screens stay awake via the Screen Wake Lock API during
  active rounds so displays never sleep mid-sketch.

## Multi-device play

Pick **Phone per team** at setup. The host phone shows a QR and an eight-character
code; every other drawer joins and gets their own screen.

### Real-Time Synchronization via Public Relay

To allow two phones anywhere on the internet (different Wi-Fi networks, cellular 4G/5G, or behind firewalls) to stay in sync without hosting custom backend infrastructure, the app connects both devices to public WebSocket MQTT relays (`broker.emqx.io` and `broker.hivemq.com`):

1. **Room Lobby & Presence**: The host sees the guest join live in the Room Lobby.
2. **Alternating Turn Word Picking**: In Round 1, Team Red (Host) picks the theme and selects from 3 card stakes (with Reshuffle support). In Round 2, Team Blue (Guest) picks. The chosen word is broadcast in real time to both devices.
3. **Bilateral Drawer Readiness**: Both drawers see the chosen secret word on their screen and tap "I'm ready".
4. **Synchronized 3-2-1 Countdown**: When both drawers are ready, the host taps "Start game". Both phones launch a simultaneous 3... 2... 1... GO! countdown with audio beeps and enter the draw screen with aligned 90-second clocks in exact lockstep.
5. **Live Drawing & Opponent Sideboard**: Strokes drawn by one team are batched and streamed live to the opponent phone's top-right picture-in-picture sideboard.
6. **Deterministic Offline Fallback**: If internet connectivity is unavailable, both devices derive identical rounds deterministically from the shared 24-bit seed.

### Joining

| Route | How | Needs |
|---|---|---|
| Camera app | Point the phone's built-in camera at the QR | Nothing: it's a URL, so the OS opens the game already joined |
| In-app scan | "Scan the code instead" on the join screen | `BarcodeDetector` (Chromium) |
| Typed code | Eight characters, e.g. `1GN5 6NDK` | Nothing. Works everywhere, always |

The typed code is the reason there's no QR *decoder* in this repo. Reading eight
characters across a room takes about as long as lining up a camera, so scanning
is the fast path rather than the only one.

### Drift, and why it's visible instead of hidden

Every device shows a four-character **sync code** derived from `(seed, round)`.
Matching codes mean matching words. If they differ, `- round` / `+ round` on the
guest screen fixes it in about three seconds.

Guests can also leave and rejoin later: the join screen offers to drop them back
into the last game at the round they left.

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
and a wrong base32 character is a burst of at most five: so every
single-character typo is caught, not merely most of them. There's a test that
walks all 248 of them.

Crockford's alphabet drops `I`, `L`, `O` and `U`, and the decoder folds the
lookalikes back, so `I` reads as `1` and `O` as `0` when a code is read aloud badly.

## Persistence

Saves go through the first storage backend that works, probed in order:

1. **Host store**: `window.storage`, where an embedding runtime provides one.
2. **`localStorage`**: survives closing the tab; the normal web case.
3. **`sessionStorage`**: survives reloads but not the tab (e.g. Safari private
   browsing). Saves work; the toast says "for this session" honestly.
4. **Memory**: last resort, survives nothing beyond the current screen flow.

Sandboxed iframes can throw just on *touching* storage, so every backend is
probed before use rather than assumed. Saved games keep scores, the round
number, team names and the used-word list: a game continued next week still
won't repeat a prompt.

When games wrap up or complete, they are immediately cleared from the active
resume list. Users can also delete individual saved games or tap "Clear all saved
games" from setup.

To change the chain, edit one line in `game.js`:

```js
const store = createStore([ADAPTERS.host, webAdapter, sessionAdapter, ADAPTERS.memory]);
```

## Layout

```
index.html              markup only, plus the link-preview metadata
build.mjs               flattens src/ into a single-file dist/index.html
sw.js                   service worker: offline shell
manifest.webmanifest    installable to a home screen
og.png                  1200x630 social card (generated)
apple-touch-icon.png    180x180 raster icon (generated)
tools/
  og-image.html         draws both of the above on a canvas
  make-og.mjs           serves that page and writes what it posts back
src/
  game.js               state machine, screens, wiring (solo | host | guest)
  duo.js                drawing surface: single-team canvas + real-time sideboard
  words.js              prompt bank, themes, mashup generator
  sync.js               deterministic round derivation, sync codes
  joincode.js           40-bit payload codec, CRC-8, invite URLs
  qr.js                 QR encoder, from scratch (see below)
  scan.js               BarcodeDetector camera scanner, degrades gracefully
  rng.js                mulberry32 + isolated generator instances
  tally.js              chalk tally marks, one geometry for SVG and canvas
  feedback.js           blips, ticks, haptics
  share.js              1080x1350 result card
  storage.js            save adapter chain + memory fallback
  storage-web.js        localStorage/sessionStorage adapters
  styles.css
  clock.js              round timer, countdown overlay, wake lock
  share-controller.js   share-card modal and tab switching
  confetti.js           win-screen burst
  p2p.js                relay transport for multi-device play
test/
  run.mjs               49 unit tests, zero dependencies
  dom.mjs               24 integration tests in jsdom
  e2e-esmodules.mjs     the same app, run as real ES modules (see below)
  metadata.mjs          link-preview tags vs. the files they promise
```

## Two builds, one invariant

The same source ships two ways, and they do not have the same scoping rules:

| | what runs | module scope |
|---|---|---|
| the site | `index.html` + `src/*.js` via `<script type="module">` | one scope **per file** |
| `dist/index.html` | every module concatenated into one IIFE | one scope **for all** |

The bundle is the forgiving one. Flattening seventeen files into a single scope
means a module can read a name that belongs to a different module and it just
resolves — so code that is only correct under the bundle looks correct
everywhere. On the served site the same line throws `ReferenceError`.

That is not hypothetical; it shipped. `clock.js` used `S`, `$`, `show` and
`finishRound` from `game.js` without importing any of them, and `share-controller.js`
assigned to `game.js`'s `activeShareTab`. Under the bundle, fine. On the real
site, picking a word threw `ReferenceError: S is not defined` and the round never
started — while every test stayed green, because every test booted the bundle.

So the invariant is: **a module may only use what it imports.** Two things hold
it up.

- Real imports, including the circular `game.js ⇄ clock.js` pair. ES modules
  handle cycles as long as nothing touches an imported binding at evaluation
  time, and nothing here does — every reference is inside a function that runs
  after boot.
- `npm run test:esm`, which boots `index.html` and the real module graph through
  Node's own ESM loader, so module boundaries are actually enforced. It walks a
  full round: theme, word, clock, score, share card. Delete an import and it
  fails; the bundle-based suites will not notice.

Mutable state cannot cross a module edge, because imported bindings are
read-only. Where it needs to, the owner exports a function instead — the
countdown timer moved wholesale into `clock.js`, and the share tab is switched
through `switchShareTab()` rather than by assignment.

## Link previews

A shared link is often the first thing anyone sees of this, so the metadata is
treated as a feature rather than boilerplate. `index.html` carries a full Open
Graph and Twitter card set, and `og.png` is a 1200×630 card drawn on a canvas by
`tools/og-image.html` — the same approach `share.js` takes, for the same reason:
no image toolchain, no dependencies.

```bash
npm run og      # redraws og.png and apple-touch-icon.png
```

Node cannot rasterise a canvas without a native dependency, so `tools/make-og.mjs`
serves the generator page and writes whatever the browser posts back. Fonts come
from Google Fonts, so it needs to be online.

Two details that quietly break previews, both now asserted in
`npm run test:meta`:

- **`og:image` must be absolute.** Crawlers do not resolve relative paths.
- **`og:image:width` / `:height` must match the actual PNG.** They are a promise
  to the crawler, and regenerating the card at a different size without updating
  the tags is the easy way to break previews with every other test still green.
  The test reads the dimensions out of the PNG's IHDR chunk and compares.

Invite links differ only by their `#fragment`, which crawlers drop, so a shared
join link previews with the same card.

## The QR encoder

Written out rather than imported, because the whole promise is that this works
with no network, and a CDN `<script>` tag would make that a lie.

It implements ISO/IEC 18004 for byte mode, versions 1-10, EC levels L and M:
Reed-Solomon over GF(256), block interleaving, the zigzag data walk, all eight
mask patterns scored by the four standard penalty rules, and BCH-protected
format and version blocks.

It's verified two ways. The unit tests assert on each stage independently:
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

1,100 curated prompts across 11 themes in three difficulty tiers, plus a
combinatorial generator (70 adjectives x 175 nouns / 105 characters x 60 actions)
that pushes the total pool past **460,000** distinct prompts.

Action mashups pair animate characters/creatures with dynamic actions
(e.g., *"polite unicorn drinking bubble tea"*, *"tiny wizard casting a magic spell"*),
ensuring every combination is visually coherent and fun to draw.

When a theme's pool runs dry the draw cascades outward instead of repeating:
other tiers, other themes, then generated mashups, which never run out.

## Browser notes

- **Screen Wake Lock**: keeps mobile displays illuminated during drawing and active
  rounds via `navigator.wakeLock`.
- **Haptics**: `navigator.vibrate` doesn't exist in Safari. The Buzz toggle
  hides itself rather than pretending.
- **In-app QR scanning**: `BarcodeDetector` is Chromium-only. The camera-app
  and typed-code routes cover everyone else.
- **Audio**: starts on first tap, as every mobile browser requires.
- **Offline**: the service worker precaches the shell, so a guest can load the
  app and join with the network down. Only active over `http(s)`; bump `CACHE`
  in `sw.js` whenever shipping changed files, or returning visitors keep the old
  bundle.
- **Multi-touch drawing**: the drawing pad uses Pointer Events, supported everywhere
  modern. Without canvas 2D the pad degrades to blank-but-harmless.

## Licence

MIT. See `LICENSE`.
