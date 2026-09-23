import { realpath } from 'node:fs/promises';
import { detectLayout, readInstalledVersion } from './layout.mjs';
import { loadPatches, appliesTo, withRequires, dependentsOf } from './registry.mjs';
import { createScanContext, scanPatch } from './scan.mjs';
import {
  compilePatch, mergeByFile, prepareWrites, commitWrites, verifyPatch,
  resolveApplied, recordApplied, saveOriginals, restoreOriginals,
  installAssets, recordAssets, removeInstalled,
} from './apply.mjs';
import { readSelection, writeSelection, SELECTION_FILE } from './selection.mjs';

// ──────────────────────────────────────────────
//  Session: the operations both front ends perform
//
//  The engine's parts — scan, compile, write, back up, record, verify — only
//  make a correct apply in one order, and that order used to be spelled out
//  inline in the CLI, interleaved with its printing. A second front end would
//  have had to copy it. Here it is once, as functions that return what
//  happened and report progress through a callback; drawing it is the
//  caller's business.
// ──────────────────────────────────────────────

// Everything a front end needs to show an install before changing it.
//
// `patches` and `selectionFile` exist for the tests: a synthetic install
// with synthetic patches, and a memory file that is not the user's own.
// `selectionFile: null` turns the memory off.
export async function openInstall(cliPath, { patches, selectionFile = SELECTION_FILE } = {}) {
  const layout = await detectLayout(cliPath);
  const version = await readInstalledVersion(layout.root);
  const all = patches ?? await loadPatches();
  const install = {
    cli: cliPath,
    layout,
    version,
    patches: all,
    applicable: all.filter((p) => appliesTo(p, version)),
    skipped: all.filter((p) => !appliesTo(p, version)),
    selectionFile,
    // The key the memory is filed under. Resolved, so the same install
    // reached through a symlinked global prefix is still the same install.
    key: await realpath(layout.root),
  };
  install.remembered = selectionFile ? await readSelection(install.key, selectionFile) : null;
  return refresh(install);
}

// Re-read what is applied. Every operation below ends with this, so the
// install object a front end holds always describes the files as they are.
export async function refresh(install) {
  install.applied = await resolveApplied(install.layout.root, install.patches.map((p) => p.id));
  return install;
}

// Some markers present, some gone: disturbed since it was applied.
export function isPartial(state) {
  return Boolean(state) && state.expected.length > 0 && state.sites.length < state.expected.length;
}

async function remember(install) {
  if (!install.selectionFile) return;
  await writeSelection(install.key, {
    ids: [...install.applied.keys()],
    version: install.version,
  }, install.selectionFile);
  install.remembered = await readSelection(install.key, install.selectionFile);
}

// Resolve ids against what this install can take. A patch outside its
// version range is named as such, rather than as "no such patch".
function resolveIds(install, ids) {
  const { ids: resolved, pulled } = withRequires(install.patches, ids);
  for (const id of resolved) {
    const skipped = install.skipped.find((p) => p.id === id);
    if (skipped) {
      const why = pulled.has(id) ? ` (required by ${pulled.get(id)})` : '';
      throw new Error(`${id}${why} needs Claude Code ${skipped.versions}; this is ${install.version}`);
    }
  }
  return { ids: resolved, pulled };
}

function emptyReport(dryRun) {
  return {
    dryRun, pulled: new Map(), alreadyApplied: [], scanned: [], markerOnly: [],
    assets: [], written: [], originals: null, verify: [], applied: [],
  };
}

