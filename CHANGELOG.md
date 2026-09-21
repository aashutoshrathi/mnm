# Changelog

## Unreleased

### Fixed

- **The back gesture closed the installed app.** `index.html` is one document
  with one history entry, so an edge swipe popped that entry and unloaded the
  page - on Android, an installed PWA shut down outright, mid-round. `show()`
  had been pushing an entry per screen change to paper over this, which made it
  worse in a different way: the stack grew all game, so back had to be pressed
  once per screen already visited before anything happened, and when it finally
  did it dumped the player at setup from wherever they were.

  New `src/nav.js` keeps a spare entry underneath at all times instead - armed
  at boot, re-armed at the top of every `popstate` - so a pop always has
  something to consume that is not the app, and the history depth never moves.

### Added

- **A back button on every screen but the setup root**, and the OS back gesture
  now drives the same code. Back peels one layer at a time: an open overlay
  first (a modal, the drawing pad, the hidden-screen veil), then the screen
  itself, up one level. A back press while a confirmation is on screen answers
  *no* rather than leaving twice as fast.

  Two steps are deliberately not reversals of the route in. `s-result` leaves
  the game rather than returning to the pick that produced it, because going
  back to the handoff would let an already-scored round be played and scored
  again. And the round hub is resolved when the gesture happens, not when the
  screen was shown, so a phone that joined a room mid-session goes back to
  `s-guest` rather than `s-handoff`.

  Anything that would discard live play asks first - leaving a game, ending a
  running round. Anything that would not just happens. At the setup root back
  does nothing at all, and in particular never unloads the app.

- `test/e2e-back-navigation.mjs`, 17 tests over a real `history.back()` rather
  than a synthetic `popstate`: a synthetic event pushes without popping, and
  the history-depth assertions that are the whole point would pass on a stack
  that was quietly growing. `npm run test:nav`, and part of `test:all`.

- The join screen's "Back" link is gone; the topbar arrow replaces it.

- **The service worker's precache list no longer duplicates the module list.**
  `build.mjs` held the offline shell and the bundler's `MODULES` as two
  hardcoded copies, and a module added to one and not the other drops out of
  the precache silently - everything works until a guest opens the app with no
  network, and then the module graph fails to resolve. The shell is derived
  from `MODULES` now. `src/nav.js` would have been the first casualty.

## 1.1.0

### Fixed

- **Picking a word did nothing on the live site.** `clock.js` read `S`, `$`,
  `show`, `finishRound` and friends straight out of `game.js` without importing
  them, so `startRound()` threw `ReferenceError: S is not defined` the moment a
  card was tapped and the round never started. `share-controller.js` had the
  same problem, plus a write to `game.js`'s `activeShareTab` — an imported
  binding is read-only, so that was a `TypeError` waiting on the share modal.

  Both only ever worked because `dist/index.html` flattens every module into one
  IIFE, and every test booted that bundle rather than the `index.html` +
  `src/*.js` module graph the site actually serves. Modules now import what they
  use; see [Two builds, one invariant](README.md#two-builds-one-invariant).

- The countdown timer moved from `game.js` into `clock.js`, which already had to
  cancel it in `stopClock()`. A timer two modules can clear needs one owner.

- Share-card tabs switch through `switchShareTab()` instead of an assignment
  across a module boundary.

- **A stale `DRAWER_READY` could drag the host back into a finished round.**
  Both ready flags stay true from when a round starts until the next
  `toHandoff()`, so a duplicate or relay-delayed ready message still satisfied
  `hostReady && guestReady` after the round was scored — and the "is `s-draw`
  active" check did not catch it, because by then the host was on the result or
  victory screen. A ready handshake now starts a round only while the host is on
  the handoff screen. The check lives in the `DRAWER_READY` handler rather than
  in `startHostSyncedRound()` because `reveal` is a second, legitimate way into
  the same round and has to keep working.

- **Every cross-device message was acted on twice.** `p2p.js` sends on both
  transports at once — BroadcastChannel for windows on the same device, a public
  MQTT broker for everything else — and the receiver accepted from both. So each
  message arrived once almost immediately and once after a network round trip.

  Handlers that set absolute values survive that. The ones that move the host
  between screens do not: a repeated `WORD_SELECTED` runs `toHandoff()` and
  drags the host off a round in progress, and a repeated `DRAWER_READY` tries to
  start a round that has already been scored. Since the delay on the second copy
  belongs to a third party, this showed up only on CI — where it had been
  failing on `main` before this release as `'s-guest' !== 's-win'` and
  `'s-draw' !== 's-win'` — and never in a local run.

  Sends now carry a sequence number and the receiver drops a `from:seq` it has
  already handled. `test/e2e-p2p-dedupe.mjs` replays a duplicate directly rather
  than waiting for one to be timed badly.

- The test harness no longer hands jsdom a real `WebSocket`, so the suites talk
  over BroadcastChannel only instead of reaching `broker.emqx.io` from CI.

### Added

- **Link previews.** `og.png`, a 1200×630 social card, plus a full Open Graph
  and Twitter card set: `og:url`, `og:image` and its dimensions, `og:image:alt`,
  `twitter:image`, `og:site_name`, `og:locale`, and a canonical URL. Shared
  links — including invite links, which differ only by a `#fragment` crawlers
  drop — now render as a card instead of a bare box.

- **`apple-touch-icon.png`** (180×180), linked and added to the web manifest.
  iOS and several Android launchers ignore SVG icons, and the manifest had only
  an SVG.

- **`npm run og`** regenerates both images. `tools/og-image.html` draws them on
  a canvas, the way `share.js` draws the result card; `tools/make-og.mjs` serves
  that page and writes what it posts back, so there is still no image toolchain.

- **`npm run test:esm`** boots `index.html` and the real module graph through
  Node's ESM loader and walks a full round. It fails if a module uses a name it
  did not import — the check that was missing.

- **`npm run test:meta`** asserts the preview tags against the files they name:
  image URLs absolute, referenced files present, and the advertised dimensions
  equal to what is actually in each PNG's IHDR.

- Both suites run in CI as their own jobs. The ES-module job deliberately skips
  `npm run build`, so it can only pass on the served layout.

## 1.0.0

Initial release.
