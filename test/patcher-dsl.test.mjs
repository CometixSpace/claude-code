import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import * as acorn from 'acorn';

import { findMatches, captureFrom, resolveSpec } from '../patcher/core/match.mjs';
import { compileEdit, applyEdits, interpolate } from '../patcher/core/edit.mjs';
import { detectLayout, SINGLE, SPLIT } from '../patcher/core/layout.mjs';
import { createScanContext, scanPatch } from '../patcher/core/scan.mjs';
import {
  compilePatch, appliedSites, isApplied, saveOriginals, restoreOriginals,
} from '../patcher/core/apply.mjs';

const parse = (src) => acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });

// mkdtemp hands back /var/... on macOS while the module resolves /private/var,
// so paths compared against the layout have to go through realpath first.
async function tempTree(files) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'patcher-')));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content);
  }
  return dir;
}

test('layout: a small entry beside chunk siblings is split', async () => {
  const dir = await tempTree({
    'cli.js': 'import"./chunk-aaa.js";\n',
    'chunk-aaa.js': 'export const a=1;\n',
    'chunk-bbb.js': 'export const b=2;\n',
  });
  const layout = await detectLayout(join(dir, 'cli.js'));
  assert.equal(layout.layout, SPLIT);
  assert.equal(layout.files.length, 3);
  // The entry leads, so entry-only sites can stop after one file.
  assert.equal(layout.files[0], 'cli.js');
});

test('layout: one large bundle with no chunks is single-file', async () => {
  const dir = await tempTree({ 'cli.js': `//${'x'.repeat(1_100_000)}\n` });
  const layout = await detectLayout(join(dir, 'cli.js'));
  assert.equal(layout.layout, SINGLE);
  assert.deepEqual(layout.files, ['cli.js']);
});

test('match: where tests dotted paths and comparison objects', () => {
  const src = 'function f(a,b){return 1}function g(){return 2}';
  const ast = parse(src);
  const twoParams = findMatches(ast, {
    node: 'FunctionDeclaration',
    where: { 'params.length': 2 },
  }, src);
  assert.equal(twoParams.length, 1);
  assert.equal(twoParams[0].id.name, 'f');

  const small = findMatches(ast, {
    node: 'FunctionDeclaration',
    where: { 'params.length': { lt: 1 } },
  }, src);
  assert.equal(small[0].id.name, 'g');
});

test('match: contains accepts a regex, not just a substring', () => {
  const src = 'function f(){return {argumentHint:  "[hold]"}}';
  const ast = parse(src);
  // Minified source has no stable spacing, which is why a plain substring is
  // not enough here.
  const hit = findMatches(ast, {
    node: 'FunctionDeclaration',
    contains: '/argumentHint:\\s*"\\[hold/',
  }, src);
  assert.equal(hit.length, 1);

  const literal = findMatches(ast, {
    node: 'FunctionDeclaration',
    contains: 'argumentHint:  "[hold]"',
  }, src);
  assert.equal(literal.length, 1, 'a non-regex string still matches literally');
});

test('match: capture reads an identifier out of the match', () => {
  const src = 'let x = cfg.cleanupPeriodDays ?? K;';
  const ast = parse(src);
  const [node] = findMatches(ast, {
    node: 'LogicalExpression',
    where: { operator: '??', 'left.property.name': 'cleanupPeriodDays' },
  }, src);
  assert.deepEqual(captureFrom(node, { constName: 'right.name' }), { constName: 'K' });
});

test('edit: append-body lands inside the closing brace', () => {
  const src = 'function f(){let a=1}';
  const ast = parse(src);
  const [fn] = findMatches(ast, { node: 'FunctionDeclaration' }, src);
  const edit = compileEdit({ op: 'append-body', text: ';b=2' }, fn, {});
  assert.equal(applyEdits(src, [edit]), 'function f(){let a=1;b=2}');
});

test('edit: prepend-body lands just inside the opening brace', () => {
  const src = 'function f(){let a=1}';
  const ast = parse(src);
  const [fn] = findMatches(ast, { node: 'FunctionDeclaration' }, src);
  const edit = compileEdit({ op: 'prepend-body', text: 'if(x)return;' }, fn, {});
  assert.equal(applyEdits(src, [edit]), 'function f(){if(x)return;let a=1}');
});

