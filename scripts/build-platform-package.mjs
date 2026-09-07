import { mkdir, writeFile, copyFile, stat, chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Platform key → vendor directory name mapping
// SEA platform key "darwin-arm64" → vendor dir "arm64-darwin"
function vendorDir(platformKey) {
  const parts = platformKey.split('-');
  if (parts.length === 3) return null; // musl — no audio-capture
  return `${parts[1]}-${parts[0]}`;
}

// Static assets the code opens with fs.readFile rather than importing:
// bundled artifact runtimes (*.min.js) and the design-canvas template
// (*.asset). They ship under vendor/assets/ on every platform.
const ASSET_RE = /\.(?:min\.js|asset)$/;

async function listAssetFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && !e.name.startsWith('.') && ASSET_RE.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// seccomp arch dir
function seccompArch(platformKey) {
  if (!platformKey.startsWith('linux')) return null;
  return platformKey.includes('arm64') ? 'arm64' : 'x64';
}

// Split-ESM builds ship the whole module tree. Everything that is not a
// native module or a static asset (both of which land under vendor/) belongs
// next to the entry, keeping the "./chunk-x.js" specifiers valid.
async function copyModuleTree(srcDir, destDir, skip) {
  let copied = 0;
  for (const entry of await readdir(srcDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    if (entry.isDirectory()) {
      await mkdir(dest, { recursive: true });
      copied += await copyModuleTree(src, dest, skip);
    } else if (!skip.has(entry.name)) {
      await mkdir(destDir, { recursive: true });
      await copyFile(src, dest);
      copied++;
    }
  }
  return copied;
}

export async function buildPlatformPackage({
  platform,           // e.g. "darwin-arm64"
  version,
  splitEsm = false,   // v2.1.242+: ESM entry plus ~1375 sibling chunks
  patchedCliPath,     // single-CJS builds: path to the patched cli.js
  entryRel,           // split-ESM builds: entry path relative to extractDir
  extractDir,         // SEA extract dir (native modules, assets, chunks)
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

  const napiModules = [
    'audio-capture',
    'computer-use-swift',
    'computer-use-input',
    'image-processor',
    'url-handler',
  ];

  // 1. Entry point (+ the rest of the module tree on split builds)
  if (splitEsm) {
    // Native modules and assets are copied into vendor/ below; the patched
    // code resolves them from there, so they must not also sit at the root.
    const skip = new Set(napiModules.map((m) => `${m}.node`));
    for (const asset of await listAssetFiles(extractDir)) skip.add(asset);
    const copied = await copyModuleTree(extractDir, outputDir, skip);
    await chmod(join(outputDir, entryRel), 0o755);
    console.log(`  [OK] module tree (${copied} files, entry ${entryRel})`);
  } else {
    await copyFile(patchedCliPath, join(outputDir, 'cli.js'));
    await chmod(join(outputDir, 'cli.js'), 0o755);
    console.log(`  [OK] cli.js`);
  }

  // 2. vendor/audio-capture + computer-use-swift + computer-use-input
  const vd = vendorDir(platform === 'android-arm64' ? 'linux-arm64' : platform);
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

  // 2b. vendor/assets — BunFS static files read via fs.readFile, not import:
  // the artifact runtimes (chart/hljs/mermaid) and, from v2.1.229+, the
  // design-canvas payload template. Platform-independent, so musl gets them
  // too even though vd is null there and the NAPI copy above is skipped.
  if (extractDir) {
    const assetDest = join(outputDir, 'vendor', 'assets');
    let copied = 0;
    for (const name of await listAssetFiles(extractDir)) {
      try {
        await mkdir(assetDest, { recursive: true });
        await copyFile(join(extractDir, name), join(assetDest, name));
        copied++;
      } catch {}
    }
    if (copied) console.log(`  [OK] vendor/assets/ (${copied} files)`);
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
