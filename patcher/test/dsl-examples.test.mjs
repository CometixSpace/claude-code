import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectLayout } from '../core/layout.mjs';
import { createScanContext, scanPatch } from '../core/scan.mjs';
import { compilePatch, mergeByFile, writeFiles, verifyPatch } from '../core/apply.mjs';
import { applyEdits } from '../core/edit.mjs';
import { validate } from '../core/registry.mjs';

// ──────────────────────────────────────────────
//  Every example in patcher/DSL.md, run for real
//
//  Each test is one worked example from the guide: the source a site is
//  pointed at, the declaration, and the text that comes out. If the engine's
//  behaviour moves, the guide is wrong, and this is where that shows up.
//  The section named in each test title is the one in DSL.md.
// ──────────────────────────────────────────────

const MARKER = /\/\*@cc:[^*]*\*\//g;

// Lay out `files` as a split install (cli.js plus chunk siblings), run one
// patch through scan → compile → splice, and return the rewritten sources
// with markers stripped — the examples show the code, not the bookkeeping.
async function run(files, patch, { write = false } = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsl-example-')));
  const all = { 'cli.js': 'import"./chunk-a.js";\n', ...files };
  for (const [name, text] of Object.entries(all)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  const layout = await detectLayout(join(dir, 'cli.js'));
  const full = { id: 'demo', ...patch };
  const result = await scanPatch(full, createScanContext(layout));
  const out = {};
  let problems;
  if (result.ok) {
    for (const [file, edits] of compilePatch(full, result)) {
      out[file] = applyEdits(all[file], edits).replace(MARKER, '');
    }
    // The full apply path, for the examples about what happens after the
    // write: splice with markers, re-parse, write, then run `verify`.
    if (write) {
      const merged = mergeByFile([compilePatch(full, result)]);
      await writeFiles(dir, merged);
      problems = await verifyPatch(dir, full, merged, result.values);
      for (const file of merged.keys()) out[file] = await readFile(join(dir, file), 'utf8');
    }
  }
  return { ...result, out, problems };
}

const one = (site) => ({ sites: [{ marker: '', ...site }] });

// ── Locating ───────────────────────────────────────────────────────────

test('locate / where: equality on fields picks one property out of two lookalikes', async () => {
  const src = 'var g={"ctrl+c":"app:interrupt","ctrl+d":"app:exit"},t={"ctrl+c":"transcript:exit"};';
  const r = await run({ 'chunk-a.js': src }, one({
    id: 'ctrl-c',
    match: { node: 'Property', where: { 'key.value': 'ctrl+c', 'value.value': 'app:interrupt' } },
    edit: { op: 'replace-value', text: '"app:exit"' },
  }));
  assert.equal(r.out['chunk-a.js'],
    'var g={"ctrl+c":"app:exit","ctrl+d":"app:exit"},t={"ctrl+c":"transcript:exit"};');
});

test('locate / comparisons: lte keeps a large constant out', async () => {
  const src = 'var K=30,T=86400000;';
  const r = await run({ 'chunk-a.js': src }, one({
    id: 'retention',
    match: { node: 'VariableDeclarator', where: { 'init.type': 'Literal', 'init.value': { lte: 365 } } },
    edit: { op: 'replace-field', field: 'init', text: '9999' },
  }));
  assert.equal(r.out['chunk-a.js'], 'var K=9999,T=86400000;');
});

test('locate / arrays: [] tests every element, a number picks one', async () => {
  const src = 'H("tengu_keys",!1);H("tengu_other",!1);';
  const r = await run({ 'chunk-a.js': src }, one({
    id: 'flag',
    match: { node: 'CallExpression', where: { 'arguments.[].value': 'tengu_keys', 'arguments.1.argument.value': 1 } },
    edit: { op: 'replace-field', field: 'arguments.1', text: '!0' },
  }));
  assert.equal(r.out['chunk-a.js'], 'H("tengu_keys",!0);H("tengu_other",!1);');
});

test('locate / contains: a regex survives spacing a substring would not', async () => {
  const src = 'function a(){return{argumentHint:  "[hold]"}}function b(){return{argumentHint:"[tap]"}}';
  const r = await run({ 'chunk-a.js': src }, one({
    id: 'hold',
    match: { node: 'FunctionDeclaration', contains: '/argumentHint:\\s*"\\[hold/' },
    edit: { op: 'replace-body', text: '{return null}' },
  }));
  assert.equal(r.out['chunk-a.js'], 'function a(){return null}function b(){return{argumentHint:"[tap]"}}');
});

test('locate / excludes: rule out the lookalike that carries a telltale', async () => {
  const src = 'var a={behavior:"deny",noVerdict:!0},b={behavior:"deny",status:500};';
  const r = await run({ 'chunk-a.js': src }, one({
    id: 'unavailable',
    match: { node: 'ObjectExpression', contains: 'behavior:"deny"', excludes: 'noVerdict' },
    edit: { op: 'replace-field', field: 'properties.0.value', text: '"ask"' },
  }));
  assert.equal(r.out['chunk-a.js'], 'var a={behavior:"deny",noVerdict:!0},b={behavior:"ask",status:500};');
});

test('locate / has: a shape inside, resolved against the node\'s own capture', async () => {
  const src = 'function acc(e,n){return{type:"C",m:e.messages[0]}}function wrap(e){return{type:"C"}}';
  const r = await run({ 'chunk-a.js': src }, one({
    id: 'accumulator',
    match: {
      node: 'FunctionDeclaration',
      contains: 'type:"C"',
      capture: { param: 'params.0.name' },
      has: { node: 'MemberExpression', where: { 'property.value': 0, 'object.property.name': 'messages', 'object.object.name': '{{param}}' } },
    },
    capture: { fn: 'id.name' },
    edit: { op: 'prepend-body', text: 'return null;' },
  }));
  assert.equal(r.values.fn, 'acc');
  assert.equal(r.out['chunk-a.js'], 'function acc(e,n){return null;return{type:"C",m:e.messages[0]}}function wrap(e){return{type:"C"}}');
});

test('locate / hasNot: the same test, inverted', async () => {
  const src = 'function acc(e){return e.messages[0]}function wrap(e){return e}';
  const r = await run({ 'chunk-a.js': src }, one({
    id: 'wrapper',
    match: { node: 'FunctionDeclaration', hasNot: { node: 'MemberExpression', where: { 'property.name': 'messages' } } },
    capture: { fn: 'id.name' },
  }));
  assert.equal(r.values.fn, 'wrap');
});

test('locate / nth: first by default, a number, "last" or "all"', async () => {
  const src = 'var x=[1,1,1];';
  const site = (nth) => one({ id: 'ones', match: { node: 'Literal', where: { value: 1 }, nth }, edit: { op: 'replace', text: '2' } });
  assert.equal((await run({ 'chunk-a.js': src }, site(undefined))).out['chunk-a.js'], 'var x=[2,1,1];');
  assert.equal((await run({ 'chunk-a.js': src }, site(1))).out['chunk-a.js'], 'var x=[1,2,1];');
  assert.equal((await run({ 'chunk-a.js': src }, site('last'))).out['chunk-a.js'], 'var x=[1,1,2];');
  assert.equal((await run({ 'chunk-a.js': src }, site('all'))).out['chunk-a.js'], 'var x=[2,2,2];');
});

test('locate / nth counts within a file; nthFile "all" takes one from each', async () => {
  const files = { 'chunk-a.js': 'var a=[1,1];', 'chunk-b.js': 'var b=[1,1];' };
  const site = (extra) => one({ id: 'ones', match: { node: 'Literal', where: { value: 1 }, nth: 1 }, ...extra,
    edit: { op: 'replace', text: '2' } });
  const first = await run(files, site({}));
  assert.deepEqual(first.out, { 'chunk-a.js': 'var a=[1,2];' }, 'the 2nd hit of the first file, not of the tree');
  const each = await run(files, site({ nthFile: 'all' }));
  assert.deepEqual(each.out, { 'chunk-a.js': 'var a=[1,2];', 'chunk-b.js': 'var b=[1,2];' });
});

test('locate / exists: false holds for a path that is absent, not only null', async () => {
  const r = await run({ 'chunk-a.js': 'let a;let b=1;' }, one({
    id: 'bare',
    match: { node: 'VariableDeclarator', where: { 'init.value': { exists: false } } },
    capture: { name: 'id.name' },
  }));
  assert.equal(r.values.name, 'a');
});

test('locate / marker: an array passes a file mentioning any of them', async () => {
  const r = await run({ 'chunk-a.js': 'var x="beta";' }, one({
    id: 'lit', marker: ['alpha', 'beta'], match: { node: 'Literal', where: { value: 'beta' } },
    edit: { op: 'replace', text: '"gamma"' },
  }));
  assert.equal(r.out['chunk-a.js'], 'var x="gamma";');
});

// ── Capturing ──────────────────────────────────────────────────────────

test('capture / field: a minified name into the replacement', async () => {
  const src = 'function run(a,b,m){return send({classifierModel:m,stage:"s1"})}';
  const r = await run({ 'chunk-a.js': src }, {
    stages: [
      { id: 'find', sites: [{ id: 'arg', marker: 'classifierModel',
        match: { node: 'Property', where: { 'key.name': 'classifierModel', 'value.type': 'Identifier' } },
        capture: { model: 'value.name' } }] },
      { id: 'edit', sites: [{ id: 'entry', sameFileAs: 'arg', marker: 'classifierModel',
        match: { node: 'FunctionDeclaration', has: { node: 'Property', where: { 'key.name': 'classifierModel', 'value.name': '{{model}}' } } },
        edit: { op: 'prepend-body', text: 'if(process.env.M){{model}}=process.env.M;' } }] },
    ],
  });
  assert.equal(r.out['chunk-a.js'], 'function run(a,b,m){if(process.env.M)m=process.env.M;return send({classifierModel:m,stage:"s1"})}');
});

test('capture / $src: an expression, spliced back verbatim', async () => {
  const src = 'h.emit({id:F,kind:k});';
  const r = await run({ 'chunk-a.js': src }, one({
    id: 'emit',
    match: { node: 'CallExpression', where: { 'callee.property.name': 'emit' } },
    capture: { event: '$src:arguments.0', id: 'arguments.0.properties.0.value.name' },
    edit: { op: 'replace-field', field: 'arguments.0', text: 'P.set({{id}},{{event}}).get({{id}})' },
  }));
  assert.equal(r.out['chunk-a.js'], 'h.emit(P.set(F,{id:F,kind:k}).get(F));');
});

test('capture / search by it: a later stage finds the declaration, in the same file only', async () => {
  const r = await run({
    'chunk-a.js': 'var K=30;function f(c){return c.cleanupPeriodDays??K}',
    'chunk-b.js': 'var K=30;export{K};',
  }, {
    stages: [
      { id: 'find', sites: [{ id: 'usage', marker: 'cleanupPeriodDays',
        match: { node: 'LogicalExpression', where: { operator: '??', 'left.property.name': 'cleanupPeriodDays' } },
        capture: { k: 'right.name' } }] },
      { id: 'raise', sites: [{ id: 'decl', sameFileAs: 'usage', marker: 'cleanupPeriodDays',
        match: { node: 'VariableDeclarator', where: { 'id.name': '{{k}}' } },
        edit: { op: 'replace-field', field: 'init', text: '9999' } }] },
    ],
  });
  assert.equal(r.out['chunk-a.js'], 'var K=9999;function f(c){return c.cleanupPeriodDays??K}');
  assert.equal(r.out['chunk-b.js'], undefined, 'chunk-b\'s own K is left alone');
});

test('capture / within: a local of one function, not its namesake elsewhere', async () => {
  const src = 'function other(n){let{settingsData:x}=n;return x}function builder(n){let{settingsData:r}=n;return[{id:"a"}]}';
  const r = await run({ 'chunk-a.js': src }, {
    sites: [
      { id: 'builder', marker: 'id:"a"', match: { node: 'FunctionDeclaration', contains: 'id:"a"' } },
      { id: 'sd', within: 'builder', marker: 'id:"a"',
        match: { node: 'Property', where: { 'key.name': 'settingsData' } }, capture: { sd: 'value.name' } },
      { id: 'row', within: 'builder', marker: 'id:"a"',
        match: { node: 'ObjectExpression', where: { 'properties.0.value.value': 'a' } },
        edit: { op: 'insert-before', text: '{id:"z",v:{{sd}}},' } },
    ],
  });
  assert.equal(r.values.sd, 'r');
  assert.equal(r.out['chunk-a.js'], 'function other(n){let{settingsData:x}=n;return x}function builder(n){let{settingsData:r}=n;return[{id:"z",v:r},{id:"a"}]}');
});

test('capture / when: a stage that runs only if an earlier one found something', async () => {
  const patch = {
    stages: [
      { id: 'probe', sites: [{ id: 'opt', marker: 'legacy', expect: 'optional',
        match: { node: 'Identifier', where: { name: 'legacy' } }, capture: { hit: 'name' } }] },
      { id: 'fix', when: { captured: 'hit' }, sites: [{ id: 'req', marker: 'legacy',
        match: { node: 'Identifier', where: { name: 'legacy' } }, edit: { op: 'replace', text: 'modern' } }] },
    ],
  };
  const absent = await run({ 'chunk-a.js': 'var x=1;' }, patch);
  assert.equal(absent.ok, true, 'the required site in a skipped stage does not fail the patch');
  const present = await run({ 'chunk-a.js': 'var x=legacy;' }, patch);
  assert.equal(present.out['chunk-a.js'], 'var x=modern;');
});

// ── Editing ────────────────────────────────────────────────────────────

const onF = (edit, src = 'function f(a){let x=1;return x}') =>
  run({ 'chunk-a.js': src }, one({ id: 'f', match: { node: 'FunctionDeclaration', where: { 'id.name': 'f' } }, edit }));

test('edit / replace, replace-body, prepend-body, append-body', async () => {
  assert.equal((await onF({ op: 'replace', text: 'function f(){}' })).out['chunk-a.js'], 'function f(){}');
  assert.equal((await onF({ op: 'replace-body', text: '{return!0}' })).out['chunk-a.js'], 'function f(a){return!0}');
  assert.equal((await onF({ op: 'prepend-body', text: 'if(!a)return;' })).out['chunk-a.js'], 'function f(a){if(!a)return;let x=1;return x}');
  assert.equal((await onF({ op: 'append-body', text: ';done(x)' }, 'function f(a){let x=1}')).out['chunk-a.js'], 'function f(a){let x=1;done(x)}');
});

test('edit / body ops reach a method through field', async () => {
  const src = 'var ch={subscribe(l){add(l)},reply(r){send(r)}};';
  const r = await run({ 'chunk-a.js': src }, one({
    id: 'sub', match: { node: 'Property', where: { 'key.name': 'subscribe' } },
    capture: { l: 'value.params.0.name' },
    edit: { op: 'prepend-body', field: 'value', text: 'replay({{l}});' },
  }));
  assert.equal(r.out['chunk-a.js'], 'var ch={subscribe(l){replay(l);add(l)},reply(r){send(r)}};');
});

test('edit / replace-field and replace-value', async () => {
  const cond = await run({ 'chunk-a.js': 'if(s?.aborted||n===0)cancel();' }, one({
    id: 'cond', match: { node: 'IfStatement' }, capture: { keep: '$src:test.left' },
    edit: { op: 'replace-field', field: 'test', text: '{{keep}}' },
  }));
  assert.equal(cond.out['chunk-a.js'], 'if(s?.aborted)cancel();');

  const val = await run({ 'chunk-a.js': 'var o={mode:"deny"};' }, one({
    id: 'val', match: { node: 'Property', where: { 'key.name': 'mode' } }, edit: { op: 'replace-value', text: '"ask"' },
  }));
  assert.equal(val.out['chunk-a.js'], 'var o={mode:"ask"};');
});

test('edit / insert-before and insert-after', async () => {
  const site = (op) => one({ id: 'b', match: { node: 'ObjectExpression', where: { 'properties.0.value.value': 'b' } },
    edit: { op, text: op === 'insert-before' ? '{id:"new"},' : ',{id:"new"}' } });
  const src = 'var rows=[{id:"a"},{id:"b"}];';
  assert.equal((await run({ 'chunk-a.js': src }, site('insert-before'))).out['chunk-a.js'], 'var rows=[{id:"a"},{id:"new"},{id:"b"}];');
  assert.equal((await run({ 'chunk-a.js': src }, site('insert-after'))).out['chunk-a.js'], 'var rows=[{id:"a"},{id:"b"},{id:"new"}];');
});

test('edit / several edits from one site', async () => {
  const r = await onF([
    { op: 'prepend-body', text: 'if(!a)return;' },
    { op: 'append-body', text: ';' },
  ], 'function f(a){go(a)}');
  assert.equal(r.out['chunk-a.js'], 'function f(a){if(!a)return;go(a);}');
});

// ── Status ─────────────────────────────────────────────────────────────

test('status / satisfiedWhen: nothing left to change is not a failure', async () => {
  const r = await run({ 'chunk-a.js': 'H("tengu_keys",!0);' }, one({
    id: 'flag', expect: 'required',
    match: { node: 'CallExpression', where: { 'arguments.0.value': 'tengu_keys', 'arguments.1.argument.value': 1 } },
    satisfiedWhen: { node: 'CallExpression', where: { 'arguments.0.value': 'tengu_keys', 'arguments.1.argument.value': 0 } },
    edit: { op: 'replace-field', field: 'arguments.1', text: '!0' },
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.satisfied.map((s) => s.site), ['flag']);
});

test('edit / the marker follows each edit\'s text', async () => {
  const r = await run({ 'chunk-a.js': 'var K=30;' }, one({
    id: 'declaration', match: { node: 'VariableDeclarator' }, edit: { op: 'replace-field', field: 'init', text: '9999' },
  }), { write: true });
  assert.equal(r.out['chunk-a.js'], 'var K=9999/*@cc:demo#declaration*/;');
});

test('verify: a predicate over the written files, captures available', async () => {
  const site = { id: 'declaration', marker: 'K', match: { node: 'VariableDeclarator' },
    capture: { k: 'id.name' }, edit: { op: 'replace-field', field: 'init', text: '9999' } };
  const pass = await run({ 'chunk-a.js': 'var K=30;' }, { sites: [site],
    verify: [{ match: { node: 'VariableDeclarator', where: { 'id.name': '{{k}}', 'init.value': 9999 } }, describe: 'reads 9999' }] },
  { write: true });
  assert.deepEqual(pass.problems, []);
  const fail = await run({ 'chunk-a.js': 'var K=30;' }, { sites: [site],
    verify: [{ match: { node: 'VariableDeclarator', where: { 'id.name': '{{k}}', 'init.value': 1 } }, describe: 'reads 1' }] },
  { write: true });
  assert.deepEqual(fail.problems, ['reads 1']);
});

// ── The template ───────────────────────────────────────────────────────

test('template: validates, and works end to end once its placeholder is real', async () => {
  const path = new URL('../templates/patch.template.json', import.meta.url);
  const template = JSON.parse(await readFile(path, 'utf8'));
  validate(structuredClone(template), 'patch.template.json');

  const src = 'function g(){let s="STABLE_TEXT_NEAR_THE_CODE";return s===x}function h(){return 1}';
  const r = await run({ 'chunk-a.js': src }, template, { write: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
  assert.equal(r.out['chunk-a.js'].replace(MARKER, ''),
    'function g(){let s="STABLE_TEXT_NEAR_THE_CODE";return !0}function h(){return 1}');
});

test('status / expect: a required site that is gone fails the whole patch', async () => {
  const r = await run({ 'chunk-a.js': 'var x=1;' }, one({
    id: 'gone', match: { node: 'Identifier', where: { name: 'nowhere' } }, edit: { op: 'replace', text: 'y' },
  }));
  assert.equal(r.ok, false);
  assert.equal(r.missing, 'gone');
});
