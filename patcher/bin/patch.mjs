#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectLayout, readInstalledVersion, describeLayout } from '../core/layout.mjs';
import { loadPatches, appliesTo } from '../core/registry.mjs';
import { createScanContext, scanPatch } from '../core/scan.mjs';
import {
  compilePatch, mergeByFile, writeFiles, verifyPatch,
  resolveApplied, recordApplied, saveOriginals, listOriginals, restoreOriginals,
} from '../core/apply.mjs';

// ──────────────────────────────────────────────
//  patcher CLI
//
//  One command, one scan, any number of patches — which is the point of
//  replacing the standalone scripts. Running five of those meant five full
//  walks of a 2000-module tree and five independent writes to files they
//  often shared.
// ──────────────────────────────────────────────

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', blue: '\x1b[34m',
};
const ok = (s) => console.log(`${C.green}[OK]${C.reset} ${s}`);
const warn = (s) => console.log(`${C.yellow}[!]${C.reset} ${s}`);
const err = (s) => console.error(`${C.red}[X]${C.reset} ${s}`);
const info = (s) => console.log(`${C.blue}[>]${C.reset} ${s}`);

// Where a Claude Code install usually is. The patcher ships inside the
// restore repo, so the common case is "the package this repo publishes".
function findCli(explicit) {
  if (explicit) return explicit;
  const candidates = [];
  for (const pkg of ['@cometix/claude-code', '@anthropic-ai/claude-code']) {
    candidates.push(join(process.env.HOME ?? '', '.claude/local/node_modules', pkg, 'cli.js'));
    candidates.push(join('/usr/local/lib/node_modules', pkg, 'cli.js'));
    candidates.push(join('/usr/lib/node_modules', pkg, 'cli.js'));
    try {
      const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 5000 }).trim();
      if (root) candidates.push(join(root, pkg, 'cli.js'));
    } catch {}
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

function parseArgs(argv) {
  const flags = { command: 'list', ids: [], path: null, json: false, dryRun: false, all: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--path' && argv[i + 1]) flags.path = argv[++i];
    else if (a === '--json') flags.json = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--all') flags.all = true;
    else if (a === '--help' || a === '-h') flags.command = 'help';
    else rest.push(a);
  }
  if (rest.length > 0 && ['list', 'check', 'apply', 'restore', 'status'].includes(rest[0])) {
    flags.command = rest.shift();
  }
  flags.ids = rest;
  return flags;
}

function usage() {
  console.log(`
${C.bold}claude-code patcher${C.reset}

  patcher list                    show every patch and whether it applies
  patcher check [id...]           locate sites without writing anything
  patcher apply <id...> [--all]   apply patches
  patcher status                  what is applied, site by site
  patcher restore                 put every touched file back to pristine

  --path <cli.js>   target a specific install
  --dry-run         compute and verify the rewrite, write nothing

Each rewrite leaves a /*@cc:<patch>#<site>*/ marker beside it, so what is
applied can be read off the files. Originals are copied aside the first time
a file is touched and never overwritten, so restore always returns the bytes
npm installed — not an intermediate state left by an earlier run.
`);
}

async function resolveTarget(flags) {
  const cli = findCli(flags.path);
  if (!cli) {
    err('no Claude Code install found. Pass --path /path/to/cli.js');
    process.exit(1);
  }
  const layout = await detectLayout(cli);
  const version = await readInstalledVersion(layout.root);
  return { cli, layout, version };
}

