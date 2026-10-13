import { test } from 'node:test';
import assert from 'node:assert/strict';
import { astPatch, findSites } from '../scripts/node-compat-patch.mjs';
import { mayContainPatchSite } from '../scripts/patch-sites.mjs';

// ──────────────────────────────────────────────
//  P11: built-in plugin hooks modules load from the embedded scan, not from a
//  hooks/register.ts that no package ships.
// ──────────────────────────────────────────────

const patch = (src) => astPatch(src, 'module');

test('P11: the 2.1.285 shape keeps only the embedded branch', () => {
  const src = 'var E6=(e,o,r)=>tu()?Pt(o,r(),e):{module:o,folder:e};';
  const { code, stats } = patch(src);
  assert.equal(stats.p11, 1);
  assert.equal(code, 'var E6=(e,o,r)=>Pt(o,r(),e);');
});

test('P11: earlier builds, other names, same rewrite', () => {
  // 2.1.280 and 2.1.282, as minified
  for (const [src, out] of [
    ['var Ft=(e,o,r)=>ad()?Tr(o,r(),e):{module:o,folder:e};', 'var Ft=(e,o,r)=>Tr(o,r(),e);'],
    ['var Q4=(e,o,r)=>Nu()?gt(o,r(),e):{module:o,folder:e};', 'var Q4=(e,o,r)=>gt(o,r(),e);'],
  ]) {
    assert.equal(patch(src).code, out);
  }
});

test('P11: key order does not matter', () => {
  const src = 'var f=(e,o,r)=>s()?k(o,r(),e):{folder:e,module:o};';
  assert.equal(patch(src).code, 'var f=(e,o,r)=>k(o,r(),e);');
});

test('P11: a {module, folder} object without the scan thunk is left alone', () => {
  // Same fallback, but the other branch is not handed the scan: not the site.
  for (const src of [
    'var f=(e,o)=>s()?k(o,e):{module:o,folder:e};',
    'var f=(e,o,r)=>s()?k(o,r,e):{module:o,folder:e};',
    'var f=(e,o,r)=>s?k(o,r(),e):{module:o,folder:e};',
    'var f=(e,o,r)=>s()?k(o,r(),e):{module:o,folder:e,extra:1};',
  ]) {
    const { code, stats } = patch(src);
    assert.equal(stats.p11, 0, src);
    assert.equal(code, src);
  }
});

test('P11: the site scanner sees it, and its marker lets the file through', () => {
  const src = 'var E6=(e,o,r)=>tu()?Pt(o,r(),e):{module:o,folder:e};';
  assert.equal(mayContainPatchSite(src), true);
  assert.equal(findSites(src, 'module').p11, true);
  assert.equal(findSites(patch(src).code, 'module').p11, undefined);
});