// Apply patches on top of whatever is applied now.
//
// `onEvent` receives, in order:
//   { type: 'progress', index, count, patch, site, done, total }  per file scanned
//   { type: 'scanned', patch, result }                            per patch
//   { type: 'phase', phase: 'write' | 'verify' }
// reconcile adds, before any of those when it has to restore first:
//   { type: 'phase', phase: 'restore' }, then { type: 'restored', restored }
//
// Returns a report of everything that happened. `applied` lists the ids that
// were written (for a dry run: that would have been).
export async function applyPatches(install, ids, { dryRun = false, onEvent = () => {} } = {}) {
  const root = install.layout.root;
  const report = emptyReport(dryRun);
  const { ids: wanted, pulled } = resolveIds(install, ids);
  report.pulled = pulled;

  const pending = [];
  for (const p of install.applicable.filter((x) => wanted.includes(x.id))) {
    const state = install.applied.get(p.id);
    if (state) report.alreadyApplied.push({ id: p.id, sites: state.sites });
    else pending.push(p);
  }
  if (pending.length === 0) return report;

  const ctx = createScanContext(install.layout);
  for (const [index, patch] of pending.entries()) {
    ctx.onProgress = (p) => onEvent({ type: 'progress', index, count: pending.length, patch: patch.id, ...p });
    const result = await scanPatch(patch, ctx);
    report.scanned.push({ patch, result });
    onEvent({ type: 'scanned', patch, result });
  }
  report.markerOnly = ctx.markerOnly;

  const usable = report.scanned.filter((s) => s.result.ok);
  if (usable.length === 0) return report;

  const compiled = usable.map(({ patch, result }) => compilePatch(patch, result));
  const merged = mergeByFile(compiled);
  // Every file is spliced and re-parsed before anything is touched: an
  // overlap or a rewrite that does not parse throws here, with the install
  // exactly as it was.
  const plan = await prepareWrites(root, merged);
  report.written = plan.map(({ file, edits, bytes }) => ({ file, edits, bytes }));
  const appliedIds = usable.map((u) => u.patch.id);
  if (dryRun) {
    report.applied = appliedIds;
    return report;
  }

  onEvent({ type: 'phase', phase: 'write' });
  // Assets first. A payload is inert without the files it loads, and a
  // missing asset has to fail while the code is still untouched. If one
  // fails partway, the ones already copied are taken back — they are not
  // recorded yet, so restore would never find them.
  try {
    for (const { patch } of usable) {
      const files = await installAssets(root, patch);
      if (files.length > 0) report.assets.push({ id: patch.id, files });
    }
  } catch (e) {
    await removeInstalled(root, report.assets.flatMap((a) => a.files));
    throw e;
  }

  // Originals before the rewrite, so there is no moment at which a file has
  // changed and its pristine bytes exist nowhere.
  report.originals = await saveOriginals(root, new Map(plan.map((w) => [w.file, w.before])), appliedIds);
  await commitWrites(root, plan);
  await recordApplied(root, usable.map(({ patch, result }, i) => ({
    id: patch.id,
    files: [...compiled[i].keys()],
    sites: [...new Set(result.sites.filter((s) => s.site.edit).map((s) => s.site.id))],
  })));
  // After recordApplied, which creates the entries these attach to.
  for (const { id, files } of report.assets) await recordAssets(root, id, files);

  onEvent({ type: 'phase', phase: 'verify' });
  // Against the trees prepareWrites built from exactly the bytes written.
  const parsed = new Map(plan.map((w) => [w.file, { text: w.after, ast: w.ast }]));
  for (const [i, { patch, result }] of usable.entries()) {
    const problems = await verifyPatch(root, patch, compiled[i], result.values, { parsed });
    if (problems.length > 0) report.verify.push({ id: patch.id, problems });
  }

  report.applied = appliedIds;
  await refresh(install);
  await remember(install);
  return report;
}

// Put every touched file back to what npm installed.
export async function restoreAll(install) {
  const result = await restoreOriginals(install.layout.root);
  await refresh(install);
  await remember(install);
  return result;
}

// What moving from the current state to `desired` involves.
//
// Removing a patch can only be done by restoring: originals are whole files
// taken before *any* patch touched them, and a chunk routinely carries edits
// from several. So any removal — and any repair of a patch whose markers are
// partly gone — restores everything and re-applies what should stay, in one
// scan. Additions alone go on top of what is there.
export function planChange(install, desired) {
  const { ids: want, pulled } = resolveIds(install, desired);
  const have = [...install.applied.keys()];
  const remove = have.filter((id) => !want.includes(id));
  const repair = have.filter((id) => want.includes(id) && isPartial(install.applied.get(id)));
  const add = want.filter((id) => !have.includes(id));
  return { want, pulled, add, remove, repair, restoreFirst: remove.length > 0 || repair.length > 0 };
}

// Make the applied set equal `desired` (plus what it requires).
//
// A dry run cannot restore, so it checks the additions against the files as
// they are. The patches that would be re-applied were located when they were
// applied the first time, against the same pristine bytes restore returns.
export async function reconcile(install, desired, { dryRun = false, onEvent = () => {} } = {}) {
  const plan = planChange(install, desired);
  if (!plan.restoreFirst || dryRun) {
    return { plan, restored: null, report: await applyPatches(install, plan.add, { dryRun, onEvent }) };
  }
  onEvent({ type: 'phase', phase: 'restore' });
  const restored = await restoreAll(install);
  onEvent({ type: 'restored', restored });
  const report = plan.want.length > 0
    ? await applyPatches(install, plan.want, { onEvent })
    : emptyReport(false);
  return { plan, restored, report };
}

// Drop `ids`, and whatever requires them.
export function withoutIds(install, ids) {
  const also = dependentsOf(install.patches, ids);
  const keep = [...install.applied.keys()].filter((id) => !ids.includes(id) && !also.includes(id));
  return { keep, also };
}
