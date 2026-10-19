import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rewriteHooksWorker } from '../scripts/esm-chunk-patch.mjs';

// Trimmed from the chunk that starts the hooks worker, after E2 has made the
// BunFS paths relative. The helper resolving HOOKS_WORKER_URL is what marks
// the construction as the hooks one; `toUrl` is upstream's file:// joiner,
// with the BunFS root it tests for already turned into "./" by E2.
const REL = './src/plugins/functionHooks/hooks-worker/hooks-worker.js';
const BUILD = `{VERSION:"2.1.303",HOOKS_WORKER_URL:"${REL}"}`;
const TO_URL = 'var root="./";'
  + 'function toUrl(e){return os()==="windows"&&e.startsWith(root)?e:new URL(`file://${e}`)}';
const PROVIDER = `var cin=()=>(${BUILD}).HOOKS_WORKER_URL?toUrl(${BUILD}.HOOKS_WORKER_URL)`
  + ':new URL("../../../hooks-worker/hooks-worker.ts",import.meta.url);';
const HOOKS = 'new globalThis.__ccHooksWorker(';
const RESOLVED = `HOOKS_WORKER_URL:new URL(${JSON.stringify(REL)},import.meta.url).href.slice(7)`;

test('rewrites the helper called in the argument list (through 2.1.294)', () => {
  const code = TO_URL + PROVIDER
    + 'function m7n(){let e=new SharedArrayBuffer(4);return{worker:new Worker(cin(),Dkt(e)),stamp:e}}';
  const { code: out, rewritten, urls } = rewriteHooksWorker(code);
  assert.equal(rewritten, 1);
  assert.equal(urls, 2);
  assert.ok(out.includes(`${HOOKS}cin(),Dkt(e))`));
});

test('follows a parameter default back to the helper (2.1.295+)', () => {
  const code = TO_URL + PROVIDER
    + 'function Eor(e=cin()){let n=new SharedArrayBuffer(4);return{worker:new Worker(e,sin(n)),stamp:n}}';
  const { code: out, rewritten } = rewriteHooksWorker(code);
  assert.equal(rewritten, 1);
  assert.ok(out.includes(`${HOOKS}e,sin(n))`));
  assert.ok(out.includes('function Eor(e=cin())'), 'the default itself is left alone');
});

test('accepts the default on an arrow function too', () => {
  const code = TO_URL + PROVIDER + 'var Eor=(e=cin())=>({worker:new Worker(e,{})});';
  assert.equal(rewriteHooksWorker(code).rewritten, 1);
});

test('a nearer parameter of the same name shadows the default', () => {
  const code = TO_URL + PROVIDER
    + 'function outer(e=cin()){return function inner(e){return new Worker(e,{})}}';
  const { rewritten, urls } = rewriteHooksWorker(code);
  assert.equal(rewritten, 0);
  assert.equal(urls, 0, 'no URL is touched without the Worker that uses it');
});

test('leaves library workers in the same chunk alone', () => {
  const code = TO_URL + PROVIDER
    + 'function h(n){for(var A=0;A<4;++A){var I=new Worker(n)}}'
    + 'function g(e=blobUrl()){return new Worker(e)}'
    + 'function Eor(e=cin()){return new Worker(e,{})}';
  const { code: out, rewritten } = rewriteHooksWorker(code);
  assert.equal(rewritten, 1);
  assert.ok(out.includes('var I=new Worker(n)'));
  assert.ok(out.includes('return new Worker(e)}'));
});

test('resolves HOOKS_WORKER_URL only inside the helper', () => {
  const elsewhere = `var info=${BUILD};`;
  const code = elsewhere + TO_URL + PROVIDER + 'function Eor(e=cin()){return new Worker(e,{})}';
  const { code: out } = rewriteHooksWorker(code);
  assert.ok(out.startsWith(elsewhere), 'the same constant outside the helper is untouched');
  assert.equal(out.split(RESOLVED).length - 1, 2);
});

test('skips chunks without the hooks worker URL', () => {
  const code = 'function g(e=blobUrl()){return new Worker(e)}';
  assert.deepEqual(rewriteHooksWorker(code), { code, rewritten: 0, urls: 0 });
});

// Upstream's joiner, run for real against a package directory that needs
// escaping. Before the rewrite the URL came out as file://./src/… and Node
// rejected it outright.
for (const platform of ['macos', 'windows']) {
  test(`the helper yields the packaged worker as a file URL (${platform} branch)`, async (t) => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'cc-hooks-url-')));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const pkg = join(dir, 'package with spaces #钩子');
    await mkdir(pkg);
    const { code } = rewriteHooksWorker(`var os=()=>${JSON.stringify(platform)};` + TO_URL + PROVIDER
      + 'export function Eor(e=cin()){return new Worker(e,{})}export{cin};');
    await writeFile(join(pkg, 'chunk-hooks.mjs'), code);
    const { cin } = await import(pathToFileURL(join(pkg, 'chunk-hooks.mjs')).href);
    const url = cin();
    assert.ok(url instanceof URL, 'takes the URL branch, not the bare-path one');
    assert.equal(url.host, '');
    if (process.platform !== 'win32') assert.equal(fileURLToPath(url), join(pkg, REL));
  });
}
