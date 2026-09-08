import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ALL_PLATFORMS = [
  'darwin-arm64', 'darwin-x64',
  'linux-arm64', 'linux-x64',
  'linux-arm64-musl', 'linux-x64-musl',
  'win32-arm64', 'win32-x64',
  'android-arm64',
];

export async function buildMainPackage({
  version,
  splitEsm = false,
  wrapperDir,   // npm wrapper package dir (for sdk-tools.d.ts, LICENSE, README)
  outputDir,
}) {
  await mkdir(outputDir, { recursive: true });

  // 1. package.json
  const optDeps = {};
  for (const p of ALL_PLATFORMS) {
    optDeps[`@cometix/claude-code-${p}`] = version;
  }

  const pkg = {
    name: '@cometix/claude-code',
    version,
    bin: { claude: 'cli.js' },
    // Split builds ship ESM chunks; postinstall drops them next to cli.js,
    // so the package has to be typed as a module for Node to load them.
    ...(splitEsm ? { type: 'module' } : {}),
    // `using` / `await using` (explicit resource management) reaches Node in
    // 24 — 67 sites across 20 chunks on 2.1.251, and Node 20 rejects them at
    // parse time. zstd in node:zlib lands earlier, in 22.15, so 24 covers both.
    engines: { node: '>=24.0.0' },
    scripts: { postinstall: 'node install.cjs' },
    author: 'Anthropic <support@anthropic.com>',
    license: 'SEE LICENSE IN README.md',
    description: 'Claude Code restored for Node.js runtime.',
    homepage: 'https://github.com/CometixSpace/claude-code',
    repository: { type: 'git', url: 'https://github.com/CometixSpace/claude-code.git' },
    bugs: { url: 'https://github.com/CometixSpace/claude-code/issues' },
    dependencies: {
      ws: '^8.18.0',
      yaml: '^2.7.0',
      undici: '^7.3.0',
      semver: '^7.6.3',
      'node-pty': '^1.1.0',
      // Backs Bun.TOML, which has no Node equivalent — see the polyfill.
      'smol-toml': '^1.8.0',
    },
    optionalDependencies: {
      ...optDeps,
      '@img/sharp-darwin-arm64': '^0.34.2',
      '@img/sharp-darwin-x64': '^0.34.2',
      '@img/sharp-linux-arm': '^0.34.2',
      '@img/sharp-linux-arm64': '^0.34.2',
      '@img/sharp-linux-x64': '^0.34.2',
      '@img/sharp-linuxmusl-arm64': '^0.34.2',
      '@img/sharp-linuxmusl-x64': '^0.34.2',
      '@img/sharp-win32-arm64': '^0.34.2',
      '@img/sharp-win32-x64': '^0.34.2',
    },
    files: [
      'cli.js',
      'install.cjs',
      'bun-ink-compat.cjs',
      'sdk-tools.d.ts',
      // Written by postinstall from the platform package. Listed so `npm pack`
      // keeps them if the tree is ever staged before publishing.
      ...(splitEsm ? ['chunk-*.js', 'bun-polyfill.mjs', 'src/', 'vendor/'] : []),
    ],
  };

  await writeFile(join(outputDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  console.log('[OK] package.json');

  // 2. install.cjs (from template)
  const installTemplate = readFileSync(join(__dirname, '..', 'templates', 'install.cjs'), 'utf8');
  await writeFile(join(outputDir, 'install.cjs'), installTemplate);
  console.log('[OK] install.cjs');

  // 3. bun-ink-compat.cjs (compiled ANSI/width/wrap from Anthropic source)
  const inkCompat = readFileSync(join(__dirname, '..', 'templates', 'bun-ink-compat.cjs'));
  await writeFile(join(outputDir, 'bun-ink-compat.cjs'), inkCompat);
  console.log('[OK] bun-ink-compat.cjs');

  // 4. cli.js placeholder
  const placeholder = readFileSync(join(__dirname, '..', 'templates', 'cli-placeholder.js'), 'utf8');
  await writeFile(join(outputDir, 'cli.js'), placeholder);
  console.log('[OK] cli.js (placeholder)');

  // 4. Copy sdk-tools.d.ts, LICENSE.md, README.md from wrapper
  if (wrapperDir) {
    for (const file of ['sdk-tools.d.ts', 'LICENSE.md', 'README.md']) {
      try {
        await copyFile(join(wrapperDir, file), join(outputDir, file));
        console.log(`[OK] ${file}`);
      } catch {
        console.log(`[!]  ${file} not found`);
      }
    }
  }

  return { outputDir };
}
