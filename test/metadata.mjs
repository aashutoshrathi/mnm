/**
 * test/metadata.mjs - checks the tags that decide how a shared link looks.
 *
 *   node test/metadata.mjs
 *
 * Link previews fail silently. Nothing in the app breaks if og:image goes
 * stale, points at a relative path, or claims dimensions the file does not
 * have - the page just renders as a bare grey box in iMessage and Slack, and
 * you only find out when someone shares it. So the invariants are asserted
 * here instead: the tags exist, the image URLs are absolute, the files they
 * name are really in the repo, and the sizes they advertise are the sizes the
 * PNGs actually are.
 *
 * That last one matters most. og:image:width is a promise to the crawler, and
 * regenerating the card at a different size without updating the tag is the
 * easiest way to break previews while every other test stays green.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { test, group, report } = createRunner();

const html = await readFile(join(root, 'index.html'), 'utf8');
const manifest = JSON.parse(await readFile(join(root, 'manifest.webmanifest'), 'utf8'));

const ORIGIN = 'https://mnm.aashutosh.dev';

/** Pull a meta tag's content by property= (OG) or name= (Twitter). */
function meta(key) {
  const re = new RegExp(`<meta\\s+(?:property|name)="${key}"\\s+content="([^"]*)"`, 'i');
  return html.match(re)?.[1] ?? null;
}

function link(rel) {
  return html.match(new RegExp(`<link\\s+rel="${rel}"\\s+href="([^"]*)"`, 'i'))?.[1] ?? null;
}

/** PNG dimensions live in the IHDR chunk: 4-byte width and height at offset 16. */
async function pngSize(name) {
  const buf = await readFile(join(root, name));
  assert.equal(buf.subarray(1, 4).toString(), 'PNG', `${name} is not a PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

group('open graph');

await test('the tags a crawler needs are all present', async () => {
  for (const key of [
    'og:type', 'og:site_name', 'og:url', 'og:title', 'og:description',
    'og:image', 'og:image:type', 'og:image:width', 'og:image:height', 'og:image:alt',
  ]) {
    assert.ok(meta(key), `missing <meta property="${key}">`);
  }
});

await test('image URLs are absolute, because crawlers do not resolve relative paths', async () => {
  for (const key of ['og:image', 'og:image:secure_url', 'twitter:image']) {
    const value = meta(key);
    assert.ok(value, `missing ${key}`);
    assert.ok(value.startsWith('https://'), `${key} must be absolute, got "${value}"`);
  }
  assert.ok(meta('og:url').startsWith(ORIGIN), 'og:url should point at the live origin');
});

await test('og:image names a file that is actually committed', async () => {
  const url = meta('og:image');
  assert.ok(url.startsWith(`${ORIGIN}/`), `og:image should be served from ${ORIGIN}`);
  const { bytes } = await pngSize(url.slice(ORIGIN.length + 1));
  assert.ok(bytes > 1000, 'og.png looks empty');
});

await test('the advertised dimensions match the PNG on disk', async () => {
  const { width, height } = await pngSize('og.png');
  assert.equal(String(width), meta('og:image:width'), 'og:image:width disagrees with og.png');
  assert.equal(String(height), meta('og:image:height'), 'og:image:height disagrees with og.png');

  // 1.91:1 is what Facebook, LinkedIn, Slack and iMessage all crop to.
  assert.equal(width, 1200, 'og.png should be 1200 wide');
  assert.equal(height, 630, 'og.png should be 630 tall');
});

await test('og.png stays under the 5 MB every scraper caps at', async () => {
  const { bytes } = await pngSize('og.png');
  assert.ok(bytes < 5 * 1024 * 1024, `og.png is ${(bytes / 1024 / 1024).toFixed(1)} MB`);
});

group('twitter card');

await test('summary_large_image is backed by a real image and alt text', async () => {
  assert.equal(meta('twitter:card'), 'summary_large_image');
  assert.ok(meta('twitter:image'), 'summary_large_image with no twitter:image renders as a blank card');
  assert.ok(meta('twitter:title'), 'missing twitter:title');
  assert.ok(meta('twitter:description'), 'missing twitter:description');
  assert.ok(meta('twitter:image:alt'), 'missing twitter:image:alt');
});

group('icons');

await test('apple-touch-icon is linked and is the 180x180 iOS expects', async () => {
  assert.equal(link('apple-touch-icon'), 'apple-touch-icon.png');
  const { width, height } = await pngSize('apple-touch-icon.png');
  assert.equal(width, 180);
  assert.equal(height, 180);
});

await test('every manifest icon resolves to a file of the size it claims', async () => {
  for (const icon of manifest.icons) {
    await readFile(join(root, icon.src));
    if (icon.type === 'image/png') {
      const { width, height } = await pngSize(icon.src);
      assert.equal(icon.sizes, `${width}x${height}`, `${icon.src} claims ${icon.sizes}`);
    }
  }
});

await test('the manifest offers a raster icon, which SVG-only installs do not get', async () => {
  assert.ok(
    manifest.icons.some((i) => i.type === 'image/png'),
    'iOS and several Android launchers ignore SVG icons entirely'
  );
});

group('canonical');

await test('a canonical URL is declared on the live origin', async () => {
  assert.equal(link('canonical'), `${ORIGIN}/`);
});

report();
process.exit(0);
