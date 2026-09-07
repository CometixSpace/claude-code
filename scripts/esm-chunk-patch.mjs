import { readdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { astPatch } from './node-compat-patch.mjs';
import { BUNFS_ROOTS } from './bun-sea-extract.mjs';
import {
  mayContainPatchSite, scanPatchSites, formatScanReport, REBRAND_FROM,
} from './patch-sites.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────
//  Split-ESM patcher (v2.1.242+)
//
//  Up to 2.1.241 the SEA embedded one ~28MB CommonJS bundle, patched as a
//  single cli.js. From 2.1.242 it ships a ~20KB ESM entry plus ~1375
//  chunk-*.js modules that import each other through Bun's virtual
//  filesystem, so patching happens directory-wide instead.
//
//  Node runs that layout as-is once the paths point at real files — the
//  chunks rely on ESM semantics, not on Bun-specific module behaviour.
//  What it cannot do is resolve /$bunfs/root/, call import.meta.require,
//  or find a global Bun, which is what E1–E4 below supply.
//
//  The P1–P10 compatibility patches are unchanged by the layout switch and
//  keep running through astPatch() in module mode.
// ──────────────────────────────────────────────

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ROOT_ALT = BUNFS_ROOTS.map(escapeRe).join('|');

// Import position: from"…", import"…", import("…"). Everything the module
// graph resolves goes through here.
const SPECIFIER_RE = new RegExp(`(from|import)(\\s*\\(?\\s*)"(?:${ROOT_ALT})([^"]+)"`, 'g');

// Whatever survives that pass is a runtime path — an fs.readFile target or
// a worker URL — never a specifier. Classifying by syntactic position keeps
// this correct when chunk naming changes, which extension sniffing does not.
const LITERAL_RE = new RegExp(`"(?:${ROOT_ALT})([^"]*)"`, 'g');

// ──────────────────────────────────────────────
//  E1: BunFS specifiers → relative paths
// ──────────────────────────────────────────────

// "./" at the root, "../" per level for entries nested under src/**
function prefixFor(relDir) {
  if (relDir === '.' || relDir === '') return './';
  const depth = relDir.split(sep).filter(Boolean).length;
  return '../'.repeat(depth);
}

export function rewriteBunfsPaths(code, prefix) {
  let specifiers = 0;
  let literals = 0;

  code = code.replace(SPECIFIER_RE, (_m, kw, gap, target) => {
    specifiers++;
    return `${kw}${gap}"${prefix}${target}"`;
  });

  // E2: runtime paths resolve through the globals the polyfill installs.
  // Native modules live under vendor/, everything else next to the entry.
  code = code.replace(LITERAL_RE, (_m, target) => {
    literals++;
    return target.endsWith('.node')
      ? `globalThis.__ccVendorNode(${JSON.stringify(target)})`
      : `globalThis.__ccAsset(${JSON.stringify(target)})`;
  });

  return { code, specifiers, literals };
}

// ──────────────────────────────────────────────
//  E3: import.meta.require → createRequire
//
//  Bun exposes import.meta.require; Node does not. 2.1.242 hoists it into a
//  single runtime chunk that re-exports it, so one rewrite reaches every
//  consumer. Object.assign keeps require.resolve/cache on the wrapper.
// ──────────────────────────────────────────────

const REQUIRE_SHIM =
  'import{createRequire as __ccMakeRequire}from"module";' +
  'const __ccRequire=__ccMakeRequire(import.meta.url);';

function firstStatementStart(code) {
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  return ast.body.length > 0 ? ast.body[0].start : code.length;
}

export function patchImportMetaRequire(code) {
  if (!code.includes('import.meta.require')) return { code, patched: false };
  const at = firstStatementStart(code);
  code = code.slice(0, at) + REQUIRE_SHIM + code.slice(at);
  code = code.replaceAll('import.meta.require', '__ccRequire');
  return { code, patched: true };
}

// ──────────────────────────────────────────────
//  E4: Bun polyfill as an ESM module
//
//  templates/bun-polyfill.js is written as CJS (require, __dirname). Rather
//  than fork it for this layout, wrap it in a prelude supplying those names
//  so both pipelines keep sharing one shim.
//
//  The helper globals live here too: astPatch's module-mode injections and
//  the E2 rewrites above both resolve through them, so they must exist
//  before any chunk body runs.
// ──────────────────────────────────────────────

const POLYFILL_MODULE = 'bun-polyfill.mjs';

const ESM_PRELUDE = [
  'import{createRequire as __ccCreateRequire}from"module";',
  'import{fileURLToPath as __ccFileURLToPath}from"url";',
  'import{dirname as __ccPathDirname,join as __ccJoin}from"path";',
  'const require=__ccCreateRequire(import.meta.url);',
  'const __filename=__ccFileURLToPath(import.meta.url);',
  'const __dirname=__ccPathDirname(__filename);',
  '',
].join('\n');

const ESM_HELPERS = [
  '',
  '// Names the patched chunks resolve against (see E2 and astPatch module mode)',
  'globalThis.__ccNodeRequire=require;',
  'globalThis.__ccDirname=()=>__dirname;',
  'globalThis.__ccAsset=(name)=>name?__ccJoin(__dirname,name):__dirname;',
  'globalThis.__ccVendorNode=(name)=>{',
  '  const base=name.replace(/\\.node$/,"");',
  '  const p=__ccJoin(__dirname,"vendor",base,process.arch+"-"+process.platform,name);',
  '  return require("fs").existsSync(p)?p:__ccJoin(__dirname,name);',
  '};',
  '',
].join('\n');

export function buildPolyfillModule(polyfillSource) {
  return ESM_PRELUDE + polyfillSource.replace(/^#![^\n]*\n/, '') + ESM_HELPERS;
}

// ──────────────────────────────────────────────
//  P1–P10 on split builds
//
//  Which files hold which patch site is declared in patch-sites.mjs, so a
//  site that moves between chunks — or vanishes upstream — is reported
//  rather than silently skipped. P9 is a plain string replace and runs on
//  every file, so it stays out of the AST path.
// ──────────────────────────────────────────────

const REBRAND_TO = '@cometix/claude-code';

// ──────────────────────────────────────────────
//  Whole-tree patch
// ──────────────────────────────────────────────

async function listJsFiles(dir, base = dir, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await listJsFiles(full, base, acc);
    else if (entry.name.endsWith('.js')) acc.push(relative(base, full));
  }
  return acc;
}

export async function patchSplitEsm({ extractDir, entryRel = 'cli.js' }) {
  const files = await listJsFiles(extractDir);
  const stats = {
    files: files.length, specifiers: 0, literals: 0,
    metaRequire: 0, rebrand: 0, ast: {},
  };
  let leftover = 0;

  // Locate every patch site before touching anything, so a required one that
  // moved or disappeared surfaces as a report line instead of a zero counter.
  // Has to run first: the rewrites below erase the very markers it looks for.
  const scan = await scanPatchSites(extractDir, files);
  stats.sites = scan;

  for (const rel of files) {
    const path = join(extractDir, rel);
    const before = await readFile(path, 'utf8');
    const prefix = prefixFor(dirname(rel));

    const rewritten = rewriteBunfsPaths(before, prefix);
    let code = rewritten.code;
    stats.specifiers += rewritten.specifiers;
    stats.literals += rewritten.literals;

    const meta = patchImportMetaRequire(code);
    code = meta.code;
    if (meta.patched) stats.metaRequire++;

    if (mayContainPatchSite(code)) {
      const result = astPatch(code, 'module');
      if (result.replacementCount > 0) {
        code = result.code;
        // The single-bundle path validates after patching; do the same here
        // so a bad rewrite fails the build instead of the user's session.
        try {
          acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
        } catch (e) {
          throw new Error(`post-patch AST validation failed for ${rel}: ${e.message}`);
        }
        // Count files touched per patch, so the numbers stay comparable
        // with the single-bundle pipeline's occurrence counts.
        for (const [k, v] of Object.entries(result.stats)) {
          if (v === true || (typeof v === 'number' && v > 0)) {
            stats.ast[k] = (stats.ast[k] ?? 0) + 1;
          }
        }
      }
    } else if (code.includes(REBRAND_FROM)) {
      // P9 still has to reach every chunk naming the npm package
      code = code.replaceAll(REBRAND_FROM, REBRAND_TO);
      stats.rebrand++;
    }

    if (code !== before) await writeFile(path, code);
    leftover += (code.match(new RegExp(ROOT_ALT, 'g')) || []).length;
  }

  // Ship the polyfill next to the entry and import it first, so globalThis.Bun
  // and the helper globals exist before any chunk body runs. Worker entries
  // start their own module graph and need the same treatment.
  const polyfillSource = readFileSync(
    join(__dirname, '..', 'templates', 'bun-polyfill.js'), 'utf8',
  );
  await writeFile(join(extractDir, POLYFILL_MODULE), buildPolyfillModule(polyfillSource));

  const entries = [entryRel, ...files.filter((f) => f.endsWith('hooks-worker.js'))];
  for (const rel of entries) {
    const path = join(extractDir, rel);
    let code = await readFile(path, 'utf8');
    const at = firstStatementStart(code);
    const importPath = prefixFor(dirname(rel)) + POLYFILL_MODULE;
    code = code.slice(0, at) + `import"${importPath}";` + code.slice(at);
    if (rel === entryRel && !code.startsWith('#!')) code = '#!/usr/bin/env node\n' + code;
    await writeFile(path, code);
  }
  stats.polyfillEntries = entries.length;
  stats.leftover = leftover;

  return stats;
}

export { POLYFILL_MODULE, formatScanReport };
