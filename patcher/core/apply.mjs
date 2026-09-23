import { readFile, writeFile, mkdir, rm, rmdir, readdir, stat, copyFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
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
//  A native addon ships one binary per platform. All of them live here, so
//  the patcher works wherever it is cloned, but only the one that can load
//  is installed — the other three would be dead weight in the target's
//  vendor directory.
// ──────────────────────────────────────────────

const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

// Where an asset's files come from. localRoot exists for the tests, which
// need the per-platform filter exercised against a synthetic bundle.
function assetSource(asset) {
  return join(asset.localRoot ?? ASSET_DIR, asset.from);
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
    const src = assetSource(asset);
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
  return removeInstalled(root, Object.values(state).flatMap((entry) => entry.assets ?? []));
}

// The same, for a list of files as installAssets returned them. Also how an
// install that fails partway takes back what it had already copied: those
// files are not recorded yet, so restore would never find them.
export async function removeInstalled(root, files) {
  const removed = [];
  const dirs = new Set();

  for (const asset of files) {
    const path = join(root, asset.path);
    try {
      if ((await stat(path)).size !== asset.bytes) continue;
      await rm(path, { force: true });
      removed.push(asset.path);
      dirs.add(dirname(path));
    } catch {}
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
//
// In two halves, because a write that fails partway must fail before the
// first byte lands. Splicing and re-parsing every file first means an
// overlap or a rewrite that does not parse — in the third file of five —
// is found while all five are untouched. Writing as each file passed would
// leave the first two rewritten, with their originals not yet copied aside.
export async function prepareWrites(root, merged) {
  const plan = [];
  for (const [rel, edits] of merged) {
    const before = await readFile(join(root, rel), 'utf8');
    const after = applyEdits(before, edits);

    let ast;
    try {
      ast = parse(after);
    } catch (e) {
      throw new Error(
        `${rel} would not parse after applying `
        + `${[...new Set(edits.map((x) => x.patch))].join(', ')}: ${e.message}`,
      );
    }
    // The tree is kept: it is the parse of exactly what gets written, which
    // is what verification needs, and producing it again cost more than the
    // rest of an apply put together.
    plan.push({ file: rel, before, after, ast, edits: edits.length, bytes: after.length - before.length });
  }
  return plan;
}

export async function commitWrites(root, plan) {
  for (const { file, after } of plan) await writeFile(join(root, file), after);
}

export async function writeFiles(root, merged, { dryRun = false } = {}) {
  const plan = await prepareWrites(root, merged);
  if (!dryRun) await commitWrites(root, plan);
  return {
    written: plan.map(({ file, edits, bytes }) => ({ file, edits, bytes })),
    originals: new Map(plan.map(({ file, before }) => [file, before])),
  };
}

// Post-write checks a patch declares for itself, beyond "it still parses".
//
// Stated as an AST predicate, the same shape `match` uses, and run against a
// fresh parse of what was written. Text matching was the wrong tool here even
// though `match.contains` uses it legitimately: there the text is a node's
// own source, already delimited by the AST, whereas a check against the whole
// file has no such anchor. It also has to step over the marker comment now
// sitting between the rewritten bytes and whatever followed them, which is
// exactly the kind of incidental detail a predicate should not encode.
//
// `files` is a Map keyed by file — the patch's own, as compilePatch returns
// them, so a check looks where that patch wrote rather than in every file the
// run touched. `parsed` (file → { text, ast }) supplies trees already built;
// anything not in it is read and parsed once, however many checks ask. Both
// matter at scale: parsing every written file afresh for each of ~20 checks
// took 43 seconds against a 9-second scan.
export async function verifyPatch(root, patch, files, values, { parsed = new Map() } = {}) {
  const load = async (rel) => {
    if (!parsed.has(rel)) {
      const text = await readFile(join(root, rel), 'utf8');
      let ast = null;
      try { ast = parse(text); } catch {}
      parsed.set(rel, { text, ast });
    }
    return parsed.get(rel);
  };

  const problems = [];
  for (const check of patch.verify ?? []) {
    const targets = check.file ? [check.file] : [...files.keys()];
    const spec = resolveSpec(check.match, values);
    let seen = false;
    for (const rel of targets) {
      const { text, ast } = await load(rel);
      if (ast && findMatches(ast, spec, text).length > 0) { seen = true; break; }
    }
    if (!seen) problems.push(check.describe ?? JSON.stringify(check.match));
  }
  return problems;
}

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
