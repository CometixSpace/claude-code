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
  const srcCli = path.join(pkgDir, 'cli.js');
  const srcVendor = path.join(pkgDir, 'vendor');

  // Copy cli.js
  try {
    copyFileSync(srcCli, path.join(dest, 'cli.js'));
  } catch (err) {
    console.error(`[@cometix/claude-code postinstall] Failed to copy cli.js: ${err.message}`);
    return;
  }

  // Copy vendor/
  if (existsSync(srcVendor)) {
    try {
      copyDirSync(srcVendor, path.join(dest, 'vendor'));
    } catch (err) {
      console.error(`[@cometix/claude-code postinstall] Failed to copy vendor/: ${err.message}`);
    }
  }
}

main();
