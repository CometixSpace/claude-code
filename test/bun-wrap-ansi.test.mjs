import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildPolyfillModule } from '../scripts/esm-chunk-patch.mjs';

// Load the shim as a split build ships it, with the ink port beside it —
// Bun.wrapAnsi only reaches the port when bun-ink-compat.cjs is there.
test.before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-wrap-ansi-'));
  const templates = new URL('../templates/', import.meta.url);
  await copyFile(new URL('bun-ink-compat.cjs', templates), join(dir, 'bun-ink-compat.cjs'));
  const source = readFileSync(new URL('bun-polyfill.js', templates), 'utf8');
  await writeFile(join(dir, 'bun-polyfill.mjs'), buildPolyfillModule(source));
  await import(pathToFileURL(join(dir, 'bun-polyfill.mjs')).href);
  await rm(dir, { recursive: true, force: true });
});

// The bundle's ANSI-aware wrapper hands Bun.wrapAnsi these two in place of
// wide multi-unit graphemes, then restores them by matching the same code
// points. U+2FA1D has a canonical decomposition (to U+2A600), so any
// normalization breaks the round trip (#18).
const NARROW = '\u{F0000}';
const WIDE = '\u{2FA1D}';

test('placeholders pass through Bun.wrapAnsi unchanged', () => {
  for (const s of [WIDE, NARROW, `以 ${WIDE} 开头`, `${WIDE}${WIDE} ${NARROW}`]) {
    assert.equal(Bun.wrapAnsi(s, 20, {}), s);
  }
});

test('a wrapped line keeps its placeholders', () => {
  const out = Bun.wrapAnsi(`${WIDE} alpha beta gamma delta`, 10, {});
  assert.ok(out.includes('\n'), 'the line was wrapped');
  assert.ok(out.startsWith(WIDE));
  assert.ok(!out.includes('\u{2A600}'));
});

test('no other text is normalized either', () => {
  // NFD input stays NFD, as with Bun's native implementation.
  const decomposed = 'é';
  assert.equal(Bun.wrapAnsi(decomposed, 20, {}), decomposed);
});
