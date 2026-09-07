import { readFile, stat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MATCHERS, findSites } from './node-compat-patch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────
//  Patch site registry
//
//  Up to 2.1.241 every compatibility patch lived in one cli.js: if a pattern
//  stopped matching, the patch counter dropped to zero and the build log said
//  so. From 2.1.242 the same patches are scattered across ~1375 chunks, and a
//  site that quietly moves — or disappears — is indistinguishable from a file
//  that simply never had it.
//
//  Locating a site therefore has to be as reliable as patching it, which
//  means asking the AST, not a regex: the chunks are minified, so whitespace,
//  identifier names and member-access form all shift between builds. Each
//  site here points at the matcher astPatch itself uses, so a scan can never
//  claim a site the rewrite would then miss.
//
//  Fields:
//    matcher  key in MATCHERS — the AST predicate deciding a real match
//    marker   cheap substring gating whether the file is worth parsing at all
//             (~1375 chunks; full parsing costs minutes, this leaves ~85)
//    expect   'required' — the build stops if the site vanishes, since the
//             patch would otherwise ship as a silent no-op
//             'optional' — legitimately absent on some versions/platforms
// ──────────────────────────────────────────────

export const PATCH_SITES = [
  {
    id: 'P1-fileurl',
    matcher: 'p1Paths',
    description: 'fileURLToPath()/createRequire() over a baked-in CI build path',
    marker: 'claude-cli-internal',
    // Gone in split-ESM builds, where the bundler no longer wraps these.
    expect: 'optional',
  },
  {
    id: 'P1-createrequire',
    matcher: 'p1Requires',
    description: 'createRequire() over a baked-in CI build path',
    marker: 'claude-cli-internal',
    expect: 'optional',
  },
  {
    id: 'P1-dirname',
    matcher: 'p1Dirnames',
    description: 'Bare __dirname assigned a build-machine path (grpc-js proto lookup)',
    marker: 'claude-cli-internal',
    expect: 'optional',
  },
  {
    id: 'P2-bun-guard',
    matcher: 'p2',
    description: 'typeof Bun guard throwing "Bun required"',
    marker: 'Bun required',
    // Absent since the polyfill covers it; kept so its return is noticed.
    expect: 'optional',
  },
  {
    id: 'P3-napi',
    matcher: 'p3',
    description: 'BunFS require() of a native .node module',
    marker: '.node"',
    expect: 'required',
  },
  {
    id: 'P5-search-tools',
    matcher: 'p5',
    description: 'EMBEDDED_SEARCH_TOOLS guard inlined to a literal by the Bun build',
    marker: 'CLAUDE_CODE_ENTRYPOINT',
    // Only macOS/Linux builds inline the env read to isEnvTruthy("true").
    // Windows binaries keep `process.env.EMBEDDED_SEARCH_TOOLS` as written,
    // which is what P5a restores — there the patch has nothing to do.
    expect: 'optional',
  },
  {
    id: 'P7-proxy-agent',
    matcher: 'p7',
    description: 'Bundled HttpsProxyAgent export assignment',
    marker: 'HttpsProxyAgent',
    expect: 'required',
  },
  {
    id: 'P8-shadow-fn',
    matcher: 'p8',
    description: 'AF_() shadow function building the bfs/ugrep shell wrapper',
    marker: '_cc_bin',
    expect: 'required',
  },
  {
    id: 'P10-assets',
    matcher: 'p10',
    description: 'BunFS path constants for the bundled artifact runtimes',
    // The extension rather than the bare BunFS root: every chunk carries that
    // prefix in its import specifiers, which would defeat the filter.
    marker: '.min.js"',
    expect: 'required',
  },
  {
    id: 'P10-template',
    matcher: 'p10',
    description: 'BunFS path constant for the design-canvas payload template',
    marker: '.asset"',
    // Only present since v2.1.229.
    expect: 'optional',
  },
];

// P9 is a plain string replace with no AST shape, so it is tracked separately
// from the matcher-driven sites above.
export const REBRAND_FROM = '@anthropic-ai/claude-code';

// Markers worth an AST walk — anything else cannot match a patch.
export const AST_MARKERS = [...new Set(PATCH_SITES.map((s) => s.marker))];

export function mayContainPatchSite(code) {
  return AST_MARKERS.some((m) => code.includes(m));
}

