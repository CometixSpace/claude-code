import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, realpath, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import {
  openInstall, applyPatches, reconcile, planChange, restoreAll, withoutIds,
} from '../core/session.mjs';
import { withRequires, dependentsOf, checkRequires } from '../core/registry.mjs';
import { readSelection } from '../core/selection.mjs';

// ──────────────────────────────────────────────
//  core/session.mjs — the operations behind both front ends
//
//  Each test builds a small split install and a handful of patches that edit
//  it, so what matters — order of operations, what is on disk after a
//  failure, what gets remembered — is checked against real files.
// ──────────────────────────────────────────────

const PRISTINE = {
  'cli.js': 'import"./chunk-a.js";\n',
  'chunk-a.js': 'var A=1;var B=2;var C=3;\n',
  'chunk-b.js': 'var D=4;\n',
  'package.json': '{"version":"2.1.280"}\n',
};

// One patch per variable: rewrites `var <name>=n` to `var <name>=<value>`.
function setVar(id, name, value, extra = {}) {
  return {
    id,
    title: id,
    sites: [{
      id: 'decl',
      marker: `var ${name}=`,
      match: { node: 'VariableDeclarator', where: { 'id.name': name } },
      edit: { op: 'replace-field', field: 'init', text: String(value) },
    }],
    ...extra,
  };
}

const PATCHES = [
  setVar('a', 'A', 10),
  setVar('b', 'B', 20, { requires: ['a'] }),
  setVar('c', 'C', 30),
  setVar('d', 'D', 40),
];

async function install(patches = PATCHES, files = PRISTINE) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'session-')));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  const selectionFile = join(dir, '..', `${basename(dir)}-selection.json`);
  return openInstall(join(dir, 'cli.js'), { patches, selectionFile });
}

