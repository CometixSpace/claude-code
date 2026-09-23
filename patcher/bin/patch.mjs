#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { describeLayout } from '../core/layout.mjs';
import { probe } from '../core/probe.mjs';
import { listOriginals } from '../core/apply.mjs';
import {
  openInstall, applyPatches, restoreAll, reconcile, withoutIds, isPartial,
} from '../core/session.mjs';

// ──────────────────────────────────────────────
//  patcher CLI
//
//  One command, one scan, any number of patches — which is the point of
//  replacing the standalone scripts. Running five of those meant five full
//  walks of a 2000-module tree and five independent writes to files they
//  often shared.
//
//  Run in a terminal with no command, it opens the interactive picker
//  instead. Both are front ends over core/session.mjs; this file only
//  decides what to print.
// ──────────────────────────────────────────────

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', blue: '\x1b[34m',
};
const ok = (s) => console.log(`${C.green}[OK]${C.reset} ${s}`);
const warn = (s) => console.log(`${C.yellow}[!]${C.reset} ${s}`);
const err = (s) => console.error(`${C.red}[X]${C.reset} ${s}`);
const info = (s) => console.log(`${C.blue}[>]${C.reset} ${s}`);

const COMMANDS = ['list', 'check', 'apply', 'remove', 'restore', 'status', 'probe'];

// The global node_modules, asked of npm once.
function globalRoot() {
  try {
    // npm is npm.cmd on Windows, and Node refuses to spawn a .cmd without a
    // shell (CVE-2024-27980), so there it has to go through one.
    const win = process.platform === 'win32';
    return execFileSync(win ? 'npm.cmd' : 'npm', ['root', '-g'],
      { encoding: 'utf8', timeout: 5000, shell: win }).trim() || null;
  } catch {
    return null;
  }
}

