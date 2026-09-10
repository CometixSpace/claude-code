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

  // E2: runtime paths become relative, because the extract is already laid
  // out the way the code expects — native modules and assets sit beside the
  // chunks, not in a directory of our own making.
  //
  //   ve("/$bunfs/root/audio-capture.node")  → ve("./audio-capture.node")
  //   JJ("/$bunfs/root/mermaid.min.js", d)   → JJ("mermaid.min.js", d)
  //
  // Anything require() resolves — native modules and sibling chunks alike —
  // needs the explicit "./", or Node treats it as a package name. Assets go
  // through the loader's own `isAbsolute(t) ? t : join(dir, t)` against
  // import.meta.dirname, where a bare name already lands beside the entry.
  code = code.replace(LITERAL_RE, (_m, target) => {
    literals++;
    const viaRequire = target.endsWith('.node') || target.endsWith('.js');
    return JSON.stringify(viaRequire ? `${prefix}${target}` : target);
  });

  return { code, specifiers, literals };
}

// ──────────────────────────────────────────────
//  E3: import.meta.require → createRequire
//
//  Bun exposes import.meta.require; Node does not. 2.1.242 hoists it into a
//  single runtime chunk that re-exports it, so one rewrite reaches every
//  consumer.
//
//  Bun's require also honours its text loader: requiring a .md/.txt returns
//  the file's CONTENT, not a module. v2.1.246 leans on that for the bundled
//  skills — 164 prompt and template files pulled in at chunk top level:
//
//    var a = e("/$bunfs/root/anti-patterns-c1rmzbdk.md");
//
//  Node would compile the markdown as JS and throw, taking the whole chunk
//  with it, so route those extensions through readFileSync instead.
//
//  From 2.1.250 the bundler also loads sibling CHUNKS through require —
//  358 sites where 2.1.246 used only dynamic import(). The static import
//  graph stays acyclic, but a synchronous require is a second kind of edge
//  the splitter does not keep acyclic, and 8 of those close a loop back
//  through the import graph. Bun re-enters evaluation and hands back a
//  partly-initialised namespace; Node refuses, because that would break an
//  invariant the spec mandates, and throws ERR_REQUIRE_CYCLE_MODULE.
//
//  Some of those sites read tool-name constants, which every consumer
//  guards with `x ? [x] : []`. Others pull whole tool objects into the
//  registry, unguarded:
//
//    let kt = Zk();                                  // [ArtifactTool, …]
//    new Set([...kt.map((ft) => ft.name), …])         // throws on a hole
//
//  So handing back undefined during the cycle is not safe in general — it
//  reached 2.1.259 and took startup down with "Cannot read properties of
//  undefined (reading 'name')". Return a lazy stand-in instead: it resolves
//  the real export on first touch, which succeeds once the cycle has
//  finished evaluating. Primitives are read through directly, since a Proxy
//  cannot impersonate one (String(proxy) throws).
//
//  Object.assign keeps require.resolve/cache on the wrapper.
// ──────────────────────────────────────────────

const TEXT_LOADER_EXT = /\.(?:md|txt)$/;

const REQUIRE_SHIM =
  'import{createRequire as __ccMakeRequire}from"module";' +
  'import{readFileSync as __ccReadText}from"fs";' +
  'const __ccRawRequire=__ccMakeRequire(import.meta.url);' +
  'const __ccCyclic=(e)=>e&&e.code==="ERR_REQUIRE_CYCLE_MODULE";' +
  // Resolve the export, or report that the cycle is still live.
  'const __ccPeek=(id,p)=>{try{return{ok:!0,v:__ccRawRequire(id)[p]}}' +
  'catch(e){if(__ccCyclic(e))return{ok:!1};throw e}};' +
  // Stand-in for an export the cycle has not produced yet. Cached per
  // (module, property) so repeated grabs stay identical and === holds
  // between them. The target is a function: exports include callables, and
  // an arrow has no non-configurable own properties to violate the Proxy
  // invariants.
  'globalThis.__ccLazyVals??=new Map();' +
  'const __ccLazyVal=(id,p)=>{const k=id+"\\0"+p,m=globalThis.__ccLazyVals;' +
  'if(m.has(k))return m.get(k);' +
  'let v,got=!1;const g=()=>{if(!got){const r=__ccPeek(id,p);if(r.ok){v=r.v;got=!0}}return v};' +
  'const px=new Proxy(function(){},{get:(_,q)=>{const t=g();' +
  'if(t==null)return undefined;const x=t[q];' +
  'return typeof x==="function"?x.bind(t):x},' +
  'apply:(_,th,a)=>Reflect.apply(g(),th,a),' +
  'construct:(_,a)=>Reflect.construct(g(),a),' +
  'has:(_,q)=>{const t=g();return t!=null&&q in t},' +
  'ownKeys:()=>{const t=g();return t==null?[]:Reflect.ownKeys(t)},' +
  'getOwnPropertyDescriptor:(_,q)=>{const t=g();' +
  'const d=t==null?undefined:Reflect.getOwnPropertyDescriptor(t,q);' +
  'if(d)d.configurable=!0;return d},' +
  'getPrototypeOf:()=>{const t=g();return t==null?null:Reflect.getPrototypeOf(Object(t))}});' +
  'm.set(k,px);return px};' +
  // Retried on every access: the same id resolves normally once the cycle
  // that blocked it has finished evaluating. A primitive is returned as-is,
  // since no Proxy can impersonate one.
  'const __ccLazyNs=(id)=>new Proxy({},{get:(_,p)=>{' +
  'const r=__ccPeek(id,p);' +
  'if(r.ok)return r.v;' +
  'if(typeof p!=="string"||p==="then")return undefined;' +
  'return __ccLazyVal(id,p)},' +
  'has:(_,p)=>{try{return p in __ccRawRequire(id)}catch(e){if(__ccCyclic(e))return false;throw e}},' +
  'ownKeys:()=>{try{return Reflect.ownKeys(__ccRawRequire(id))}catch(e){if(__ccCyclic(e))return[];throw e}},' +
  'getOwnPropertyDescriptor:(_,p)=>{try{const d=Reflect.getOwnPropertyDescriptor(__ccRawRequire(id),p);' +
  'if(d)d.configurable=!0;return d}catch(e){if(__ccCyclic(e))return undefined;throw e}}});' +
  'const __ccRequire=Object.assign((id)=>{' +
  `if(${TEXT_LOADER_EXT}.test(id))return __ccReadText(id,"utf8");` +
  'try{return __ccRawRequire(id)}catch(e){if(__ccCyclic(e))return __ccLazyNs(id);throw e}},' +
  '__ccRawRequire);';

