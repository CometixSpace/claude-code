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

// Idempotence marker, written as a comment so it survives in the source and
// costs nothing at runtime.
export function patchMarker(patchId) {
  return `/*@cc-patch:${patchId}*/`;
}

export function isApplied(source, patchId) {
  return source.includes(patchMarker(patchId));
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

export async function recordApplied(root, patchIds, files) {
  const state = await readState(root);
  for (const id of patchIds) state[id] = { files, at: new Date().toISOString() };
  await writeState(root, state);
}

export async function forgetApplied(root, patchIds) {
  const state = await readState(root);
  for (const id of patchIds) delete state[id];
  await writeState(root, state);
}

// Which of `patchIds` are genuinely applied right now: recorded by a previous
// run *and* still carrying their marker on disk.
export async function resolveApplied(root, patchIds) {
  const state = await readState(root);
  const applied = new Set();
  for (const id of patchIds) {
    const entry = state[id];
    if (!entry) continue;
    for (const rel of entry.files ?? []) {
      try {
        if (isApplied(await readFile(join(root, rel), 'utf8'), id)) { applied.add(id); break; }
      } catch {}
    }
  }
  return applied;
}

// Turn one patch's scan result into splices, grouped by file.
//
// The marker is appended to the first edit of the patch rather than written
// separately: a separate insertion could land in a file the patch otherwise
// leaves alone, and then restore would miss it.
export function compilePatch(patch, scanResult) {
  const byFile = new Map();
  let markerPlaced = false;

  for (const { site, file, node } of scanResult.sites) {
    if (!site.edit) continue;
    const edits = Array.isArray(site.edit) ? site.edit : [site.edit];
    for (const edit of edits) {
      const compiled = compileEdit(edit, node, scanResult.values);
      if (!markerPlaced) {
        compiled.text += patchMarker(patch.id);
        markerPlaced = true;
      }
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

export async function saveBackup(root, originals, patchIds, stamp) {
  const dir = join(root, BACKUP_DIR, 'backups', stamp);
  await mkdir(dir, { recursive: true });

  const files = [];
  for (const [rel, text] of originals) {
    // Chunk names are flat, but src/** is not; keep the tree so restore can
    // put a nested file back where it came from.
    const dest = join(dir, rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, text);
    files.push(rel);
  }

  await writeFile(
    join(dir, 'manifest.json'),
    `${JSON.stringify({ stamp, patches: patchIds, files }, null, 2)}\n`,
  );
  return { dir, files };
}

export async function listBackups(root) {
  const base = join(root, BACKUP_DIR, 'backups');
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(await readFile(join(base, entry.name, 'manifest.json'), 'utf8'));
      out.push({ ...manifest, dir: join(base, entry.name) });
    } catch {}
  }
  return out.sort((a, b) => String(b.stamp).localeCompare(String(a.stamp)));
}

export async function restoreBackup(root, backup) {
  for (const rel of backup.files) {
    const text = await readFile(join(backup.dir, rel), 'utf8');
    await writeFile(join(root, rel), text);
  }
  await rm(backup.dir, { recursive: true, force: true });
  // The restored bytes no longer carry the markers, so the state has to drop
  // these too or `status` would keep reporting them as applied.
  await forgetApplied(root, backup.patches ?? []);
  return backup.files.length;
}
