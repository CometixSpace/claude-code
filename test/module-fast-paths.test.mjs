import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildPolyfillModule } from '../scripts/esm-chunk-patch.mjs';

const run = promisify(execFile);

// A miniature split package: an entry that imports the shim first, then
// chunks importing each other the way the bundler writes it. Those are the
// only two shapes in a real build: siblings by "./chunk-x.js", and a nested
// entry (the hooks worker) reaching back up by "../…/chunk-x.js".
async function makePackage(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cc-fast-paths-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pkg = join(dir, 'package');
  await mkdir(join(pkg, 'sub'), { recursive: true });
  const shim = buildPolyfillModule(await readFile(new URL('../templates/bun-polyfill.js', import.meta.url), 'utf8'));
  await Promise.all([
    writeFile(join(pkg, 'package.json'), '{"type":"module"}'),
    writeFile(join(pkg, 'bun-polyfill.mjs'), shim),
    // Counts its own evaluations: a second instance would mean two URLs.
    writeFile(join(pkg, 'chunk-shared.js'), 'globalThis.__evals=(globalThis.__evals??0)+1;export const tag={};'),
    writeFile(join(pkg, 'chunk-a.js'), 'export{tag}from"./chunk-shared.js";'),
    writeFile(join(pkg, 'sub', 'chunk-n.js'), 'export{tag}from"../chunk-shared.js";'),
    writeFile(join(dir, 'outside.mjs'), 'export const ok=1;'),
  ]);
  return { dir, pkg };
}

// The probe registers its own hook before loading the shim. Hooks run
// newest first, so a chunk specifier the shim answers never reaches it.
const PROBE = (pkg) => `
import { registerHooks, createRequire } from 'node:module';
const seen = [];
registerHooks({ resolve(s, c, n) { if (s.includes('chunk-')) seen.push(s); return n(s, c); } });
await import(${JSON.stringify(join(pkg, 'bun-polyfill.mjs'))});
const a = await import(${JSON.stringify(join(pkg, 'chunk-a.js'))});
const nested = await import(${JSON.stringify(join(pkg, 'sub', 'chunk-n.js'))});
const viaRequire = createRequire(${JSON.stringify(join(pkg, 'chunk-a.js'))})('./chunk-shared.js');
const outside = await import(${JSON.stringify(join(pkg, '..', 'outside.mjs'))});
console.log(JSON.stringify({
  reachedNode: seen,
  sameInstance: a.tag === nested.tag && a.tag === viaRequire.tag,
  evals: globalThis.__evals,
  outside: outside.ok,
}));
`;

test('chunk imports resolve without Node’s resolver and load once', async (t) => {
  const { dir, pkg } = await makePackage(t);
  const probe = join(dir, 'probe.mjs');
  await writeFile(probe, PROBE(pkg));
  const { stdout } = await run(process.execPath, [probe], { cwd: dir, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' } });
  const r = JSON.parse(stdout);
  // The entry's own specifier is absolute, so it is the only chunk-shaped
  // one Node still resolves; every relative chunk edge is answered first.
  assert.deepEqual(r.reachedNode.filter((s) => !s.startsWith('/')), []);
  assert.equal(r.sameInstance, true, 'import, nested import and require see one module');
  assert.equal(r.evals, 1);
  assert.equal(r.outside, 1);
});

test('a chunk-shaped specifier from outside the package is left to Node', async (t) => {
  const { dir, pkg } = await makePackage(t);
  // Outside the package the shortcut must not apply: a missing file keeps
  // Node's own error rather than a URL that fails later at load.
  await writeFile(join(dir, 'user.mjs'), 'import "./chunk-missing.js";');
  const probe = join(dir, 'probe.mjs');
  await writeFile(probe, `await import(${JSON.stringify(join(pkg, 'bun-polyfill.mjs'))});
try { await import(${JSON.stringify(join(dir, 'user.mjs'))}); } catch (e) { console.log(e.code); }`);
  const { stdout } = await run(process.execPath, [probe], { cwd: dir, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' } });
  assert.equal(stdout.trim(), 'ERR_MODULE_NOT_FOUND');
});

test('the compile cache goes to the user’s cache directory', async (t) => {
  const { dir, pkg } = await makePackage(t);
  const probe = join(dir, 'probe.mjs');
  await writeFile(probe, `await import(${JSON.stringify(join(pkg, 'bun-polyfill.mjs'))});
console.log((await import('node:module')).getCompileCacheDir() ?? 'none');`);
  const home = join(dir, 'home');
  const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'local'), XDG_CACHE_HOME: join(home, 'xdg') };
  delete env.NODE_COMPILE_CACHE;
  delete env.NODE_DISABLE_COMPILE_CACHE;
  const base = process.platform === 'win32' ? join(home, 'local')
    : process.platform === 'darwin' ? join(home, 'Library', 'Caches') : join(home, 'xdg');
  const { stdout } = await run(process.execPath, [probe], { cwd: dir, env });
  assert.ok(stdout.trim().startsWith(join(base, 'cometix-claude-code', 'node-compile-cache')), stdout);

  // Node's own switches still decide.
  const off = await run(process.execPath, [probe], { cwd: dir, env: { ...env, NODE_DISABLE_COMPILE_CACHE: '1' } });
  assert.equal(off.stdout.trim(), 'none');
  const own = join(dir, 'own-cache');
  const mine = await run(process.execPath, [probe], { cwd: dir, env: { ...env, NODE_COMPILE_CACHE: own } });
  assert.ok(mine.stdout.trim().startsWith(own), mine.stdout);
});