// Where a Claude Code install usually is. The patcher ships inside the
// restore repo, so the common case is "the package this repo publishes".
function findCli(explicit) {
  if (explicit) return explicit;
  const npmRoot = globalRoot();
  const candidates = [];
  for (const pkg of ['@cometix/claude-code', '@anthropic-ai/claude-code']) {
    candidates.push(join(homedir(), '.claude/local/node_modules', pkg, 'cli.js'));
    candidates.push(join('/usr/local/lib/node_modules', pkg, 'cli.js'));
    candidates.push(join('/usr/lib/node_modules', pkg, 'cli.js'));
    if (npmRoot) candidates.push(join(npmRoot, pkg, 'cli.js'));
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

function parseArgs(argv) {
  const flags = { command: null, ids: [], path: null, json: false, dryRun: false, all: false, limit: 20 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--path' && argv[i + 1]) flags.path = argv[++i];
    else if (a === '--json') flags.json = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--all') flags.all = true;
    else if (a === '--limit' && argv[i + 1]) flags.limit = Number(argv[++i]);
    else if (a === '--help' || a === '-h') flags.command = 'help';
    else rest.push(a);
  }
  if (!flags.command && rest.length > 0 && COMMANDS.includes(rest[0])) {
    flags.command = rest.shift();
  }
  // No command: the picker when a person is at a terminal, the list when
  // the output is going somewhere else.
  flags.command ??= process.stdin.isTTY && process.stdout.isTTY ? 'tui' : 'list';
  flags.ids = rest;
  return flags;
}

function usage() {
  console.log(`
${C.bold}claude-code patcher${C.reset}

  patcher                         pick patches interactively (in a terminal)
  patcher list                    show every patch and whether it applies
  patcher check [id...]           locate sites without writing anything
  patcher apply <id...> [--all]   apply patches (and what they require)
  patcher remove <id...>          take patches out, keeping the rest
  patcher status                  what is applied, site by site
  patcher restore                 put every touched file back to pristine
  patcher probe <site>            list every node a match hits (authoring aid)
                                  <site> is JSON or a .json file: {marker, match, capture}

  --path <cli.js>   target a specific install
  --dry-run         compute and verify the rewrite, write nothing
  --limit <n>       probe: hits to print (default 20)

Each rewrite leaves a /*@cc:<patch>#<site>*/ marker beside it, so what is
applied can be read off the files. Originals are copied aside the first time
a file is touched and never overwritten, so restore always returns the bytes
npm installed — not an intermediate state left by an earlier run.
`);
}

function header(install) {
  console.log(`\n${C.bold}Claude Code ${install.version ?? 'unknown'}${C.reset}  ${C.dim}·  ${describeLayout(install.layout)}${C.reset}\n`);
}

function printList(install, withSites) {
  for (const p of install.applicable) {
    const state = install.applied.get(p.id);
    // A patch whose markers are only partly present was disturbed after it
    // was applied — worth flagging, since re-applying is blocked while any
    // marker remains.
    const partial = isPartial(state);
    const mark = !state ? '[ ]'
      : partial ? `${C.yellow}[~]${C.reset}` : `${C.green}[x]${C.reset}`;
    const note = partial
      ? `  ${C.yellow}${state.sites.length}/${state.expected.length} sites${C.reset}` : '';
    console.log(`  ${mark} ${p.id.padEnd(30)} ${p.title}  ${C.dim}${p.risk ?? ''}${C.reset}${note}`);
    if (withSites && state) {
      console.log(`      ${C.dim}${state.sites.map((s) => `#${s}`).join(' ')}${C.reset}`);
    }
  }
  for (const p of install.skipped) {
    console.log(`  ${C.dim}( ) ${p.id.padEnd(30)} needs ${p.versions}${C.reset}`);
  }
  console.log();
}

// A patch's scan result, as it arrives.
function printScanned({ patch, result }) {
  if (!result.ok) {
    err(`${patch.id}: site "${result.missing}" not found (stage ${result.stage})`);
    return;
  }
  ok(`${patch.id}: ${result.sites.length} site(s) located`
    + (Object.keys(result.values).length
      ? `  ${C.dim}${JSON.stringify(result.values)}${C.reset}` : ''));
  for (const s of result.sites) {
    console.log(`      ${C.dim}${s.site.id.padEnd(22)} ${s.file}${C.reset}`);
  }
  // Sites upstream already satisfies. Worth showing — it is how a patch
  // quietly becomes redundant — but it is not a failure.
  for (const s of result.satisfied ?? []) {
    console.log(`      ${C.dim}${s.site.padEnd(22)} already satisfied upstream${C.reset}`);
  }
}

function printReport(install, report, { check }) {
  for (const [id, by] of report.pulled) info(`${id}: included, required by ${by}`);
  for (const a of report.alreadyApplied) {
    warn(`${a.id}: already applied (${a.sites.map((s) => `#${s}`).join(' ')})`);
  }

  // A marker that survived while its predicate matched nothing is the signal
  // that a shape drifted, and is worth surfacing even on a successful run.
  if (report.markerOnly.length > 0) {
    warn(`${report.markerOnly.length} site(s) found their marker but matched nothing — shape may have drifted`);
    for (const m of report.markerOnly.slice(0, 5)) {
      console.log(`      ${C.dim}${m.site} — marker present in ${m.files.length} file(s)${C.reset}`);
    }
  }

  if (report.scanned.length === 0) {
    if (report.alreadyApplied.length > 0) console.log(`\nNothing to do — all selected patches are applied\n`);
    return;
  }
  if (report.applied.length === 0) { console.log(); return; }
  if (check) {
    console.log(`\n${report.applied.length} patch(es) ready to apply\n`);
    return;
  }

  for (const { id, files } of report.assets) {
    info(`${id}: installed ${files.length} file(s), `
      + `${(files.reduce((n, f) => n + f.bytes, 0) / 1e6).toFixed(1)}MB`);
  }
  if (report.originals) {
    const { added, held } = report.originals;
    info(added.length > 0
      ? `kept ${added.length} pristine copy(ies); ${held} file(s) held in total`
      : `originals already held for all ${held} touched file(s)`);
  }
  for (const v of report.verify) err(`${v.id}: verification failed — ${v.problems.join('; ')}`);

  console.log();
  for (const w of report.written) {
    ok(`${w.file}  ${w.edits} edit(s)  ${w.bytes >= 0 ? '+' : ''}${w.bytes} bytes`);
  }
  console.log(`\n${report.dryRun ? 'Dry run — nothing written' : `Applied ${report.applied.length} patch(es) across ${report.written.length} file(s)`}\n`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.command === 'help') return usage();

  const cli = findCli(flags.path);
  if (!cli) {
    err('no Claude Code install found. Pass --path /path/to/cli.js');
    process.exit(1);
  }
  const install = await openInstall(cli);
  if (install.patches.length === 0) {
    err('no patches found in patcher/patches/');
    process.exit(1);
  }

  if (flags.command === 'tui') {
    // Loaded only here: the plain commands keep working for someone who
    // has the engine's dependencies but not the UI's.
    const { runTui } = await import('../tui/index.mjs');
    return runTui(install);
  }

  if (flags.command === 'probe') {
    const arg = flags.ids.join(' ').trim();
    if (!arg) { err('probe needs a site: JSON text or a path to a .json file'); process.exit(1); }
    const site = JSON.parse(arg.startsWith('{') ? arg : await readFile(arg, 'utf8'));
    const r = await probe(install.layout, site, { limit: flags.limit });
    header(install);
    info(`${r.filesParsed} of ${r.filesScanned} file(s) passed the marker and were parsed`);
    for (const h of r.hits) {
      console.log(`\n  ${C.green}${h.file}${C.reset}  ${h.type}${h.name ? ` ${h.name}` : ''}  @${h.start}  ${h.bytes}B`);
      if (Object.keys(h.captures).length) console.log(`    ${C.blue}capture${C.reset} ${JSON.stringify(h.captures)}`);
      console.log(`    ${C.dim}${h.excerpt}${C.reset}`);
    }
    const tail = r.total > r.hits.length ? ` (showing ${r.hits.length}; --limit for more)` : '';
    (r.total === 1 ? ok : r.total === 0 ? err : warn)(`${r.total} hit(s)${tail}${r.total > 1 ? ' — a site takes the first unless nth says otherwise' : ''}`);
    console.log();
    return;
  }

  if (flags.command === 'restore') {
    const held = await listOriginals(install.layout.root);
    if (held.length === 0) { warn('nothing to restore — no originals held'); return; }
    const { files, patches, removedAssets } = await restoreAll(install);
    ok(`restored ${files.length} file(s) to their pristine state`
      + (patches.length ? ` (was: ${patches.join(', ')})` : ''));
    if (removedAssets?.length) info(`removed ${removedAssets.length} installed file(s)`);
    return;
  }

  header(install);

  if (flags.command === 'list' || flags.command === 'status') {
    printList(install, flags.command === 'status');
    return;
  }

  if (flags.command === 'remove') {
    const unknown = flags.ids.filter((id) => !install.applied.has(id));
    if (flags.ids.length === 0 || unknown.length > 0) {
      err(flags.ids.length ? `not applied: ${unknown.join(', ')}` : 'nothing selected (pass ids)');
      process.exit(1);
    }
    const { keep, also } = withoutIds(install, flags.ids);
    for (const id of also) info(`${id}: also removed, it requires what is being taken out`);
    info(`restoring, then re-applying ${keep.length} patch(es)…`);
    const { report } = await reconcile(install, keep, { onEvent: onScanned });
    printReport(install, report, { check: false });
    return;
  }

  // check / apply
  const ids = flags.all ? install.applicable.map((p) => p.id) : flags.ids;
  if (ids.length === 0) {
    err('nothing selected (pass ids or --all)');
    process.exit(1);
  }
  const check = flags.command === 'check';
  let scanning = false;
  const report = await applyPatches(install, ids, {
    dryRun: check || flags.dryRun,
    onEvent: (e) => {
      if (e.type === 'progress' && !scanning) {
        scanning = true;
        info(`scanning ${install.layout.files.length} file(s) for ${e.count} patch(es)…`);
      }
      onScanned(e);
    },
  });
  printReport(install, report, { check });
}

function onScanned(e) {
  if (e.type === 'scanned') printScanned(e);
  else if (e.type === 'restored') ok(`restored ${e.restored.files.length} file(s)`);
}

main().catch((e) => {
  err(e.message);
  process.exit(1);
});
