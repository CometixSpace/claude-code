import { mkdir, writeFile, copyFile, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';

// Platform key → vendor directory name mapping
// SEA platform key "darwin-arm64" → vendor dir "arm64-darwin"
function vendorDir(platformKey) {
  const parts = platformKey.split('-');
  if (parts.length === 3) return null; // musl — no audio-capture
  return `${parts[1]}-${parts[0]}`;
}

// seccomp arch dir
function seccompArch(platformKey) {
  if (!platformKey.startsWith('linux')) return null;
  return platformKey.includes('arm64') ? 'arm64' : 'x64';
}

export async function buildPlatformPackage({
  platform,           // e.g. "darwin-arm64"
  version,
  patchedCliPath,     // path to patched cli.js
  extractDir,         // SEA extract dir (for audio-capture.node)
  ripgrepDir,         // ripgrep binaries root
  seccompDir,         // seccomp binaries root (or null)
  outputDir,          // output directory for this platform package
}) {
  await mkdir(outputDir, { recursive: true });

  // Determine npm os/cpu fields
  const parts = platform.split('-');
  let os, cpu;
  if (platform === 'android-arm64') {
    os = 'android'; cpu = 'arm64';
  } else if (parts.length === 3) {
    // linux-arm64-musl → os=linux, cpu=arm64
    os = parts[0]; cpu = parts[1];
  } else {
    os = parts[0]; cpu = parts[1];
  }

  // 1. Copy patched cli.js
  await copyFile(patchedCliPath, join(outputDir, 'cli.js'));
  await chmod(join(outputDir, 'cli.js'), 0o755);
  console.log(`  [OK] cli.js`);

  // 2. vendor/audio-capture + computer-use-swift + computer-use-input
  const vd = vendorDir(platform === 'android-arm64' ? 'linux-arm64' : platform);
  const napiModules = [
    'audio-capture',
    'computer-use-swift',
    'computer-use-input',
  ];
  if (vd && extractDir) {
    for (const mod of napiModules) {
      const src = join(extractDir, `${mod}.node`);
      try {
        await stat(src);
        const dest = join(outputDir, 'vendor', mod, vd);
        await mkdir(dest, { recursive: true });
        await copyFile(src, join(dest, `${mod}.node`));
        console.log(`  [OK] vendor/${mod}/${vd}/`);
      } catch {}
    }
  }

  // 3. vendor/ripgrep
  if (ripgrepDir) {
    const rgVd = vd || (platform.includes('arm64') ? 'arm64-linux' : 'x64-linux');
    const rgBin = platform.startsWith('win32') ? 'rg.exe' : 'rg';
    const src = join(ripgrepDir, rgVd, rgBin);
    try {
      await stat(src);
      const dest = join(outputDir, 'vendor', 'ripgrep', rgVd);
      await mkdir(dest, { recursive: true });
      await copyFile(src, join(dest, rgBin));
      if (!rgBin.endsWith('.exe')) await chmod(join(dest, rgBin), 0o755);
      console.log(`  [OK] vendor/ripgrep/${rgVd}/`);
    } catch {
      console.log(`  [!]  vendor/ripgrep/${rgVd}/ — not found`);
    }
    // COPYING
    try {
      await copyFile(join(ripgrepDir, 'COPYING'), join(outputDir, 'vendor', 'ripgrep', 'COPYING'));
    } catch {}
  }

  // 4. vendor/seccomp
  const sa = seccompArch(platform);
  if (sa && seccompDir) {
    const src = join(seccompDir, sa, 'apply-seccomp');
    try {
      await stat(src);
      const dest = join(outputDir, 'vendor', 'seccomp', sa);
      await mkdir(dest, { recursive: true });
      await copyFile(src, join(dest, 'apply-seccomp'));
      console.log(`  [OK] vendor/seccomp/${sa}/`);
    } catch {}
  }

  // 5. package.json
  const pkg = {
    name: `@cometix/claude-code-${platform}`,
    version,
    description: `Claude Code Node.js restored — ${platform}`,
    os: [os],
    cpu: [cpu],
    files: ['cli.js', 'vendor/'],
    repository: { type: 'git', url: 'https://github.com/CometixSpace/claude-code.git' },
    license: 'SEE LICENSE IN README.md',
  };
  await writeFile(join(outputDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  [OK] package.json`);

  return { platform, outputDir };
}
