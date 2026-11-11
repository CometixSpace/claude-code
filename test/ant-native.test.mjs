import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildPolyfillModule } from '../scripts/esm-chunk-patch.mjs';

const run = promisify(execFile);

// What the addon returns is checked on Windows by native/check.cjs. Here:
// the polyfill around it, which every platform loads.
async function shimDir(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cc-ant-native-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const shim = buildPolyfillModule(await readFile(new URL('../templates/bun-polyfill.js', import.meta.url), 'utf8'));
  await writeFile(join(dir, 'bun-polyfill.mjs'), shim);
  await writeFile(join(dir, 'probe.mjs'), `await import('./bun-polyfill.mjs');
console.log(JSON.stringify(Object.keys(Bun.ant).sort()));`);
  return dir;
}

const keys = async (dir) => JSON.parse((await run(process.execPath, [join(dir, 'probe.mjs')], {
  cwd: dir, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' },
})).stdout);

test('without the addon Bun.ant is what it was', async (t) => {
  const dir = await shimDir(t);
  assert.deepEqual(await keys(dir), ['CellSegmenter']);
});

test('an addon that fails to load leaves its members absent', async (t) => {
  const dir = await shimDir(t);
  await writeFile(join(dir, `cometix-native.${process.platform}-${process.arch}.node`), 'not a native module');
  assert.deepEqual(await keys(dir), ['CellSegmenter']);
});