// ──────────────────────────────────────────────
//  Scanning
//
//  Two passes: a substring filter that rules out ~94% of the tree without
//  parsing, then a real AST walk over what survives. The walk runs across
//  worker threads because acorn is synchronous and CPU-bound — one 7MB chunk
//  alone takes over a second.
// ──────────────────────────────────────────────

function emptyResult() {
  return new Map(PATCH_SITES.map((s) => [s.id, []]));
}

function siteIdsFor(hits) {
  return PATCH_SITES.filter((s) => hits[s.matcher]).map((s) => s.id);
}

// Single-threaded scan. Exported for callers that already hold the sources.
export function scanSources(fileMap, sourceType = 'module') {
  const found = emptyResult();
  for (const [rel, code] of Object.entries(fileMap)) {
    if (!mayContainPatchSite(code)) continue;
    for (const id of siteIdsIn(code, sourceType)) found.get(id).push(rel);
  }
  return finish(found);
}

// Parse, collect, drop. The AST of a 7MB minified chunk runs to millions of
// nodes, so it must not outlive the walk — holding several at once across
// eight platforms is what exhausts the heap.
function siteIdsIn(code, sourceType) {
  try {
    return siteIdsFor(findSites(code, sourceType));
  } catch {
    return []; // unparseable files cannot hold a patch site
  }
}

function finish(found) {
  const missing = PATCH_SITES
    .filter((s) => s.expect === 'required' && found.get(s.id).length === 0)
    .map((s) => s.id);
  return { found, missing };
}

// Parallel scan over a file list. Falls back to in-process scanning when the
// tree is small enough that spawning workers would cost more than it saves.
export async function scanPatchSites(extractDir, files, {
  sourceType = 'module',
  concurrency = Math.max(1, Math.min(4, availableParallelism() - 1)),
} = {}) {
  // Pass 1: substring filter. Files are read one at a time and dropped —
  // the tree is ~40MB, and every platform in a release run walks its own copy.
  const candidates = [];
  for (const rel of files) {
    if (mayContainPatchSite(await readFile(join(extractDir, rel), 'utf8'))) {
      candidates.push({ rel, size: (await stat(join(extractDir, rel))).size });
    }
  }
  if (candidates.length === 0) return finish(emptyResult());

  // Largest first, so the long poles start early rather than trailing a
  // nearly-finished batch.
  candidates.sort((a, b) => b.size - a.size);
  const queue = candidates.map((c) => c.rel);
  const found = emptyResult();

  // Pass 2: AST walk. Below a handful of files the worker startup and the
  // second module graph per thread cost more than the parsing they save.
  if (queue.length < 4 || concurrency === 1) {
    for (const rel of queue) {
      const code = await readFile(join(extractDir, rel), 'utf8');
      for (const id of siteIdsIn(code, sourceType)) found.get(id).push(rel);
    }
    for (const list of found.values()) list.sort();
    return finish(found);
  }

  const workerPath = join(__dirname, 'patch-site-worker.mjs');
  let cursor = 0;

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () =>
    new Promise((resolve, reject) => {
      const worker = new Worker(workerPath, { workerData: { extractDir, sourceType } });
      const finishWorker = () => worker.terminate().then(resolve, resolve);
      const next = () => {
        if (cursor >= queue.length) { finishWorker(); return; }
        worker.postMessage(queue[cursor++]);
      };
      worker.on('message', (msg) => {
        if (msg.hits) for (const id of siteIdsFor(msg.hits)) found.get(id).push(msg.rel);
        next();
      });
      worker.on('error', (err) => { worker.terminate().finally(() => reject(err)); });
      next();
    }),
  ));

  // Worker completion order is nondeterministic; sort so reports are stable.
  for (const list of found.values()) list.sort();
  return finish(found);
}

export function formatScanReport({ found, missing }) {
  const lines = [];
  for (const site of PATCH_SITES) {
    const files = found.get(site.id);
    const where = files.length === 0
      ? '—'
      : files.length <= 2 ? files.join(', ') : `${files[0]} (+${files.length - 1} more)`;
    const mark = files.length > 0 ? 'OK' : site.expect === 'required' ? '! ' : '--';
    lines.push(`  [${mark}] ${site.id.padEnd(18)} ${String(files.length).padStart(4)} file(s)  ${where}`);
  }
  if (missing.length > 0) {
    lines.push('');
    lines.push(`  Missing required sites: ${missing.join(', ')}`);
    lines.push('  The upstream bundle changed shape — those patches would ship as no-ops.');
  }
  return lines.join('\n');
}
