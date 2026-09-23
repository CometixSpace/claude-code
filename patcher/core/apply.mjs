import { readFile, writeFile, mkdir, rm, rmdir, readdir, stat, copyFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { openSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { compileEdit, applyEdits, interpolate } from './edit.mjs';
import { parse } from './scan.mjs';
import { findMatches, resolveSpec } from './match.mjs';

// ──────────────────────────────────────────────
//  Applying, verifying, backing up
//
//  Three things every one of the 14 scripts does by hand, none of which a
//  patch author should have to reimplement:
//
//  Idempotence — all 14 check ALREADY_PATCHED before touching anything.
//  Here a patch declares a `marker` it leaves behind and the engine decides.
//
//  Verification — 13 of 14 re-check after writing, 10 of them by re-parsing.
//  The single bundle made a bad rewrite obvious; across 2000 chunks a file
//  that no longer parses is a broken install found at next launch, not now.
//
//  Backups — the standalone scripts copy one file to cli.js.backup, which
//  simply cannot restore a multi-file edit. A manifest records which files a
//  run touched, so restore puts back exactly those.
// ──────────────────────────────────────────────

const BACKUP_DIR = '.claude-patcher';

// ──────────────────────────────────────────────
//  Markers
//
//  Every edit carries one, naming both the patch and the site it came from.
//  A comment costs nothing at runtime and survives in the source, which makes
//  the install self-describing: what is applied can be read off the files
//  themselves rather than trusted from a state file that may have gone stale.
//
//  Per-site rather than per-patch, because a patch with several sites can
//  only be half-present — one site rewritten, another silently skipped — and
//  a single marker on the first edit cannot tell those apart.
// ──────────────────────────────────────────────

const MARKER_PREFIX = '@cc:';

export function siteMarker(patchId, siteId) {
  return `/*${MARKER_PREFIX}${patchId}#${siteId}*/`;
}

export function isApplied(source, patchId) {
  return source.includes(`${MARKER_PREFIX}${patchId}#`);
}

// Which sites of a patch are present in a source text. Lets `status` say
// "3 of 4 sites" instead of a bare yes/no.
export function appliedSites(source, patchId) {
  const re = new RegExp(`@cc:${patchId.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}#([\\w-]+)`, 'g');
  return [...new Set([...source.matchAll(re)].map((m) => m[1]))];
}

// ──────────────────────────────────────────────
//  Applied-state
//
//  Knowing what is already applied cannot be answered from the entry alone:
//  a patch's marker lands in whichever chunk held its first site, which is
//  almost never cli.js. Re-reading 2000 files to find out would make `status`
//  as expensive as a full scan.
//
//  So a run records the files it touched, and reading that back is confirmed
//  against the marker actually being in one of them. The state file alone
//  would go stale the moment the package is reinstalled — npm would replace
//  every chunk and leave the state claiming patches that are gone.
// ──────────────────────────────────────────────

const STATE_FILE = join(BACKUP_DIR, 'applied.json');

export async function readState(root) {
  try {
    return JSON.parse(await readFile(join(root, STATE_FILE), 'utf8'));
  } catch {
    return {};
  }
}

async function writeState(root, state) {
  await mkdir(join(root, BACKUP_DIR), { recursive: true });
  await writeFile(join(root, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

// `sites` is recorded so a later run can tell "partly applied" from "fully
// applied" — the marker count on disk is compared against what was written.
export async function recordApplied(root, entries) {
  const state = await readState(root);
  for (const { id, files, sites } of entries) {
    state[id] = { files, sites, at: new Date().toISOString() };
  }
  await writeState(root, state);
}

export async function forgetApplied(root, patchIds) {
  const state = await readState(root);
  for (const id of patchIds) delete state[id];
  await writeState(root, state);
}

// What is genuinely applied right now: recorded by a previous run *and* still
// carrying markers on disk. The files are the authority — the state file only
// says where to look, so that answering this does not cost a full tree read.
//
// Returns a Map so callers can report which sites survived, not just whether
// the patch is present. A patch whose sites are partly gone has been
// disturbed — by a reinstall over the top, or by an edit from elsewhere — and
// that reads very differently from cleanly applied.
export async function resolveApplied(root, patchIds) {
  const state = await readState(root);
  const applied = new Map();

  for (const id of patchIds) {
    const entry = state[id];
    if (!entry) continue;
    const sites = new Set();
    for (const rel of entry.files ?? []) {
      try {
        const text = await readFile(join(root, rel), 'utf8');
        for (const s of appliedSites(text, id)) sites.add(s);
      } catch {}
    }
    if (sites.size > 0) applied.set(id, { sites: [...sites], expected: entry.sites ?? [] });
  }
  return applied;
}

// ──────────────────────────────────────────────
//  Assets
//
//  Some patches need files, not only rewrites: voice-asr-backend is inert
//  without the addon it feeds audio to. Leaving that as a manual step makes
//  the patch look applied while it cannot work, which is the failure mode
//  markers and verification exist to prevent everywhere else.
//
//  Copied files are tracked separately from originals: they did not exist
//  before, so restoring means deleting them rather than putting bytes back.
//  Only paths this tool wrote are removed, and only if still identical in
//  size — a file the user replaced is left alone.
//
//  An asset may live outside this repo. Native addons are built elsewhere and
//  run to several MB per platform; committing them here would put a binary
//  blob in the history of a repository that otherwise holds text. `source`
//  names an env var pointing at the build output instead, so the patch
//  declares what it needs and where it normally comes from without carrying
//  it.
// ──────────────────────────────────────────────

const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const CACHE_DIR = join(ASSET_DIR, '.cache');

// How napi-rs names a platform, which is also how the build publishes one
// bundle per target.
function platformTag() {
  const { platform, arch } = process;
  if (platform === 'win32') return `${platform}-${arch}-msvc`;
  if (platform === 'linux') return `${platform}-${arch}-gnu`;
  return `${platform}-${arch}`;
}

// Fetch the bundle for this platform, once, into a cache beside the patches.
//
// Storing all four here instead would put ~13MB of binary in a repository
// that otherwise holds text, and add another copy to its history on every
// addon update — for three files that cannot load on the machine reading
// them. The build already publishes them per platform, so the tool takes the
// one it needs at the moment it needs it.
async function fetchAsset(asset) {
  const tag = platformTag();
  const name = asset.fetch.artifact.replace('{platform}', tag);
  const cached = join(CACHE_DIR, `${asset.fetch.commit ?? 'latest'}-${tag}`);

  try {
    await stat(join(cached, asset.fetch.entry ?? ''));
    return cached;
  } catch {}

  const { repo, commit } = asset.fetch;
  const list = JSON.parse(execFileSync('gh', [
    'api', `repos/${repo}/actions/artifacts`, '--paginate',
    '--jq', `[.artifacts[] | select(.name=="${name}" and .expired==false)]`,
  ], { encoding: 'utf8', maxBuffer: 32 << 20 }));

  // Pinned by commit so the binary and the adapter that drives it stay in
  // step; an unpinned patch would silently pick up a later build.
  const match = commit
    ? list.find((a) => a.workflow_run?.head_sha?.startsWith(commit))
    : list.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (!match) {
    throw new Error(`no artifact "${name}"${commit ? ` at ${commit}` : ''} in ${repo}`);
  }

  await mkdir(cached, { recursive: true });
  const zip = join(cached, 'artifact.zip');
  execFileSync('gh', ['api', `repos/${repo}/actions/artifacts/${match.id}/zip`],
    { stdio: ['ignore', openSync(zip, 'w'), 'inherit'], maxBuffer: 64 << 20 });
  // The artifact wraps a second zip plus its checksum; unpack both, verifying
  // the inner one against what the build published with it.
  execFileSync('unzip', ['-oq', zip, '-d', cached]);
  const inner = (await readdir(cached)).find((f) => f.endsWith('.zip') && f !== 'artifact.zip');
  if (inner) {
    const sums = (await readdir(cached)).find((f) => f === `${inner}.sha256`);
    if (sums) {
      const expected = (await readFile(join(cached, sums), 'utf8')).trim().split(/\s+/)[0];
      const actual = createHash('sha256').update(await readFile(join(cached, inner))).digest('hex');
      if (expected !== actual) throw new Error(`${name}: sha256 mismatch`);
    }
    execFileSync('unzip', ['-oq', join(cached, inner), '-d', cached]);
  }
  await rm(zip, { force: true });
  return cached;
}

async function assetSource(asset) {
  // localRoot points the lookup at a directory instead of the cache; the
  // tests use it so the per-platform filter can be checked without a network.
  if (asset.localRoot) return join(asset.localRoot, asset.from);
  if (asset.fetch) {
    const dir = await fetchAsset(asset);
    return asset.from === '.' ? dir : join(dir, asset.from);
  }
  return join(ASSET_DIR, asset.from);
}

// `only` filters a directory's entries, so a four-platform addon ships one
// binary rather than all of them — the other three cannot load here anyway.
async function copyAsset(srcPath, destPath, only) {
  const info = await stat(srcPath);
  if (!info.isDirectory()) {
    await mkdir(dirname(destPath), { recursive: true });
    await copyFile(srcPath, destPath);
    return [{ path: destPath, bytes: info.size }];
  }
  const written = [];
  for (const entry of await readdir(srcPath, { withFileTypes: true })) {
    if (only && !only(entry.name)) continue;
    written.push(...await copyAsset(join(srcPath, entry.name), join(destPath, entry.name), only));
  }
  return written;
}

// Node's platform-arch naming as the napi-rs convention writes it.
function platformSuffixes() {
  const { platform, arch } = process;
  const base = `${platform}-${arch}`;
  return platform === 'win32' ? [`${base}-msvc`, base]
    : platform === 'linux' ? [`${base}-gnu`, `${base}-musl`, base]
      : [base];
}

export async function installAssets(root, patch) {
  const installed = [];
  for (const asset of patch.assets ?? []) {
    const src = await assetSource(asset);
    const dest = join(root, asset.to);
    // A native binary per platform: keep the one that can load, drop the rest.
    const only = asset.perPlatform
      ? (name) => !name.endsWith('.node') || platformSuffixes().some((s) => name.includes(s))
      : null;
    try {
      const files = await copyAsset(src, dest, only);
      installed.push(...files.map((f) => ({ ...f, path: relative(root, f.path) })));
    } catch (e) {
      throw new Error(`${patch.id}: asset "${asset.from}" could not be installed — ${e.message}`);
    }
  }
  return installed;
}

export async function recordAssets(root, patchId, files) {
  const state = await readState(root);
  if (state[patchId]) state[patchId].assets = files;
  await writeState(root, state);
}

// Remove what a run added, leaving anything the user changed in place.
async function removeAssets(root, state) {
  const removed = [];
  const dirs = new Set();

  for (const entry of Object.values(state)) {
    for (const asset of entry.assets ?? []) {
      const path = join(root, asset.path);
      try {
        if ((await stat(path)).size !== asset.bytes) continue;
        await rm(path, { force: true });
        removed.push(asset.path);
        dirs.add(dirname(path));
      } catch {}
    }
  }

  // Directories the copy created, cleared deepest-first so a nested tree
  // unwinds. rmdir rather than rm: it refuses a non-empty directory outright,
  // so a directory shared with the install — vendor/, holding ripgrep — is
  // safe even if the emptiness check were to race.
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    try { await rmdir(dir); } catch {}
  }
  return removed;
}

// Turn one patch's scan result into splices, grouped by file.
//
// Each edit gets its own marker appended, rather than one marker on the first
// edit of the patch: the rewritten bytes and the note saying who rewrote them
// then travel together, so a later run reading the files back can say exactly
// which sites are present.
export function compilePatch(patch, scanResult) {
  const byFile = new Map();

  for (const { site, file, node, values } of scanResult.sites) {
    if (!site.edit) continue;
    const edits = Array.isArray(site.edit) ? site.edit : [site.edit];
    for (const edit of edits) {
      // Per-match values, not the patch-wide set: with nth:"all" each node
      // captured its own names.
      const compiled = compileEdit(edit, node, values ?? scanResult.values);
      compiled.text += siteMarker(patch.id, site.id);
      compiled.patch = patch.id;
      compiled.site = site.id;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push(compiled);
    }
  }
  return byFile;
}

// Merge several patches' edits into one write per file.
//
// This is the reason the engine exists rather than a loop over the old
// scripts: a single chunk regularly carries sites from more than one patch,
// and applying them file-by-file — all patches at once — is the only way the
// offsets stay consistent.
export function mergeByFile(compiledPatches) {
  const merged = new Map();
  for (const byFile of compiledPatches) {
    for (const [file, edits] of byFile) {
      if (!merged.has(file)) merged.set(file, []);
      merged.get(file).push(...edits);
    }
  }
  return merged;
}

// Rewrite each touched file, re-parsing before it is written.
//
// Verification happens on the new text while the old text is still on disk,
// so a patch that produces something unparseable leaves the install intact.
export async function writeFiles(root, merged, { dryRun = false } = {}) {
  const written = [];
  const originals = new Map();

  for (const [rel, edits] of merged) {
    const path = join(root, rel);
    const before = await readFile(path, 'utf8');
    const after = applyEdits(before, edits);

    try {
      parse(after);
    } catch (e) {
      throw new Error(
        `${rel} would not parse after applying `
        + `${[...new Set(edits.map((x) => x.patch))].join(', ')}: ${e.message}`,
      );
    }

    originals.set(rel, before);
    if (!dryRun) await writeFile(path, after);
    written.push({ file: rel, edits: edits.length, bytes: after.length - before.length });
  }

  return { written, originals };
}

// Post-write checks a patch declares for itself, beyond "it still parses".
//
// `verify.contains` re-reads the file and asserts the text is there — the
// cheap version of what the scripts do when they re-parse and walk back to
// the node they patched.
// Post-write checks a patch declares for itself, beyond "it still parses".
//
// Stated as an AST predicate, the same shape `match` uses, and run against a
// fresh parse of what was written. Text matching was the wrong tool here even
// though `match.contains` uses it legitimately: there the text is a node's
// own source, already delimited by the AST, whereas a check against the whole
// file has no such anchor. It also has to step over the marker comment now
// sitting between the rewritten bytes and whatever followed them, which is
// exactly the kind of incidental detail a predicate should not encode.
export async function verifyPatch(root, patch, merged, values) {
  const problems = [];
  for (const check of patch.verify ?? []) {
    const files = check.file ? [check.file] : [...merged.keys()];
    const spec = resolveSpec(check.match, values);
    let seen = false;
    for (const rel of files) {
      const text = await readFile(join(root, rel), 'utf8');
      let ast;
      try {
        ast = parse(text);
      } catch {
        continue;
      }
      if (findMatches(ast, spec, text).length > 0) { seen = true; break; }
    }
    if (!seen) problems.push(check.describe ?? JSON.stringify(check.match));
  }
  return problems;
}

// ──────────────────────────────────────────────
//  Manifest-based backup
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
//  Backups: one pristine copy per file, taken once
//
//  Timestamped snapshots per run look tidier but restore the wrong thing.
//  Apply A, then apply B, and B's snapshot of a shared chunk already contains
//  A's rewrite — restoring it returns the file to "A applied", not to what
//  npm installed. Chain enough runs and there is no way back to the original.
//
//  So a file is copied the first time any patch touches it and never again.
//  The copy under originals/ is by definition pristine, which also makes
//  taking a backup idempotent: re-running apply cannot damage it.
//
//  Restore is therefore whole-file: it puts the untouched bytes back and
//  clears the state. Keeping one patch out of several means re-applying it,
//  which is cheap and cannot get the layering wrong.
// ──────────────────────────────────────────────

const ORIGINALS_DIR = join(BACKUP_DIR, 'originals');
const MANIFEST = join(BACKUP_DIR, 'originals', 'manifest.json');

async function readManifest(root) {
  try {
    return JSON.parse(await readFile(join(root, MANIFEST), 'utf8'));
  } catch {
    return { files: {} };
  }
}

// Copy each file's pristine bytes aside, skipping any already held.
//
// `originals` holds the text as read just before this run's edits, so it is
// only pristine for files no previous run touched — which is exactly the set
// this adds.
export async function saveOriginals(root, originals, patchIds) {
  const manifest = await readManifest(root);
  const added = [];

  for (const [rel, text] of originals) {
    if (manifest.files[rel]) {
      // Already held from an earlier run. Record the new patch against it so
      // restore knows everything that touched this file.
      const owners = new Set(manifest.files[rel].patches ?? []);
      for (const id of patchIds) owners.add(id);
      manifest.files[rel].patches = [...owners];
      continue;
    }
    // Chunk names are flat, but src/** is not; keep the tree so restore can
    // put a nested file back where it came from.
    const dest = join(root, ORIGINALS_DIR, rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, text);
    manifest.files[rel] = { patches: [...patchIds], bytes: text.length };
    added.push(rel);
  }

  await mkdir(join(root, ORIGINALS_DIR), { recursive: true });
  await writeFile(join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return { added, held: Object.keys(manifest.files).length };
}

export async function listOriginals(root) {
  const manifest = await readManifest(root);
  return Object.entries(manifest.files).map(([file, meta]) => ({ file, ...meta }));
}

// Put every held file back and forget everything. Returns what it restored.
export async function restoreOriginals(root) {
  const manifest = await readManifest(root);
  const files = Object.keys(manifest.files);
  const patches = new Set();

  for (const rel of files) {
    const text = await readFile(join(root, ORIGINALS_DIR, rel), 'utf8');
    await writeFile(join(root, rel), text);
    for (const id of manifest.files[rel].patches ?? []) patches.add(id);
  }

  const state = await readState(root);
  const removedAssets = await removeAssets(root, state);

  await rm(join(root, ORIGINALS_DIR), { recursive: true, force: true });
  // The restored bytes carry no markers, so the state has to drop these too
  // or `status` would keep reporting them as applied.
  await forgetApplied(root, [...patches]);
  return { files, patches: [...patches], removedAssets };
}
