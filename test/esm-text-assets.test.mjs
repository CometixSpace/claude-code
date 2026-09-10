import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { BUNFS_ROOTS } from '../scripts/bun-sea-extract.mjs';
import { patchImportMetaRequire, rewriteBunfsPaths } from '../scripts/esm-chunk-patch.mjs';

const execFileAsync = promisify(execFile);

for (const bunfsRoot of BUNFS_ROOTS) {
  for (const nested of [false, true]) {
    test(`loads text independently of cwd (${bunfsRoot}, ${nested ? 'nested' : 'flat'})`, async (t) => {
      // realpath, because require.resolve() reports the resolved path while
      // mkdtemp does not — on macOS tmpdir() is a symlink into /private/var,
      // so comparing the two verbatim fails for a reason the test is not about.
      const dir = await realpath(await mkdtemp(join(tmpdir(), 'cc-text-assets-')));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const packageDir = join(dir, 'package with spaces #资源');
      const moduleDir = nested ? join(packageDir, 'chunks') : packageDir;
      const assetDir = join(packageDir, 'assets');
      const projectDir = join(dir, 'project');
      await Promise.all([moduleDir, assetDir, projectDir].map((p) => mkdir(p, { recursive: true })));

      const markdown = '# Packaged prompt\n你好\n';
      const template = 'Template: {{value}}\n';
      const data = { source: 'package' };
      await Promise.all([
        writeFile(join(assetDir, 'prompt.md'), markdown),
        writeFile(join(assetDir, 'template.txt'), template),
        writeFile(join(assetDir, 'data.json'), JSON.stringify(data)),
        writeFile(join(moduleDir, 'runtime.mjs'), patchImportMetaRequire(
          'export const load = import.meta.require;',
        ).code),
      ]);

      // Match the bundle's exported require alias and the E1/E2 path rewrite.
      // Absolute text paths and ordinary module loads must keep working too.
      const source = [
        'import { load } from "./runtime.mjs";',
        'console.log(JSON.stringify([',
        `load("${bunfsRoot}assets/prompt.md"),`,
        `load("${bunfsRoot}assets/template.txt"),`,
        `load("${bunfsRoot}assets/data.json"),`,
        `load(${JSON.stringify(join(assetDir, 'prompt.md'))}),`,
        `load.resolve("${bunfsRoot}assets/prompt.md"),`,
        ']));',
      ].join('\n');
      const entry = join(moduleDir, 'entry.mjs');
      await writeFile(entry, rewriteBunfsPaths(source, nested ? '../' : './').code);
      const expected = [markdown, template, data, markdown, join(assetDir, 'prompt.md')];
      async function check(cwd) {
        const { stdout } = await execFileAsync(process.execPath, [entry], { cwd, timeout: 15000 });
        assert.deepEqual(JSON.parse(stdout), expected, `assets read from ${cwd}`);
      }

      await check(moduleDir);
      await check(projectDir);

      // A user's same-named files must never replace the bundled prompts.
      // Cover both ./assets and ../assets relative to the external cwd.
      for (const shadowDir of [join(projectDir, 'assets'), join(dir, 'assets')]) {
        await mkdir(shadowDir);
        await writeFile(join(shadowDir, 'prompt.md'), 'Wrong cwd prompt');
        await writeFile(join(shadowDir, 'template.txt'), 'Wrong cwd template');
      }
      await check(projectDir);
    });
  }
}
