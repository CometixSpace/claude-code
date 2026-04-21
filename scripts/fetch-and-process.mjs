import { mkdir, rm, writeFile, readFile, stat, copyFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { extractBunSEA } from './bun-sea-extract.mjs';
import { patchFile } from './node-compat-patch.mjs';
import { buildPlatformPackage } from './build-platform-package.mjs';
import { buildMainPackage } from './build-main-package.mjs';
import { verifyNodeCompat } from './verify-node-compat.mjs';

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

const CDN_BASE = 'https://downloads.claude.ai/claude-code-releases';

// SEA platforms (8 binaries from CDN)
const SEA_PLATFORMS = [
  'darwin-arm64', 'darwin-x64',
  'linux-arm64', 'linux-x64',
  'linux-arm64-musl', 'linux-x64-musl',
  'win32-arm64', 'win32-x64',
];

// Output platform packages (9 = 8 SEA + 1 android alias)
const OUTPUT_PLATFORMS = [...SEA_PLATFORMS, 'android-arm64'];

// android-arm64 reuses linux-arm64 cli.js
const PLATFORM_ALIAS = { 'android-arm64': 'linux-arm64' };

const DEFAULT_RG_VERSION = '14.1.1';

// ──────────────────────────────────────────────
//  Download helpers
// ──────────────────────────────────────────────

// BSD tar (macOS) doesn't need --wildcards, GNU tar (Linux) does
function tarExtract(tgzPath, destDir, stripComponents, patterns) {
  const args = ['xzf', tgzPath, '-C', destDir];
  if (stripComponents) args.push(`--strip-components=${stripComponents}`);
  // Try without --wildcards first (BSD tar), fall back to --wildcards (GNU tar)
  try {
    execFileSync('tar', [...args, ...patterns], { stdio: 'pipe' });
  } catch {
    execFileSync('tar', [...args, '--wildcards', ...patterns], { stdio: 'pipe' });
  }
}

function fetchJson(url) {
  return JSON.parse(execFileSync('curl', ['-sL', '--fail', url], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024,
  }));
}

async function downloadFile(url, destPath) {
  console.log(`  ↓ ${url.split('/').slice(-2).join('/')}`);
  execFileSync('curl', ['-sL', '--fail', '-o', destPath, url], { timeout: 600_000 });
  return (await stat(destPath)).size;
}

// ──────────────────────────────────────────────
//  Download npm wrapper package
// ──────────────────────────────────────────────

async function downloadWrapper(version, tmpDir) {
  const wrapperDir = join(tmpDir, 'wrapper');
  await mkdir(wrapperDir, { recursive: true });
  execFileSync('npm', ['pack', `@anthropic-ai/claude-code@${version}`, '--pack-destination', tmpDir],
    { encoding: 'utf8', timeout: 60_000 });
  execFileSync('tar', ['xzf', join(tmpDir, `anthropic-ai-claude-code-${version}.tgz`),
    '-C', wrapperDir, '--strip-components=1']);
  return wrapperDir;
}

// ──────────────────────────────────────────────
//  Download ripgrep from GitHub releases
// ──────────────────────────────────────────────

function rgPlatformMap(v) {
  return {
    'arm64-darwin': { archive: `ripgrep-${v}-aarch64-apple-darwin.tar.gz`, bin: 'rg', type: 'tar' },
    'x64-darwin':   { archive: `ripgrep-${v}-x86_64-apple-darwin.tar.gz`, bin: 'rg', type: 'tar' },
    'arm64-linux':  { archive: `ripgrep-${v}-aarch64-unknown-linux-gnu.tar.gz`, bin: 'rg', type: 'tar' },
    'x64-linux':    { archive: `ripgrep-${v}-x86_64-unknown-linux-musl.tar.gz`, bin: 'rg', type: 'tar' },
    'arm64-win32':  { archive: `ripgrep-${v}-aarch64-pc-windows-msvc.zip`, bin: 'rg.exe', type: 'zip' },
    'x64-win32':    { archive: `ripgrep-${v}-x86_64-pc-windows-msvc.zip`, bin: 'rg.exe', type: 'zip' },
  };
}