// Scan the selected patches in one pass over the tree.
async function scanAll(patches, layout) {
  const ctx = createScanContext(layout);
  const results = [];
  for (const patch of patches) {
    results.push({ patch, result: await scanPatch(patch, ctx) });
  }
  return { ctx, results };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.command === 'help') return usage();

  const all = await loadPatches();
  if (all.length === 0) {
    err('no patches found in patcher/patches/');
    process.exit(1);
  }

  const { cli, layout, version } = await resolveTarget(flags);

  if (flags.command === 'restore') {
    const held = await listOriginals(layout.root);
    if (held.length === 0) { warn('nothing to restore — no originals held'); return; }
    const { files, patches } = await restoreOriginals(layout.root);
    ok(`restored ${files.length} file(s) to their pristine state`
      + (patches.length ? ` (was: ${patches.join(', ')})` : ''));
    return;
  }

  console.log(`\n${C.bold}Claude Code ${version ?? 'unknown'}${C.reset}  ${C.dim}·  ${describeLayout(layout)}${C.reset}\n`);

  // Applicability is decided before scanning: a patch outside its version
  // range should not spend a tree walk proving its sites are gone.
  const applicable = all.filter((p) => appliesTo(p, version));
  const skipped = all.filter((p) => !appliesTo(p, version));

  const appliedIds = await resolveApplied(layout.root, all.map((p) => p.id));

  if (flags.command === 'list' || flags.command === 'status') {
    for (const p of applicable) {
      const state = appliedIds.get(p.id);
      // A patch whose markers are only partly present was disturbed after it
      // was applied — worth flagging, since re-applying is blocked while any
      // marker remains.
      const partial = state && state.expected.length > 0
        && state.sites.length < state.expected.length;
      const mark = !state ? '[ ]'
        : partial ? `${C.yellow}[~]${C.reset}` : `${C.green}[x]${C.reset}`;
      const note = partial
        ? `  ${C.yellow}${state.sites.length}/${state.expected.length} sites${C.reset}` : '';
      console.log(`  ${mark} ${p.id.padEnd(30)} ${p.title}  ${C.dim}${p.risk ?? ''}${C.reset}${note}`);
      if (flags.command === 'status' && state) {
        console.log(`      ${C.dim}${state.sites.map((s) => `#${s}`).join(' ')}${C.reset}`);
      }
    }
    for (const p of skipped) {
      console.log(`  ${C.dim}( ) ${p.id.padEnd(30)} needs ${p.versions}${C.reset}`);
    }
    console.log();
    return;
  }

  const selected = flags.all
    ? applicable
    : applicable.filter((p) => flags.ids.includes(p.id));

  if (selected.length === 0) {
    err(flags.ids.length ? `no such patch: ${flags.ids.join(', ')}` : 'nothing selected (pass ids or --all)');
    process.exit(1);
  }

  // Filtered before scanning, not after. An applied patch has by definition
  // changed the shape it matched on — cleanup-period's declaration no longer
  // holds a value under 365 once it reads 9999 — so scanning it again finds
  // nothing and reports that as drift. Which is true, but it is drift this
  // tool caused, and saying so is noise.
  const pending = [];
  for (const p of selected) {
    const state = appliedIds.get(p.id);
    if (state) warn(`${p.id}: already applied (${state.sites.map((s) => `#${s}`).join(' ')})`);
    else pending.push(p);
  }
  if (pending.length === 0) {
    console.log(`\nNothing to do — all selected patches are applied\n`);
    return;
  }

  info(`scanning ${layout.files.length} file(s) for ${pending.length} patch(es)…`);
  const { ctx, results } = await scanAll(pending, layout);

  const usable = [];
  for (const { patch, result } of results) {
    if (!result.ok) {
      err(`${patch.id}: site "${result.missing}" not found (stage ${result.stage})`);
      continue;
    }
    ok(`${patch.id}: ${result.sites.length} site(s) located`
      + (Object.keys(result.values).length
        ? `  ${C.dim}${JSON.stringify(result.values)}${C.reset}` : ''));
    for (const s of result.sites) {
      console.log(`      ${C.dim}${s.site.id.padEnd(22)} ${s.file}${C.reset}`);
    }
    usable.push({ patch, result });
  }

  // A marker that survived while its predicate matched nothing is the signal
  // that a shape drifted, and is worth surfacing even on a successful run.
  if (ctx.markerOnly.length > 0) {
    warn(`${ctx.markerOnly.length} site(s) found their marker but matched nothing — shape may have drifted`);
    for (const m of ctx.markerOnly.slice(0, 5)) {
      console.log(`      ${C.dim}${m.site} — marker present in ${m.files.length} file(s)${C.reset}`);
    }
  }

  if (usable.length === 0) { console.log(); return; }
  if (flags.command === 'check') {
    console.log(`\n${usable.length} patch(es) ready to apply\n`);
    return;
  }

  const merged = mergeByFile(usable.map(({ patch, result }) => compilePatch(patch, result)));
  const { written, originals } = await writeFiles(layout.root, merged, { dryRun: flags.dryRun });

  if (!flags.dryRun) {
    const ids = usable.map((u) => u.patch.id);
    const { added, held } = await saveOriginals(layout.root, originals, ids);
    await recordApplied(layout.root, usable.map(({ patch, result }) => ({
      id: patch.id,
      files: [...compilePatch(patch, result).keys()],
      sites: [...new Set(result.sites.filter((s) => s.site.edit).map((s) => s.site.id))],
    })));
    info(added.length > 0
      ? `kept ${added.length} pristine copy(ies); ${held} file(s) held in total`
      : `originals already held for all ${held} touched file(s)`);

    for (const { patch, result } of usable) {
      const problems = await verifyPatch(layout.root, patch, merged, result.values);
      if (problems.length > 0) {
        err(`${patch.id}: verification failed — ${problems.join('; ')}`);
      }
    }
  }

  console.log();
  for (const w of written) {
    ok(`${w.file}  ${w.edits} edit(s)  ${w.bytes >= 0 ? '+' : ''}${w.bytes} bytes`);
  }
  console.log(`\n${flags.dryRun ? 'Dry run — nothing written' : `Applied ${usable.length} patch(es) across ${written.length} file(s)`}\n`);
}


main().catch((e) => {
  err(e.message);
  process.exit(1);
});
