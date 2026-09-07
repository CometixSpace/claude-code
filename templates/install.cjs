#!/usr/bin/env node
const { copyFileSync, mkdirSync, readdirSync, statSync, existsSync } = require('fs');
const path = require('path');

const PACKAGE_PREFIX = '@cometix/claude-code';

const PLATFORMS = {
  'darwin-arm64':  { pkg: PACKAGE_PREFIX + '-darwin-arm64' },
  'darwin-x64':    { pkg: PACKAGE_PREFIX + '-darwin-x64' },
  'linux-arm64':   { pkg: PACKAGE_PREFIX + '-linux-arm64' },
  'linux-x64':     { pkg: PACKAGE_PREFIX + '-linux-x64' },
  'linux-arm64-musl': { pkg: PACKAGE_PREFIX + '-linux-arm64-musl' },
  'linux-x64-musl':  { pkg: PACKAGE_PREFIX + '-linux-x64-musl' },
  'win32-arm64':   { pkg: PACKAGE_PREFIX + '-win32-arm64' },
  'win32-x64':     { pkg: PACKAGE_PREFIX + '-win32-x64' },
  'android-arm64': { pkg: PACKAGE_PREFIX + '-android-arm64' },
};

function detectMusl() {
  if (process.platform !== 'linux') return false;
  try {
    const report = typeof process.report?.getReport === 'function'
      ? process.report.getReport() : null;
    return report != null && report.header?.glibcVersionRuntime === undefined;
  } catch { return false; }
}

function getPlatformKey() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'linux' && detectMusl()) return `linux-${arch}-musl`;
  if (platform === 'android') return `android-${arch}`;
  return `${platform}-${arch}`;
}

function copyDirSync(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

function main() {
  const platformKey = getPlatformKey();
  const info = PLATFORMS[platformKey];

  if (!info) {
    console.error(`[@cometix/claude-code postinstall] Unsupported platform: ${process.platform} ${process.arch}`);
    console.error(`  Supported: ${Object.keys(PLATFORMS).join(', ')}`);
    return;
  }

  let pkgDir;
  try {
    pkgDir = path.dirname(require.resolve(info.pkg + '/package.json'));
  } catch {
    console.error(`[@cometix/claude-code postinstall] Platform package "${info.pkg}" not found.`);
    console.error('  This happens with --omit=optional or when the download failed.');
    console.error('  The `claude` command will show an error when invoked.');
    return;
  }

  const dest = __dirname;

  // Copy everything the platform package ships except its own package.json,
  // which would overwrite the main package's manifest.
  //
  // On single-CJS builds that is cli.js plus vendor/. On split-ESM builds
  // (v2.1.242+) it is also the ~1375 chunk-*.js modules and bun-polyfill.mjs,
  // which cli.js imports through relative specifiers and therefore must sit
  // in the same directory.
  try {
    for (const entry of readdirSync(pkgDir)) {
      if (entry === 'package.json') continue;
      const src = path.join(pkgDir, entry);
      const target = path.join(dest, entry);
      if (statSync(src).isDirectory()) copyDirSync(src, target);
      else copyFileSync(src, target);
    }
  } catch (err) {
    console.error(`[@cometix/claude-code postinstall] Failed to copy package files: ${err.message}`);
    return;
  }

  // copyFileSync carries the source mode over, and npm may have stripped +x
  // from the platform tarball, so restore it on the bin entry.
  try {
    require('fs').chmodSync(path.join(dest, 'cli.js'), 0o755);
  } catch {}

  // Fix node-pty spawn-helper execute permission.
  // npm strips +x from non-bin files; without it pty.spawn() fails
  // with "posix_spawnp failed" on unix. Windows uses .exe (no chmod needed).
  try {
    const { chmodSync } = require('fs');
    const search = [
      path.join(dest, 'node_modules', 'node-pty', 'prebuilds'),
      path.join(dest, '..', 'node-pty', 'prebuilds'),
    ];
    for (const dir of search) {
      if (!existsSync(dir)) continue;
      for (const plat of readdirSync(dir)) {
        const h = path.join(dir, plat, 'spawn-helper');
        if (existsSync(h)) chmodSync(h, 0o755);
      }
    }
  } catch {}
}

main();