async function downloadRipgrep(tmpDir, rgVersion) {
  const ripgrepDir = join(tmpDir, 'ripgrep');
  await mkdir(ripgrepDir, { recursive: true });
  console.log(`  ripgrep v${rgVersion} from GitHub...`);
  const RG_BASE = `https://github.com/BurntSushi/ripgrep/releases/download/${rgVersion}`;
  const map = rgPlatformMap(rgVersion);
  let downloaded = 0;

  for (const [vendorDir, info] of Object.entries(map)) {
    const archivePath = join(tmpDir, info.archive);
    try {
      await downloadFile(`${RG_BASE}/${info.archive}`, archivePath);
      const destDir = join(ripgrepDir, vendorDir);
      await mkdir(destDir, { recursive: true });
      if (info.type === 'tar') {
        tarExtract(archivePath, destDir, 1, [`*/${info.bin}`]);
      } else {
        execFileSync('unzip', ['-jo', archivePath, `*/${info.bin}`, '-d', destDir], { stdio: 'pipe' });
      }
      await stat(join(destDir, info.bin));
      downloaded++;
      await rm(archivePath, { force: true });
    } catch (e) {
      console.log(`    ⚠ ${vendorDir}: ${e.message.split('\n')[0]}`);
    }
  }

  try {
    await downloadFile(`https://raw.githubusercontent.com/BurntSushi/ripgrep/${rgVersion}/COPYING`,
      join(ripgrepDir, 'COPYING'));
  } catch {}

  console.log(`  ✓ ripgrep: ${downloaded}/${Object.keys(map).length} platforms`);
  return downloaded > 0 ? ripgrepDir : null;
}

// ──────────────────────────────────────────────
//  Download seccomp from sandbox-runtime
// ──────────────────────────────────────────────

async function downloadSeccomp(tmpDir) {
  const secDir = join(tmpDir, 'sandbox-runtime');
  await mkdir(secDir, { recursive: true });
  console.log('  seccomp from @anthropic-ai/sandbox-runtime...');
  execFileSync('npm', ['pack', '@anthropic-ai/sandbox-runtime', '--pack-destination', tmpDir],
    { encoding: 'utf8', timeout: 60_000 });
  const tgz = readdirSync(tmpDir).find(f => f.startsWith('anthropic-ai-sandbox-runtime-') && f.endsWith('.tgz'));
  if (!tgz) return null;
  tarExtract(join(tmpDir, tgz), secDir, 1, ['*/dist/vendor/seccomp/*']);
  const seccompDir = join(secDir, 'dist', 'vendor', 'seccomp');
  try { await stat(seccompDir); return seccompDir; } catch { return null; }
}

// ──────────────────────────────────────────────
//  Detect rg version from native binary
// ──────────────────────────────────────────────

async function detectRgVersion(binPath) {
  try {
    const { symlinkSync, unlinkSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'rg-'));
    const rgLink = join(tmp, 'rg');
    symlinkSync(binPath, rgLink);
    const out = execFileSync(rgLink, ['--version'], { encoding: 'utf8', timeout: 5000 });
    unlinkSync(rgLink);
    return out.match(/ripgrep (\d+\.\d+\.\d+)/)?.[1] ?? null;
  } catch { return null; }
}

// ──────────────────────────────────────────────
//  Main orchestrator
// ──────────────────────────────────────────────