const read = (i, f) => readFile(join(i.layout.root, f), 'utf8');
const strip = (s) => s.replace(/\/\*@cc:[^*]*\*\//g, '');

// ── requires ───────────────────────────────────────────────────────────

test('requires: a selection is closed over what it needs, and says why', () => {
  const { ids, pulled } = withRequires(PATCHES, ['b']);
  assert.deepEqual(ids, ['a', 'b']);
  assert.equal(pulled.get('a'), 'b');
  assert.equal(withRequires(PATCHES, ['b', 'a']).pulled.size, 0, 'asked for explicitly is not "pulled"');
});

test('requires: removing a patch takes what requires it along', () => {
  assert.deepEqual(dependentsOf(PATCHES, ['a']), ['b']);
  assert.deepEqual(dependentsOf(PATCHES, ['c']), []);
});

test('requires: a dangling id is caught when the set is loaded', () => {
  assert.throws(() => checkRequires([setVar('x', 'X', 1, { requires: ['nope'] })]), /requires "nope"/);
});

// ── apply ──────────────────────────────────────────────────────────────

test('apply: pulls in what is required, writes, and remembers the result', async () => {
  const i = await install();
  const report = await applyPatches(i, ['b']);
  assert.deepEqual(report.applied, ['a', 'b']);
  assert.equal(report.pulled.get('a'), 'b');
  assert.equal(strip(await read(i, 'chunk-a.js')), 'var A=10;var B=20;var C=3;\n');
  assert.deepEqual([...i.applied.keys()], ['a', 'b'], 'the install object is refreshed');
  assert.deepEqual((await readSelection(i.key, i.selectionFile)).ids, ['a', 'b']);
});

test('apply: a rewrite that cannot be written leaves every file untouched', async () => {
  // Two patches editing the same node overlap. The first file in the plan
  // is fine on its own; the failure has to stop it being written too.
  const clash = [setVar('d', 'D', 40), setVar('a1', 'A', 11), setVar('a2', 'A', 12)];
  const i = await install(clash);
  await assert.rejects(applyPatches(i, ['d', 'a1', 'a2']), /overlapping edits/);
  assert.equal(await read(i, 'chunk-a.js'), PRISTINE['chunk-a.js']);
  assert.equal(await read(i, 'chunk-b.js'), PRISTINE['chunk-b.js']);
  await assert.rejects(stat(join(i.layout.root, '.claude-patcher/originals/manifest.json')),
    'no originals recorded for a run that wrote nothing');
});

test('apply: an asset that cannot be installed takes back the ones before it', async () => {
  const assetRoot = await realpath(await mkdtemp(join(tmpdir(), 'assets-')));
  await mkdir(join(assetRoot, 'good'), { recursive: true });
  await writeFile(join(assetRoot, 'good', 'index.js'), 'ok');
  const patches = [
    setVar('a', 'A', 10, { assets: [{ from: 'good', to: 'vendor/good', localRoot: assetRoot }] }),
    setVar('c', 'C', 30, { assets: [{ from: 'missing', to: 'vendor/missing', localRoot: assetRoot }] }),
  ];
  const i = await install(patches);
  await assert.rejects(applyPatches(i, ['a', 'c']), /asset "missing"/);
  await assert.rejects(stat(join(i.layout.root, 'vendor/good/index.js')), 'the good asset was removed again');
  assert.equal(await read(i, 'chunk-a.js'), PRISTINE['chunk-a.js'], 'no code was written');
});

test('apply: verification uses the patch\'s own files and reports by describe', async () => {
  const patches = [
    setVar('a', 'A', 10, { verify: [{ match: { node: 'VariableDeclarator', where: { 'id.name': 'A', 'init.value': 10 } }, describe: 'A is 10' }] }),
    setVar('d', 'D', 40, { verify: [{ match: { node: 'VariableDeclarator', where: { 'id.name': 'A', 'init.value': 10 } }, describe: 'A is 10, seen from d' }] }),
  ];
  const i = await install(patches);
  const report = await applyPatches(i, ['a', 'd']);
  // d wrote chunk-b.js only; A lives in chunk-a.js, so d's check must fail.
  assert.deepEqual(report.verify, [{ id: 'd', problems: ['A is 10, seen from d'] }]);
});

// ── reconcile ──────────────────────────────────────────────────────────

test('reconcile: additions go on top, nothing is restored', async () => {
  const i = await install();
  await applyPatches(i, ['c']);
  const { plan, restored, report } = await reconcile(i, ['c', 'd']);
  assert.equal(plan.restoreFirst, false);
  assert.equal(restored, null);
  assert.deepEqual(report.applied, ['d']);
  assert.deepEqual([...i.applied.keys()].sort(), ['c', 'd']);
});

test('reconcile: a removal restores, then re-applies what stays', async () => {
  const i = await install();
  await applyPatches(i, ['a', 'c', 'd']);
  const events = [];
  const { plan, restored } = await reconcile(i, ['a', 'd'], { onEvent: (e) => events.push(e.type) });
  assert.deepEqual(plan.remove, ['c']);
  assert.ok(restored.files.length > 0);
  assert.ok(events.indexOf('restored') < events.indexOf('scanned'), 'restored is reported before the re-scan');
  assert.equal(strip(await read(i, 'chunk-a.js')), 'var A=10;var B=2;var C=3;\n');
  assert.equal(strip(await read(i, 'chunk-b.js')), 'var D=40;\n');
  assert.deepEqual([...i.applied.keys()].sort(), ['a', 'd']);
});

test('reconcile: a patch whose markers were disturbed is repaired', async () => {
  const two = {
    id: 'two',
    title: 'two',
    sites: [
      { id: 'x', marker: 'var A=', match: { node: 'VariableDeclarator', where: { 'id.name': 'A' } }, edit: { op: 'replace-field', field: 'init', text: '10' } },
      { id: 'y', marker: 'var D=', match: { node: 'VariableDeclarator', where: { 'id.name': 'D' } }, edit: { op: 'replace-field', field: 'init', text: '40' } },
    ],
  };
  const i = await install([two]);
  await applyPatches(i, ['two']);
  // Something rewrote chunk-b.js over the top: one site's marker is gone.
  await writeFile(join(i.layout.root, 'chunk-b.js'), 'var D=4;\n');
  const reopened = await openInstall(i.cli, { patches: [two], selectionFile: i.selectionFile });
  assert.deepEqual(planChange(reopened, ['two']).repair, ['two']);

  await reconcile(reopened, ['two']);
  assert.equal(strip(await read(reopened, 'chunk-b.js')), 'var D=40;\n');
  assert.deepEqual(reopened.applied.get('two').sites.sort(), ['x', 'y']);
});

test('reconcile: a dry run never restores', async () => {
  const i = await install();
  await applyPatches(i, ['c']);
  const before = await read(i, 'chunk-a.js');
  const { restored, report } = await reconcile(i, ['d'], { dryRun: true });
  assert.equal(restored, null);
  assert.deepEqual(report.applied, ['d'], 'the addition is checked');
  assert.equal(await read(i, 'chunk-a.js'), before, 'c is still applied');
});

test('remove: what requires the removed patch goes too', async () => {
  const i = await install();
  await applyPatches(i, ['b', 'c']);
  const { keep, also } = withoutIds(i, ['a']);
  assert.deepEqual(also, ['b']);
  assert.deepEqual(keep, ['c']);
});

test('restore: remembers that nothing is applied now', async () => {
  const i = await install();
  await applyPatches(i, ['c']);
  await restoreAll(i);
  assert.equal(await read(i, 'chunk-a.js'), PRISTINE['chunk-a.js']);
  assert.deepEqual((await readSelection(i.key, i.selectionFile)).ids, []);
});

test('memory: survives the package being replaced underneath', async () => {
  const i = await install();
  await applyPatches(i, ['a', 'd']);
  // npm replaces the package directory — patched files and state with it.
  for (const [name, text] of Object.entries(PRISTINE)) await writeFile(join(i.layout.root, name), text);
  await rm(join(i.layout.root, '.claude-patcher'), { recursive: true });

  const again = await openInstall(i.cli, { patches: PATCHES, selectionFile: i.selectionFile });
  assert.equal(again.applied.size, 0);
  assert.deepEqual(again.remembered.ids, ['a', 'd']);
});
