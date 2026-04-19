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
    engines: { node: '>=18.0.0' },
    scripts: { postinstall: 'node install.cjs' },
    author: 'Anthropic <support@anthropic.com>',
    license: 'SEE LICENSE IN README.md',
    description: 'Claude Code restored for Node.js runtime.',
    homepage: 'https://github.com/CometixSpace/claude-code',
    bugs: { url: 'https://github.com/CometixSpace/claude-code/issues' },
    dependencies: {
      ws: '^8.18.0',
      yaml: '^2.7.0',
      undici: '^7.3.0',
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
      'sdk-tools.d.ts',
    ],
  };

  await writeFile(join(outputDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  console.log('[OK] package.json');

  // 2. install.cjs (from template)
  const installTemplate = readFileSync(join(__dirname, '..', 'templates', 'install.cjs'), 'utf8');
  await writeFile(join(outputDir, 'install.cjs'), installTemplate);
  console.log('[OK] install.cjs');

  // 3. cli.js placeholder
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
