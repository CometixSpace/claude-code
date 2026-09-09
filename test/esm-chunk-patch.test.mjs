import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { patchImportMetaRequire } from '../scripts/esm-chunk-patch.mjs';

test('keeps cyclic tool exports live after module evaluation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-esm-cycle-'));
  try {
    await writeFile(join(dir, 'a.mjs'), [
      'import "./b.mjs";',
      'export const ProposeSkillsTool = { name: "propose_skill" };',
    ].join('\n'));

    const b = patchImportMetaRequire([
      'import "./a.mjs";',
      'const seenTool = import.meta.require("./a.mjs").ProposeSkillsTool;',
      'const seenName = import.meta.require("./a.mjs").SEARCH_TOOL_NAME;',
      'export { seenTool, seenName };',
    ].join('\n')).code;
    await writeFile(join(dir, 'b.mjs'), b);

    const loaded = await import(`${pathToFileURL(join(dir, 'a.mjs'))}?fixture=${Date.now()}`);
    const cycle = await import(`${pathToFileURL(join(dir, 'b.mjs'))}?fixture=${Date.now()}`);
    assert.equal(cycle.seenTool.name, 'propose_skill');
    assert.equal(cycle.seenName, undefined);
    assert.ok(loaded.ProposeSkillsTool);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('does not patch modules without import.meta.require', () => {
  const source = 'export const value = 1;';
  assert.deepEqual(patchImportMetaRequire(source), { code: source, patched: false });
});
