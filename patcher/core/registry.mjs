import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PATCH_DIR = join(__dirname, '..', 'patches');
const PAYLOAD_DIR = join(__dirname, '..', 'payloads');

// ──────────────────────────────────────────────
//  Patch registry
//
//  Patches are data, loaded from patches/*.json. The shell is fixed;
//  maintaining a point means editing a declaration, not a script.
//
//  Payloads live outside the JSON. Injected text is bimodal across the 14
//  surveyed scripts: twelve of them inject at most 128 characters, which sits
//  fine inline, but enable-voice-mode injects 14,453 and
//  transcript-dialog-replay 2,103. Embedding those as escaped JSON strings
//  would make the declaration unreadable and undiffable, so `textFrom` names
//  a file under payloads/ instead.
// ──────────────────────────────────────────────

async function resolvePayloads(patch) {
  const stages = patch.stages ?? [{ id: 'main', sites: patch.sites ?? [] }];
  for (const stage of stages) {
    for (const site of stage.sites ?? []) {
      const edits = site.edit ? (Array.isArray(site.edit) ? site.edit : [site.edit]) : [];
      for (const edit of edits) {
        if (!edit.textFrom) continue;
        if (edit.text !== undefined) {
          throw new Error(`${patch.id}/${site.id}: edit has both text and textFrom`);
        }
        edit.text = await readFile(join(PAYLOAD_DIR, edit.textFrom), 'utf8');
      }
    }
  }
  return patch;
}

// Structural checks that would otherwise surface as a crash mid-apply, or —
// worse — as a patch that silently does nothing.
export function validate(patch, file) {
  const fail = (msg) => { throw new Error(`${file}: ${msg}`); };
  if (!patch.id) fail('missing id');
  if (!patch.title) fail('missing title');
  if (patch.requires !== undefined
    && !(Array.isArray(patch.requires) && patch.requires.every((r) => typeof r === 'string'))) {
    fail('requires must be an array of patch ids');
  }

  const stages = patch.stages ?? (patch.sites ? [{ id: 'main', sites: patch.sites }] : null);
  if (!stages) fail('has neither sites nor stages');

  const seen = new Set();
  for (const stage of stages) {
    if (!Array.isArray(stage.sites) || stage.sites.length === 0) {
      fail(`stage "${stage.id ?? '?'}" has no sites`);
    }
    for (const site of stage.sites) {
      if (!site.id) fail('a site is missing its id');
      if (seen.has(site.id)) fail(`duplicate site id "${site.id}"`);
      seen.add(site.id);
      if (!site.match) fail(`site "${site.id}" has no match`);
      // A site with no marker forces every file in the tree to be parsed.
      // Allowed — some shapes genuinely have no stable text — but it should
      // be a deliberate choice, so it has to be spelled out.
      if (site.marker === undefined && site.unfiltered !== true) {
        fail(`site "${site.id}" has no marker; set "unfiltered": true to accept a full-tree parse`);
      }
    }
  }
  return patch;
}

export async function loadPatches() {
  let files;
  try {
    files = (await readdir(PATCH_DIR)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }

  const patches = [];
  for (const file of files) {
    const raw = JSON.parse(await readFile(join(PATCH_DIR, file), 'utf8'));
    patches.push(await resolvePayloads(validate(raw, file)));
  }
  return checkRequires(patches);
}

// `requires` names other patches, so it can only be checked against the
// whole set. A dangling id would otherwise surface as "no such patch" at
// apply time, blamed on whatever the user selected.
export function checkRequires(patches) {
  const ids = new Set(patches.map((p) => p.id));
  for (const p of patches) {
    for (const r of p.requires ?? []) {
      if (!ids.has(r)) throw new Error(`${p.id} requires "${r}", which is not a patch`);
    }
  }
  return patches;
}

// The selection plus everything it depends on, in registry order.
//
// A patch that only works on top of another says so with `requires`:
// voice-asr-backend replaces the transport of a feature that stays gated
// until enable-voice-mode lifts the gate, so on its own it applies cleanly
// and changes nothing. `pulled` maps each id added this way to the patch
// that asked for it, so a front end can say why it appeared.
export function withRequires(patches, ids) {
  const byId = new Map(patches.map((p) => [p.id, p]));
  const chosen = new Set();
  const pulled = new Map();
  const visit = (id, by) => {
    const p = byId.get(id);
    if (!p) throw new Error(`no such patch: ${id}`);
    if (chosen.has(id)) return;
    chosen.add(id);
    if (by) pulled.set(id, by);
    for (const r of p.requires ?? []) visit(r, id);
  };
  for (const id of ids) visit(id, null);
  for (const id of ids) pulled.delete(id);
  return { ids: patches.filter((p) => chosen.has(p.id)).map((p) => p.id), pulled };
}

// The other direction: what stops making sense once `ids` are gone.
export function dependentsOf(patches, ids) {
  const gone = new Set(ids);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of patches) {
      if (!gone.has(p.id) && (p.requires ?? []).some((r) => gone.has(r))) {
        gone.add(p.id);
        grew = true;
      }
    }
  }
  return patches.filter((p) => gone.has(p.id) && !ids.includes(p.id)).map((p) => p.id);
}

// Whether a patch declares itself applicable to the installed version.
//
// An unparseable or absent version is treated as "applicable": the user may
// have pointed at a cli.js with no package.json beside it, and refusing to
// offer anything would be worse than letting the site scan decide.
export function appliesTo(patch, version) {
  if (!patch.versions) return true;
  if (!version || !semver.valid(version)) return true;
  return semver.satisfies(version, patch.versions);
}