test('edit: interpolation fails loudly on an uncaptured name', () => {
  assert.equal(interpolate('{{a}}=1', { a: 'K' }), 'K=1');
  assert.throws(() => interpolate('{{missing}}', {}), /never captured/);
});

test('edit: overlapping ranges are rejected rather than silently merged', () => {
  const edits = [
    { start: 0, end: 10, text: 'a', patch: 'p1' },
    { start: 5, end: 15, text: 'b', patch: 'p2' },
  ];
  assert.throws(() => applyEdits('x'.repeat(20), edits), /overlapping edits/);
});

test('edit: several edits to one file apply back to front', () => {
  const src = 'const a=1,b=2;';
  const ast = parse(src);
  const nodes = findMatches(ast, { node: 'Literal', nth: 'all' }, src);
  const edits = nodes.map((n) => compileEdit({ op: 'replace', text: '9' }, n, {}));
  assert.equal(applyEdits(src, edits), 'const a=9,b=9;');
});

test('scan: a later stage can search by what an earlier one captured', async () => {
  const dir = await tempTree({
    'cli.js': 'import"./chunk-a.js";\n',
    'chunk-a.js': 'var K=30;function f(){return (cfg.cleanupPeriodDays??K)*86400}\n',
    'chunk-b.js': 'var K=30;export const unrelated=K;\n',
  });
  const layout = await detectLayout(join(dir, 'cli.js'));
  const ctx = createScanContext(layout);

  const patch = {
    id: 'demo',
    stages: [
      {
        id: 'find',
        sites: [{
          id: 'usage',
          marker: 'cleanupPeriodDays',
          match: { node: 'LogicalExpression', where: { operator: '??', 'left.property.name': 'cleanupPeriodDays' } },
          capture: { constName: 'right.name' },
        }],
      },
      {
        id: 'raise',
        sites: [{
          id: 'decl',
          sameFileAs: 'usage',
          marker: 'cleanupPeriodDays',
          match: { node: 'VariableDeclarator', where: { 'id.name': '{{constName}}', 'init.value': { lte: 365 } } },
          edit: { op: 'replace-field', field: 'init', text: '9999' },
        }],
      },
    ],
  };

  const result = await scanPatch(patch, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.values.constName, 'K');
  // Both sites resolve in chunk-a.js. chunk-b.js declares its own K, and
  // without sameFileAs the second stage would have been free to rewrite it.
  assert.deepEqual([...new Set(result.sites.map((s) => s.file))], ['chunk-a.js']);
});

test('match: has tests a shape inside the node, against its own capture', () => {
  // Both functions build the same object; only one reads <param>.messages[0].
  // That read is the whole distinction, and the parameter's minified name is
  // only known once the function itself is matched.
  const src = 'function acc(e,n){return {type:"C",m:e.messages[0]}}'
    + 'function wrap(e){return {type:"C"}}';
  const ast = parse(src);
  const spec = {
    node: 'FunctionDeclaration',
    contains: '"C"',
    capture: { param: 'params.0.name' },
    has: {
      node: 'MemberExpression',
      where: {
        computed: true,
        'property.value': 0,
        'object.property.name': 'messages',
        'object.object.name': '{{param}}',
      },
    },
    nth: 'all',
  };
  assert.deepEqual(findMatches(ast, spec, src).map((n) => n.id.name), ['acc']);
});

test('match: an unresolved placeholder survives stage-level substitution', () => {
  // Specs are resolved twice — once per stage, then again inside `has`
  // against the node's captures. Collapsing an as-yet-unknown name to
  // undefined on the first pass would leave the subtree unmatchable.
  const spec = { where: { a: '{{known}}', b: '{{later}}' } };
  const resolved = resolveSpec(spec, { known: 'X' });
  assert.equal(resolved.where.a, 'X');
  assert.equal(resolved.where.b, '{{later}}');
});

