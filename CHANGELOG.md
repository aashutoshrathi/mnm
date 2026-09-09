# Changelog

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

- **A late `DRAWER_READY` could drag the host back into a finished round.**
  `hostReadyState` and `guestReadyState` both stay true from the moment a round
  starts until the next `toHandoff()`, so a duplicate or relay-delayed ready
  message still satisfied `hostReady && guestReady` after the round was scored —
  and `startHostSyncedRound()`'s "is `s-draw` active" check did not catch it,
  because by then the host had moved on to the result or victory screen. The
  host was yanked out of the result screen back into a dead round.

  It had been failing CI intermittently on `main` before this branch, as
  `'s-draw' !== 's-win'` in `e2e-creative-match`, and never reproduced locally
  because it needs the message to land after scoring.

  A ready handshake now starts a round only while the host is actually on the
  handoff screen. The check lives in the `DRAWER_READY` handler rather than in
  `startHostSyncedRound()` on purpose: the `reveal` button is a second,
  legitimate way into the same round, and it has to keep working when a repeated
  `WORD_SELECTED` bounces the host back to handoff. `e2e-creative-match` injects
  the stale ready message directly and asserts the host stays on the result
  screen.

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
