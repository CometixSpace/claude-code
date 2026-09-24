import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteImportMeta, bunOnlyImportMeta } from '../scripts/esm-chunk-patch.mjs';

// ──────────────────────────────────────────────
//  E8: Bun's import.meta.dir / .path → Node's .dirname / .filename, and the
//  post-patch check that no other Bun-only import.meta property ships.
// ──────────────────────────────────────────────

test('E8: dir and path become dirname and filename', () => {
  // The shape 2.1.281 took startup down with.
  const src = 'var Ut=()=>EC({name:fe,hooksModule:R4(import.meta.dir,jt(Z),()=>Ye())});let f=import.meta.path;';
  const { code, rewritten } = rewriteImportMeta(src);
  assert.equal(rewritten, 2);
  assert.equal(code, 'var Ut=()=>EC({name:fe,hooksModule:R4(import.meta.dirname,jt(Z),()=>Ye())});let f=import.meta.filename;');
});

test('E8: what Node already defines is left alone', () => {
  const src = 'let a=import.meta.dirname,b=import.meta.url,c=import.meta.filename,d=import.meta.resolve("x");';
  assert.deepEqual(rewriteImportMeta(src), { code: src, rewritten: 0 });
});

test('E8: text that only mentions import.meta.dir is not a property access', () => {
  const src = 'let doc="use import.meta.dir for the folder";let d=import.meta.dir;';
  const { code, rewritten } = rewriteImportMeta(src);
  assert.equal(rewritten, 1);
  assert.equal(code, 'let doc="use import.meta.dir for the folder";let d=import.meta.dirname;');
});

test('guard: nothing to report once E8 has run', () => {
  const src = 'let d=import.meta.dir,f=import.meta.path,u=import.meta.url;';
  assert.deepEqual(bunOnlyImportMeta(src), ['dir', 'path']);
  assert.deepEqual(bunOnlyImportMeta(rewriteImportMeta(src).code), []);
});

test('guard: Bun-only properties without a Node equivalent are reported', () => {
  const src = 'if(import.meta.main)run();let e=import.meta.env.HOME,f=import.meta.file,u=import.meta.url;';
  assert.deepEqual(bunOnlyImportMeta(src).sort(), ['env', 'file', 'main']);
});

test('guard: a mention inside a string is not reported', () => {
  assert.deepEqual(bunOnlyImportMeta('let s="import.meta.main is Bun-only";'), []);
});

test('guard: a module that does not parse is judged on its text', () => {
  assert.deepEqual(bunOnlyImportMeta('let x = import.meta.main +;'), ['main']);
});
