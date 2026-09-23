import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { compileEdit, applyEdits, interpolate } from './edit.mjs';
import { parse } from './scan.mjs';

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
export async function verifyPatch(root, patch, merged, values) {
  const problems = [];
  for (const check of patch.verify ?? []) {
    const files = check.file ? [check.file] : [...merged.keys()];
    let seen = false;
    for (const rel of files) {
      const text = await readFile(join(root, rel), 'utf8');
      const needle = interpolate(check.contains, values);
      if (text.includes(needle)) { seen = true; break; }
    }
    if (!seen) problems.push(check.describe ?? check.contains);
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

  await rm(join(root, ORIGINALS_DIR), { recursive: true, force: true });
  // The restored bytes carry no markers, so the state has to drop these too
  // or `status` would keep reporting them as applied.
  await forgetApplied(root, [...patches]);
  return { files, patches: [...patches] };
}