// ──────────────────────────────────────────────
//  Hoist top-level chunk requires to static imports
//
//  A require() only lands mid-cycle because the target has not finished
//  evaluating. Adding a bare `import "./chunk-x.js"` ahead of the module
//  body forces exactly that: ESM evaluates the target first, and the
//  original require becomes a cache hit that never sees the cycle.
//
//  2.1.259 has 149 such sites across 22 chunks — 64 of them in the one that
//  builds the tool registry. Requires inside function bodies are left alone:
//  they run after startup, where a plain require(esm) already works.
//
//  This is prevention; the lazy proxies above stay as the fallback for
//  whatever it cannot reach.
// ──────────────────────────────────────────────

const FN_TYPES = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
]);

export function hoistTopLevelChunkRequires(code, prefix) {
  if (!code.includes('import.meta.require')) return { code, hoisted: 0 };
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return { code, hoisted: 0 };
  }

  const targets = new Set();
  (function visit(node, inFn) {
    if (!inFn &&
        node.type === 'CallExpression' &&
        node.callee?.type === 'MemberExpression' &&
        node.callee.object?.type === 'MetaProperty' &&
        node.callee.property?.name === 'require' &&
        node.arguments?.length === 1) {
      const arg = node.arguments[0];
      if (arg?.type === 'Literal' && typeof arg.value === 'string') {
        const target = stripBunfsRoot(arg.value);
        if (target?.endsWith('.js')) targets.add(target);
      }
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item.type === 'string') visit(item, inFn || FN_TYPES.has(item.type));
        }
      } else if (child && typeof child.type === 'string') {
        visit(child, inFn || FN_TYPES.has(child.type));
      }
    }
  })(ast, false);

  if (targets.size === 0) return { code, hoisted: 0 };
  const imports = [...targets].map((t) => `import${JSON.stringify(prefix + t)};`).join('');
  const at = ast.body.length > 0 ? ast.body[0].start : code.length;
  return { code: code.slice(0, at) + imports + code.slice(at), hoisted: targets.size };
}

function stripBunfsRoot(value) {
  for (const root of BUNFS_ROOTS) {
    if (value.startsWith(root)) return value.slice(root.length);
  }
  return null;
}

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
  'import{dirname as __ccPathDirname}from"path";',
  'const require=__ccCreateRequire(import.meta.url);',
  'const __filename=__ccFileURLToPath(import.meta.url);',
  'const __dirname=__ccPathDirname(__filename);',
  '',
].join('\n');

// Only what astPatch's module mode injects still needs a global; E2 rewrites
// runtime paths to plain relative strings, so no asset or native-module
// helper is required.
const ESM_HELPERS = [
  '',
  '// Names the patched chunks resolve against (see astPatch module mode)',
  'globalThis.__ccNodeRequire=require;',
  'globalThis.__ccDirname=()=>__dirname;',
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
    metaRequire: 0, rebrand: 0, hoisted: 0, ast: {},
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

    // Hoisting reads the BunFS specifiers, so it has to run before they are
    // rewritten — and before E3, which turns import.meta.require into a call
    // this no longer recognises.
    const hoist = hoistTopLevelChunkRequires(before, prefix);
    stats.hoisted += hoist.hoisted;

    const rewritten = rewriteBunfsPaths(hoist.code, prefix);
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
