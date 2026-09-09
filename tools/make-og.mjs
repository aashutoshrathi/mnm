/**
 * tools/make-og.mjs - regenerates og.png and apple-touch-icon.png.
 *
 *   npm run og
 *
 * The card is drawn on a canvas, and nothing in Node can rasterise a canvas
 * without pulling in a native dependency, which this repo does not have and
 * does not want. So the browser does the drawing - the part it is already good
 * at - and this script is just the courier: it serves the generator page, waits
 * for the page to POST the finished PNG back, writes it, and exits.
 *
 * Fonts come from Google Fonts, so the machine running this needs to be online.
 * Opening the page by hand works too; it offers a download button if the POST
 * has nowhere to go.
 */

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8123;
const TIMEOUT_MS = 120_000;

/** Whitelisted so a stray POST cannot name its own path in the repo. */
const ASSETS = new Set(['og.png', 'apple-touch-icon.png']);

const page = await readFile(join(root, 'tools', 'og-image.html'), 'utf8');

const pending = new Set(ASSETS);

const server = createServer(async (req, res) => {
  const name = req.method === 'POST' && req.url?.startsWith('/save/') ? req.url.slice(6) : null;

  if (name) {
    if (!ASSETS.has(name)) {
      res.writeHead(404).end('unknown asset');
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const png = Buffer.concat(chunks);

    if (png.length < 200 || png.subarray(1, 4).toString() !== 'PNG') {
      res.writeHead(400).end('not a PNG');
      return;
    }

    await writeFile(join(root, name), png);
    res.writeHead(200).end('saved');
    console.log(`${name} - ${(png.length / 1024).toFixed(1)} KB (${png.length} bytes)`);

    pending.delete(name);
    if (pending.size === 0) {
      server.close();
      process.exit(0);
    }
    return;
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
});

server.listen(PORT, () => {
  console.log(`Open http://localhost:${PORT}/ - the page will post og.png back here.`);
});

setTimeout(() => {
  console.error(`No PNG received in ${TIMEOUT_MS / 1000}s. Was the page opened?`);
  process.exit(1);
}, TIMEOUT_MS).unref?.();
