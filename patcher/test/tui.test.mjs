import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';

import { openInstall } from '../core/session.mjs';
import { initialDesired, toggle, rowState, pending } from '../tui/model.mjs';
import { App } from '../tui/app.mjs';

// ──────────────────────────────────────────────
//  The picker: its rules, then the component driven by keys
//
//  The rules live in tui/model.mjs and are tested as plain functions. The
//  component is rendered with ink-testing-library against a real synthetic
//  install, so a keypress goes all the way to files on disk.
// ──────────────────────────────────────────────

function setVar(id, name, value, extra = {}) {
  return {
    id,
    title: `set ${name}`,
    description: `Rewrites ${name}.`,
    risk: 'low',
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
  setVar('old', 'D', 40, { versions: '<2.0.0' }),
];

async function install() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'tui-')));
  await writeFile(join(dir, 'cli.js'), 'import"./chunk-a.js";\n');
  await writeFile(join(dir, 'chunk-a.js'), 'var A=1;var B=2;var C=3;var D=4;\n');
  await writeFile(join(dir, 'package.json'), '{"version":"2.1.280"}\n');
  return openInstall(join(dir, 'cli.js'), { patches: PATCHES, selectionFile: join(dir, 'selection.json') });
}

const plain = (s) => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '');
const pause = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function until(ui, predicate, what, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate(plain(ui.lastFrame()))) return plain(ui.lastFrame());
    await pause(20);
  }
  assert.fail(`timed out waiting for ${what}; last frame:\n${plain(ui.lastFrame())}`);
}

async function press(ui, keys) {
  ui.stdin.write(keys);
  await pause();
}

// ── Rules ──────────────────────────────────────────────────────────────

test('model: ticking pulls in requirements, unticking drops dependents', async () => {
  const i = await install();
  let r = toggle(i, new Set(), 'b');
  assert.deepEqual([...r.desired].sort(), ['a', 'b']);
  assert.match(r.note, /also ticked a, required by b/);
  r = toggle(i, r.desired, 'a');
  assert.deepEqual([...r.desired], []);
  assert.match(r.note, /also unticked b, which requires a/);
});

test('model: a patch outside its version range cannot be ticked', async () => {
  const i = await install();
  const r = toggle(i, new Set(), 'old');
  assert.equal(r.desired.size, 0);
  assert.match(r.note, /needs Claude Code <2\.0\.0/);
  assert.equal(rowState(i, r.desired, 'old'), 'skipped');
});

test('model: the memory ticks the last choice when nothing is applied', async () => {
  const i = await install();
  i.remembered = { ids: ['b', 'old', 'gone'], version: '2.1.279' };
  // Requirements come back with it; ids this install cannot take do not.
  assert.deepEqual([...initialDesired(i)].sort(), ['a', 'b']);
  assert.deepEqual(pending(i, initialDesired(i)).add, ['a', 'b']);
});

// ── Component ──────────────────────────────────────────────────────────

test('tui: keys arriving together are each applied', async () => {
  const i = await install();
  const ui = render(React.createElement(App, { install: i }));
  await until(ui, (f) => f.includes('no changes'), 'first frame');
  // Cursor down twice, then tick — as one chunk, the way a held key or a
  // paste arrives.
  await press(ui, 'jj ');
  const frame = await until(ui, (f) => f.includes('pending'), 'pending line');
  assert.match(frame, /\[\+\] c/);
  assert.match(frame, /pending \+c/);
  ui.unmount();
});

test('tui: apply writes the ticks, and removal asks first', async () => {
  const i = await install();
  const ui = render(React.createElement(App, { install: i }));
  await until(ui, (f) => f.includes('no changes'), 'first frame');

  await press(ui, 'j ');
  await until(ui, (f) => f.includes('also ticked a'), 'the requirement note');
  await press(ui, 'a');
  await until(ui, (f) => f.includes('applied 2 patch(es)'), 'the apply to finish');
  assert.match(await readFile(join(i.layout.root, 'chunk-a.js'), 'utf8'), /var A=10.*var B=20/);

  // Untick a: b goes with it, and taking patches out needs confirming.
  await press(ui, 'k ');
  await until(ui, (f) => f.includes('−a −b'), 'the removal to be pending');
  await press(ui, 'a');
  await until(ui, (f) => f.includes('Continue?'), 'the question');
  await press(ui, 'y');
  const frame = await until(ui, (f) => f.includes('restored') && f.includes('no changes'), 'the restore');
  assert.match(frame, /\[ \] a/);
  assert.equal(await readFile(join(i.layout.root, 'chunk-a.js'), 'utf8'), 'var A=1;var B=2;var C=3;var D=4;\n');
  ui.unmount();
});

test('tui: quitting leaves a one-line summary', async () => {
  const i = await install();
  const ui = render(React.createElement(App, { install: i }));
  await until(ui, (f) => f.includes('no changes'), 'first frame');
  await press(ui, 'q');
  const frame = await until(ui, (f) => f.includes('no patches applied'), 'the summary');
  assert.doesNotMatch(frame, /space toggle/, 'the list is gone');
});