test('scan: nth:"all" gives each match its own captures', async () => {
  const dir = await tempTree({
    'cli.js': 'import"./chunk-a.js";\n',
    'chunk-a.js': 'function C(x){return 1}var p=[],q=[];p.push(C(s1));q.push(C(s2));\n',
  });
  const layout = await detectLayout(join(dir, 'cli.js'));
  const ctx = createScanContext(layout);

  const result = await scanPatch({
    id: 'demo',
    sites: [{
      id: 'calls',
      marker: 'push',
      match: {
        node: 'CallExpression',
        where: { 'callee.property.name': 'push', 'arguments.0.callee.name': 'C' },
        nth: 'all',
      },
      capture: { arr: 'callee.object.name', state: 'arguments.0.arguments.0.name' },
      edit: { op: 'replace', text: '{{state}}.forEach(m=>{{arr}}.push(m))' },
    }],
  }, ctx);

  assert.equal(result.ok, true);
  assert.equal(result.sites.length, 2);
  // Compiled against the shared set, both rewrites would name the last pair.
  assert.deepEqual(
    result.sites.map((s) => [s.values.arr, s.values.state]),
    [['p', 's1'], ['q', 's2']],
  );
});

test('apply: every edit carries a marker naming its patch and site', () => {
  const src = 'var K=30;var J=40;';
  const ast = parse(src);
  const nodes = findMatches(ast, { node: 'VariableDeclarator', nth: 'all' }, src);
  const patch = { id: 'demo' };
  const result = {
    values: {},
    sites: nodes.map((node, i) => ({
      site: { id: `s${i}`, edit: { op: 'replace-field', field: 'init', text: '1' } },
      file: 'chunk-a.js', node, values: {},
    })),
  };
  const byFile = compilePatch(patch, result);
  const out = applyEdits(src, byFile.get('chunk-a.js'));
  assert.equal(out, 'var K=1/*@cc:demo#s0*/;var J=1/*@cc:demo#s1*/;');
  // Both sites readable off the text, which is what lets status report
  // partial application.
  assert.deepEqual(appliedSites(out, 'demo').sort(), ['s0', 's1']);
  assert.equal(isApplied(out, 'demo'), true);
  assert.equal(isApplied(out, 'other'), false);
});

test('apply: originals are kept once and survive a second patch', async () => {
  const dir = await tempTree({
    'cli.js': 'import"./chunk-a.js";\n',
    'chunk-a.js': 'var K=30;\n',
  });
  const pristine = await readFile(join(dir, 'chunk-a.js'), 'utf8');

  // First run stores the untouched bytes.
  await saveOriginals(dir, new Map([['chunk-a.js', pristine]]), ['p1']);
  await writeFile(join(dir, 'chunk-a.js'), 'var K=9999;\n');

  // Second run sees the file already modified by the first. A per-run
  // snapshot would capture "K=9999" here and restore to that.
  const afterP1 = await readFile(join(dir, 'chunk-a.js'), 'utf8');
  const { added } = await saveOriginals(dir, new Map([['chunk-a.js', afterP1]]), ['p2']);
  assert.deepEqual(added, [], 'the second run must not overwrite the original');

  const { files, patches } = await restoreOriginals(dir);
  assert.deepEqual(files, ['chunk-a.js']);
  assert.deepEqual(patches.sort(), ['p1', 'p2'], 'both owners are recorded');
  assert.equal(await readFile(join(dir, 'chunk-a.js'), 'utf8'), pristine);
});

test('scan: a required site that is absent fails the whole patch', async () => {
  const dir = await tempTree({
    'cli.js': 'import"./chunk-a.js";\n',
    'chunk-a.js': 'var K=30;\n',
  });
  const layout = await detectLayout(join(dir, 'cli.js'));
  const ctx = createScanContext(layout);

  const result = await scanPatch({
    id: 'demo',
    sites: [{
      id: 'gone',
      marker: 'K',
      match: { node: 'CallExpression', where: { 'callee.name': 'nowhere' } },
      expect: 'required',
    }],
  }, ctx);

  assert.equal(result.ok, false);
  assert.equal(result.missing, 'gone');
});

test('scan: each file is read and parsed once across every site', async () => {
  const dir = await tempTree({
    'cli.js': 'import"./chunk-a.js";\n',
    'chunk-a.js': 'var K=30;var J=40;\n',
  });
  const layout = await detectLayout(join(dir, 'cli.js'));
  const ctx = createScanContext(layout);

  await scanPatch({
    id: 'demo',
    sites: [
      { id: 's1', marker: 'K', match: { node: 'VariableDeclarator', where: { 'id.name': 'K' } } },
      { id: 's2', marker: 'J', match: { node: 'VariableDeclarator', where: { 'id.name': 'J' } } },
    ],
  }, ctx);

  // Two sites, one parse — this is what replaces 35 separate full-tree walks.
  assert.equal(ctx.asts.size, 1);
  assert.equal(ctx.sources.size, 2);
});