export async function fetchAndProcess({
  version,
  outputDir = './output',
  rgVersion = DEFAULT_RG_VERSION,
}) {
  const tmpDir = join(outputDir, '.tmp');
  await mkdir(tmpDir, { recursive: true });

  // ── Step 1: Manifest ──
  console.log(`\n[1] Fetching manifest for v${version}...`);
  const manifest = fetchJson(`${CDN_BASE}/${version}/manifest.json`);
  console.log(`  Build: ${manifest.buildDate}`);

  // ── Step 2: Download all SEA binaries in parallel ──
  console.log(`\n[2] Downloading ${SEA_PLATFORMS.length} SEA binaries (parallel)...`);
  await Promise.all(SEA_PLATFORMS.map(async (platform) => {
    const info = manifest.platforms[platform];
    if (!info) { console.log(`  [skip] ${platform}`); return; }
    const binDir = join(tmpDir, 'bins', platform);
    await mkdir(binDir, { recursive: true });
    const size = await downloadFile(`${CDN_BASE}/${version}/${platform}/${info.binary}`, join(binDir, info.binary));
    console.log(`  ✓ ${platform} (${(size / 1024 / 1024).toFixed(0)}MB)`);
  }));

  // ── Step 3: Extract + patch each platform ──
  console.log(`\n[3] Extracting and patching...`);
  const extractions = {};

  for (const platform of SEA_PLATFORMS) {
    const info = manifest.platforms[platform];
    if (!info) continue;
    const binPath = join(tmpDir, 'bins', platform, info.binary);
    const extractDir = join(tmpDir, 'extract', platform);

    const result = await extractBunSEA(binPath);
    await mkdir(extractDir, { recursive: true });
    for (let idx = 0; idx < result.modules.length; idx++) {
      const mod = result.modules[idx];
      let name = mod.name;
      if (name.startsWith(result.basePath)) name = name.slice(result.basePath.length);
      if (name.startsWith('root/')) name = name.slice(5);
      if (idx === result.entryPointId) name = name.replace(/\.[^.]+$/, '') + '.' + mod.loader;
      if (mod.contents?.length > 0) {
        const outPath = join(extractDir, name);
        await mkdir(join(outPath, '..'), { recursive: true });
        await writeFile(outPath, mod.contents);
      }
    }

    // Verify Node.js compatibility before patching
    const cliSrc = join(extractDir, 'src', 'entrypoints', 'cli.js');
    const { compatible, fatal } = verifyNodeCompat(cliSrc);
    if (!compatible) {
      console.error(`  ✗ ${platform} — Node.js compat check failed (${fatal} fatal)`);
      console.error('    Anthropic may have removed dual-runtime fallbacks. Aborting.');
      process.exit(1);
    }
    console.log(`  ✓ ${platform} — Node.js compat verified`);

    // Patch cli.js
    const patchedPath = join(tmpDir, 'patched', `${platform}.js`);
    await mkdir(join(tmpDir, 'patched'), { recursive: true });
    await patchFile(join(extractDir, 'src', 'entrypoints', 'cli.js'), patchedPath);

    extractions[platform] = { extractDir, patchedPath, binPath };
    console.log(`  ✓ ${platform}`);

    // Clean up binary
    await rm(binPath, { force: true });
  }

  // Detect rg version from current platform binary (if available)
  const currentKey = `${process.platform}-${process.arch}`;
  if (extractions[currentKey]?.binPath) {
    const detected = await detectRgVersion(extractions[currentKey].binPath);
    if (detected) { rgVersion = detected; console.log(`  rg version: v${rgVersion}`); }
  }

  // ── Step 4: Download wrapper + vendor deps ──
  console.log(`\n[4] Downloading wrapper + vendor deps...`);
  const wrapperDir = await downloadWrapper(version, tmpDir);
  console.log('  ✓ wrapper');
  const ripgrepDir = await downloadRipgrep(tmpDir, rgVersion);
  const seccompDir = await downloadSeccomp(tmpDir);

  // ── Step 5: Build platform packages ──
  console.log(`\n[5] Building ${OUTPUT_PLATFORMS.length} platform packages...`);
  for (const platform of OUTPUT_PLATFORMS) {
    const source = PLATFORM_ALIAS[platform] || platform;
    const ext = extractions[source];
    if (!ext) { console.log(`  [skip] ${platform} — no extraction`); continue; }

    console.log(`  --- ${platform} ---`);
    await buildPlatformPackage({
      platform,
      version,
      patchedCliPath: ext.patchedPath,
      extractDir: ext.extractDir,
      ripgrepDir,
      seccompDir,
      outputDir: join(outputDir, 'packages', platform),
    });
  }

  // ── Step 6: Build main package ──
  console.log(`\n[6] Building main package...`);
  await buildMainPackage({ version, wrapperDir, outputDir: join(outputDir, 'main') });

  // ── Step 7: Cleanup ──
  console.log(`\n[7] Cleaning up...`);
  await rm(tmpDir, { recursive: true, force: true });

  console.log(`\n✓ Done. Output in ${outputDir}/`);
  console.log(`  main/          — @cometix/claude-code`);
  for (const p of OUTPUT_PLATFORMS) {
    console.log(`  packages/${p}/  — @cometix/claude-code-${p}`);
  }
}

// ──────────────────────────────────────────────
//  CLI
// ──────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith('fetch-and-process.mjs');
if (isMain) {
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version' && args[i+1]) flags.version = args[++i];
    else if (args[i] === '--output' && args[i+1]) flags.outputDir = args[++i];
    else if (args[i] === '--rg-version' && args[i+1]) flags.rgVersion = args[++i];
    else if (args[i] === '--latest') flags.latest = true;
  }

  if (!flags.version && !flags.latest) {
    console.error('Usage: node fetch-and-process.mjs --version <ver> [--output <dir>]');
    console.error('       node fetch-and-process.mjs --latest');
    process.exit(1);
  }

  if (flags.latest || !flags.version) {
    flags.version = execFileSync('npm', ['view', '@anthropic-ai/claude-code', 'version'],
      { encoding: 'utf8', timeout: 15_000 }).trim();
    console.log(`Latest version: ${flags.version}`);
  }

  await fetchAndProcess(flags);
}
