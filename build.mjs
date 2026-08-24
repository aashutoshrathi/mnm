/**
 * build.mjs - bundles the app into a single self-contained HTML file.
 *
 *   node build.mjs
 *
 * The source is plain ES modules, so `index.html` already works when served
 * over HTTP (GitHub Pages, `npx serve`, anything). This build exists for the
 * other case: one file you can email, drop on a USB stick, or open straight
 * off the filesystem with no server at all.
 *
 * The bundling is deliberately naive - strip import lines, strip the `export`
 * keyword, concatenate in dependency order, wrap in an IIFE. That is enough
 * for a project this size and keeps the toolchain at zero dependencies.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

const MODULES = [
  'rng.js',
  'feedback.js',
  'p2p.js',
  'duo.js',
  'tally.js',
  'storage.js',
  'storage-web.js',
  'joincode.js',
  'qr.js',
  'scan.js',
  'words.js',
  'sync.js',
  'share.js',
  'confetti.js',
  'game.js',
];

const IMPORT_STATEMENT = /^\s*import\s[\s\S]*?from\s*'[^']*';\s*$/gm;
const EXPORT_KEYWORD = /^export\s+(?=const|let|var|function|async function|class)/gm;
const NAMESPACE_IMPORT = /^\s*import\s+\*\s+as\s+/m;
const ALIASED_IMPORT = /\bas\s+\w+\s*[,}]/;
const DEFAULT_EXPORT = /^export\s+default\b/m;

/**
 * Concatenation only works while every module shares one flat scope, so the
 * two things that would break it silently are rejected loudly instead:
 * namespace imports (the object never gets built) and aliased imports (the
 * local name disappears with the import line).
 */
function assertBundlable(name, src) {
  if (NAMESPACE_IMPORT.test(src)) {
    throw new Error(`${name}: "import * as" cannot be flattened - use named imports`);
  }
  if (DEFAULT_EXPORT.test(src)) {
    throw new Error(`${name}: default exports cannot be flattened - use a named export`);
  }
  for (const stmt of src.match(IMPORT_STATEMENT) || []) {
    if (ALIASED_IMPORT.test(stmt)) {
      throw new Error(`${name}: aliased import cannot be flattened - rename at the source`);
    }
  }
}

/** Two modules declaring the same top-level name would clobber each other. */
function assertNoCollisions(declarations) {
  const owner = new Map();
  const clashes = [];
  for (const { name, decls } of declarations) {
    for (const decl of decls) {
      if (owner.has(decl)) clashes.push(`${decl} (${owner.get(decl)} and ${name})`);
      else owner.set(decl, name);
    }
  }
  if (clashes.length) throw new Error(`Top-level name collisions: ${clashes.join(', ')}`);
}

const DECLARATION = /^(?:export\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm;

async function bundleScript() {
  const parts = [];
  const declarations = [];

  for (const name of MODULES) {
    const src = await readFile(join(root, 'src', name), 'utf8');
    assertBundlable(name, src);
    declarations.push({ name, decls: [...src.matchAll(DECLARATION)].map((m) => m[1]) });
    const stripped = src.replace(IMPORT_STATEMENT, '').replace(EXPORT_KEYWORD, '');
    parts.push(`/* ===== src/${name} ===== */\n${stripped.trim()}`);
  }

  assertNoCollisions(declarations);
  return `(function () {\n'use strict';\n\n${parts.join('\n\n')}\n})();`;
}

async function build() {
  const [html, css, script] = await Promise.all([
    readFile(join(root, 'index.html'), 'utf8'),
    readFile(join(root, 'src', 'styles.css'), 'utf8'),
    bundleScript(),
  ]);

  const fontImport =
    "@import url('https://fonts.googleapis.com/css2?" +
    'family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,800&' +
    "family=Space+Grotesk:wght@400;500;700&display=swap');";

  const out = html
    .replace(/^\s*<link rel="preconnect"[^>]*>\n/gm, '')
    .replace(/^\s*<link rel="stylesheet" href="https:\/\/fonts[^>]*>\n/gm, '')
    .replace(/^\s*<link rel="manifest"[^>]*>\n/gm, '')
    .replace(
      /^\s*<link rel="stylesheet" href="src\/styles\.css">\n/gm,
      `<style>\n${fontImport}\n\n${css}</style>\n`
    )
    .replace(
      /^\s*<script type="module" src="src\/game\.js"><\/script>\n/gm,
      `<script>\n${script}\n</script>\n`
    );

  const unreplaced = [
    ['stylesheet link', /<link[^>]+href="src\/styles\.css"/],
    ['module script', /<script[^>]+src="src\/game\.js"/],
  ].filter(([, re]) => re.test(out));

  if (unreplaced.length) {
    throw new Error(`Build failed, still linking externally: ${unreplaced.map(([n]) => n).join(', ')}`);
  }

  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'dist', 'index.html'), out);
  console.log(`dist/index.html - ${(out.length / 1024).toFixed(1)} KB`);
}

build().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
