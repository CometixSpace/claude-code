import { readdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { build as esbuild } from 'esbuild';
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
//  read import.meta.dir, or find a global Bun, which is what E1–E8 below
//  supply.
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

// Path from the referencing file's directory back to the extract root, which
// is what every BunFS target is named relative to. Prepending it to a target
// yields the correct specifier at any depth on either side — the referencing
// file may be nested (src/plugins/**), and so may the target, since the name
// after the BunFS root keeps its own directories.
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
  // Every target is rewritten relative to the file doing the referencing,
  // whatever its kind. require() needs the explicit "./" anyway, and the
  // asset loader resolves `isAbsolute(t) ? t : join(dir, t)` against
  // import.meta.dirname — which is the *referencing* file's directory, not
  // the package root. A bare name only works while everything sits at the
  // root; the moment upstream nests a chunk, join() would look for the asset
  // beside that chunk instead. Carrying the prefix costs nothing today
  // (join(root, "./x") === join(root, "x")) and keeps the depth correct.
  code = code.replace(LITERAL_RE, (_m, target) => {
    literals++;
    return JSON.stringify(`${prefix}${target}`);
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
//  skills — 164 prompt and template files pulled in at chunk top level. As of
//  v2.1.302, skills can also embed .mjs helpers as source text; executing one
//  here can run its CLI entry point and terminate Claude Code.
//
//    var a = e("/$bunfs/root/anti-patterns-c1rmzbdk.md");
//
//  Node would compile the markdown as JS and throw, taking the whole chunk
//  with it, so route those extensions through readFileSync instead. Resolve
//  through the module's require first: E2 emits relative paths, while fs
//  would otherwise interpret them against the caller's working directory.
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

const TEXT_LOADER_EXT = /\.(?:md|txt|mjs)$/;

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
  `if(${TEXT_LOADER_EXT}.test(id))return __ccReadText(__ccRawRequire.resolve(id),"utf8");` +
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

// ──────────────────────────────────────────────
//  E6: the hooks worker → __ccHooksWorker
//
//  Function-hook modules run in a worker created with `new Worker(url, opts)`.
//  Node has no global Worker, so that construction throws and the hooks host
//  dies with it.
//
//  Only this one site is rewritten. Several bundled libraries — node-forge
//  among them — also construct Workers, and branch on `typeof Worker` to pick
//  a single-threaded path when there is none. Installing a global would send
//  them down the threaded path into an adapter built for something else, so
//  the shim stays under a private name and only the hooks site points at it.
//
//  The site is identified by its argument, not by position: the URL comes
//  from a helper resolving HOOKS_WORKER_URL, which is what makes it the hooks
//  worker rather than any other. Through 2.1.294 the helper is called right
//  in the argument list; since 2.1.295 it is a parameter default,
//  `function f(e = helper()) { … new Worker(e, …) }`, so an identifier
//  argument is followed back to the default of the parameter it names.
//
//  The helper's HOOKS_WORKER_URL needs fixing too. Upstream it is a BunFS
//  path the helper appends to a scheme — `new URL(\`file://${e}\`)`, or on
//  Windows the bare path once it starts with the BunFS root. E2 has made it
//  relative ("./src/…") and the root "./", so on macOS/Linux the URL came
//  out as file://./src/… — host "." — and Node refused it ("File URL host
//  must be "localhost" or empty"), while Windows handed the worker a path
//  Node resolves against the working directory. No plugin's hooks module
//  could load. Inside the helper the value becomes what upstream meant: an
//  absolute path that reads as a file URL after `file://`, resolved from
//  the chunk E2 made it relative to.
// ──────────────────────────────────────────────

// href minus "file://": "/Users/…" on POSIX, "/C:/Users/…" on Windows — the
// latter misses the "./" root test and takes the URL branch as well.
const absoluteFileUrlPath = (rel) =>
  `new URL(${JSON.stringify(rel)},import.meta.url).href.slice(7)`;

export function rewriteHooksWorker(code) {
  if (!code.includes('HOOKS_WORKER_URL') || !code.includes('Worker')) {
    return { code, rewritten: 0, urls: 0 };
  }
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return { code, rewritten: 0, urls: 0 };
  }

  // The chunk that builds the hooks worker also carries library code that
  // constructs its own, so find the helper resolving HOOKS_WORKER_URL first
  // and rewrite only the Worker taking its result.
  const providers = new Map();
  const workers = [];
  // `defaults` maps each parameter name in scope to its default expression;
  // a nearer parameter of the same name without one shadows it.
  (function visit(node, defaults) {
    const body = node.type === 'VariableDeclarator' ? node.init
      : node.type === 'FunctionDeclaration' ? node.body
      : null;
    if (body && node.id?.type === 'Identifier') {
      const source = code.slice(body.start, body.end);
      if (source.includes('HOOKS_WORKER_URL') && source.includes('hooks-worker')) {
        providers.set(node.id.name, body);
      }
    }
    if (Array.isArray(node.params)) {
      defaults = new Map(defaults);
      for (const param of node.params) {
        if (param.type === 'AssignmentPattern' && param.left.type === 'Identifier') {
          defaults.set(param.left.name, param.right);
        } else if (param.type === 'Identifier') {
          defaults.delete(param.name);
        }
      }
    }
    if (node.type === 'NewExpression' && node.callee?.name === 'Worker') {
      const arg = node.arguments[0];
      workers.push({ node, url: arg?.type === 'Identifier' ? defaults.get(arg.name) : arg });
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item.type === 'string') visit(item, defaults);
      } else if (child && typeof child.type === 'string') {
        visit(child, defaults);
      }
    }
  })(ast, new Map());

  const matches = workers
    .filter(({ url }) => url?.type === 'CallExpression' && providers.has(url.callee?.name));

  const edits = matches.map(({ node }) => ({
    start: node.callee.start, end: node.callee.end, text: 'globalThis.__ccHooksWorker',
  }));

  // Only the helpers a rewritten Worker actually draws from.
  const urlEdits = [];
  for (const name of new Set(matches.map(({ url }) => url.callee.name))) {
    (function visit(node) {
      if (node.type === 'Property' && !node.computed
          && (node.key.name ?? node.key.value) === 'HOOKS_WORKER_URL'
          && node.value.type === 'Literal' && typeof node.value.value === 'string'
          && /^\.\.?\//.test(node.value.value)) {
        urlEdits.push({
          start: node.value.start, end: node.value.end,
          text: absoluteFileUrlPath(node.value.value),
        });
      }
      for (const key of Object.keys(node)) {
        const child = node[key];
        if (Array.isArray(child)) {
          for (const item of child) if (item && typeof item.type === 'string') visit(item);
        } else if (child && typeof child.type === 'string') {
          visit(child);
        }
      }
    })(providers.get(name));
  }

  let out = code;
  for (const { start, end, text } of [...edits, ...urlEdits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, start) + text + out.slice(end);
  }
  return { code: out, rewritten: matches.length, urls: urlEdits.length };
}

// ──────────────────────────────────────────────
//  E7: node-fetch → the global fetch
//
//  Bun resolves `node-fetch` to a built-in module. Node has no such package,
//  and the one importer — gaxios, Google Auth's HTTP layer — reaches for it
//  with no catch around the call, so every Vertex AI request throws
//  ERR_MODULE_NOT_FOUND before it is sent.
//
//  The specifier is repointed at templates/node-fetch-compat.mjs rather than
//  the package being added as a dependency; the reasoning for that is in the
//  shim's own header.
//
//  Matched on the AST rather than by text: "node-fetch" also appears in the
//  embedded package.json metadata gaxios carries, and only a specifier
//  position is a module resolution.
// ──────────────────────────────────────────────

const NODE_FETCH_MODULE = 'node-fetch-compat.mjs';

export function rewriteNodeFetch(code, prefix) {
  if (!code.includes('node-fetch')) return { code, rewritten: 0 };
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return { code, rewritten: 0 };
  }

  const sites = [];
  (function visit(node) {
    // `import x from "node-fetch"`, `export … from "node-fetch"`, and the
    // dynamic `import("node-fetch")` all park the specifier in .source.
    const source = (node.type === 'ImportDeclaration'
      || node.type === 'ImportExpression'
      || node.type === 'ExportNamedDeclaration'
      || node.type === 'ExportAllDeclaration') ? node.source : null;
    if (source?.type === 'Literal' && source.value === 'node-fetch') sites.push(source);
    // require("node-fetch") — the CJS chunks reach it this way.
    if (node.type === 'CallExpression'
        && node.callee?.type === 'Identifier' && node.callee.name === 'require'
        && node.arguments[0]?.type === 'Literal'
        && node.arguments[0].value === 'node-fetch') {
      sites.push(node.arguments[0]);
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item.type === 'string') visit(item);
      } else if (child && typeof child.type === 'string') {
        visit(child);
      }
    }
  })(ast);

  let out = code;
  for (const node of sites.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, node.start)
      + JSON.stringify(`${prefix}${NODE_FETCH_MODULE}`)
      + out.slice(node.end);
  }
  return { code: out, rewritten: sites.length };
}

// ──────────────────────────────────────────────
//  E8: Bun's import.meta properties → Node's
//
//  Bun gives every module import.meta.dir and import.meta.path; Node names
//  the same two values import.meta.dirname and import.meta.filename. Under
//  Node the Bun names are simply undefined — nothing fails where they are
//  read, only wherever the value is next used as a path.
//
//  Five built-in plugins have built their hooks module with
//  R4(import.meta.dir, …) since the split layout arrived. Through 2.1.280
//  nothing joined that folder at startup, so the undefined went unnoticed;
//  2.1.281's plugin loader does, and every interactive start ended at the
//  mount watchdog:
//
//    Claude Code could not start: The "path" argument must be of type
//    string. Received undefined
//
//  Matched on the AST, as E7 is: chunks carry bundled documentation, and a
//  string mentioning import.meta.dir is not a property access.
// ──────────────────────────────────────────────

const BUN_IMPORT_META = { dir: 'dirname', path: 'filename' };

// What Node itself defines on import.meta. Anything else still read off it
// after E8 is Bun-only, and undefined here.
const NODE_IMPORT_META = new Set(['url', 'dirname', 'filename', 'resolve']);

// Every non-computed `import.meta.<name>` read in a module, or null when the
// module does not parse.
function importMetaReads(code) {
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return null;
  }
  const reads = [];
  (function visit(node) {
    if (node.type === 'MemberExpression' && !node.computed
        && node.object.type === 'MetaProperty'
        && node.object.meta.name === 'import' && node.object.property.name === 'meta') {
      reads.push(node.property);
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item.type === 'string') visit(item);
      } else if (child && typeof child.type === 'string') {
        visit(child);
      }
    }
  })(ast);
  return reads;
}

export function rewriteImportMeta(code) {
  if (!/import\.meta\.(?:dir|path)\b/.test(code)) return { code, rewritten: 0 };
  const sites = (importMetaReads(code) ?? []).filter((p) => Object.hasOwn(BUN_IMPORT_META, p.name));
  let out = code;
  for (const p of sites.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, p.start) + BUN_IMPORT_META[p.name] + out.slice(p.end);
  }
  return { code: out, rewritten: sites.length };
}

// The Bun-only import.meta properties a module still reads. E8 maps the two
// with a Node equivalent; the rest — import.meta.main, .env, .file — have
// none, and a new one appearing upstream has to fail the build rather than
// ship a session that dies on start.
const BUN_META_TEXT = /import\.meta\.(?!(?:url|dirname|filename|resolve)\b)([A-Za-z_$][\w$]*)/g;

export function bunOnlyImportMeta(code) {
  // matchAll works on a copy of the regex, so the shared one keeps no
  // lastIndex between calls — a .test() first would, and the copy would
  // then start searching after the only match.
  const mentioned = [...code.matchAll(BUN_META_TEXT)].map((m) => m[1]);
  if (mentioned.length === 0) return [];
  const reads = importMetaReads(code);
  // A module that does not parse gets the textual answer: over-reporting
  // stops a build that is broken anyway, under-reporting would not.
  const names = reads ? reads.map((p) => p.name) : mentioned;
  return [...new Set(names.filter((n) => !NODE_IMPORT_META.has(n)))];
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
//  E9: `claude plugin test` children → VM Modules flags
//
//  `claude plugin test` runs each test file in a child of the current binary
//  (`plugin test --file <file> <root>`), and the child loads the testing kit
//  through vm.SourceTextModule. Bun has it built in; Node only exposes it
//  under --experimental-vm-modules, so every test file failed to load:
//
//    TypeError: uo.SourceTextModule is not a constructor
//
//  The child's environment is rebuilt from a whitelist with extendEnv off,
//  so a NODE_OPTIONS the user sets never reaches it. The flags go into that
//  environment at the spawn site, wrapping whatever expression builds it —
//  a call in 2.1.285 (`env: f(g())`), an object of spreads by 2.1.303. The
//  child's stderr is inherited, so the warning flag is what keeps the
//  ExperimentalWarning off the parent's terminal.
// ──────────────────────────────────────────────

const PLUGIN_TEST_ARGV = /["']plugin["']\s*,\s*["']test["']\s*,\s*["']--file["']/;
const VM_MODULES_NODE_OPTIONS = '--experimental-vm-modules --disable-warning=ExperimentalWarning';

const propertyNamed = (object, name) => object.properties.find((p) =>
  p.type === 'Property' && !p.computed && (p.key.name ?? p.key.value) === name);

export function rewritePluginTestEnv(code) {
  if (!PLUGIN_TEST_ARGV.test(code)) return { code, rewritten: 0 };
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return { code, rewritten: 0 };
  }

  // spawn(cmd, [...prefix, "plugin", "test", "--file", file, root], { env, … })
  const sites = [];
  (function visit(node) {
    if (node.type === 'CallExpression') {
      const [, argv, options] = node.arguments;
      const args = argv?.type === 'ArrayExpression' ? argv.elements : [];
      const isTestChild = args.some((arg, i) => arg?.value === 'plugin'
        && args[i + 1]?.value === 'test' && args[i + 2]?.value === '--file');
      const env = isTestChild && options?.type === 'ObjectExpression'
        ? propertyNamed(options, 'env') : null;
      // An environment that already sets NODE_OPTIONS means upstream took
      // this over; leave it to them.
      const settled = env?.value.type === 'ObjectExpression'
        && propertyNamed(env.value, 'NODE_OPTIONS');
      if (env && !settled) sites.push(env);
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item.type === 'string') visit(item);
      } else if (child && typeof child.type === 'string') {
        visit(child);
      }
    }
  })(ast);

  // The whole property is replaced, so a shorthand `{ env }` comes out right.
  let out = code;
  for (const prop of sites.sort((a, b) => b.start - a.start)) {
    const value = out.slice(prop.value.start, prop.value.end);
    out = out.slice(0, prop.start)
      + `env:{...(${value}),NODE_OPTIONS:${JSON.stringify(VM_MODULES_NODE_OPTIONS)}}`
      + out.slice(prop.end);
  }
  return { code: out, rewritten: sites.length };
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
    metaRequire: 0, rebrand: 0, hoisted: 0, hooksWorkers: 0, hooksWorkerUrls: 0, nodeFetch: 0,
    importMeta: 0, pluginTestMarkers: 0, pluginTests: 0, ast: {},
  };
  let leftover = 0;
  const bunOnly = [];

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

    const hooksWorker = rewriteHooksWorker(code);
    code = hooksWorker.code;
    stats.hooksWorkers += hooksWorker.rewritten;
    stats.hooksWorkerUrls += hooksWorker.urls;

    if (PLUGIN_TEST_ARGV.test(code)) stats.pluginTestMarkers++;
    const pluginTest = rewritePluginTestEnv(code);
    code = pluginTest.code;
    stats.pluginTests += pluginTest.rewritten;

    const nodeFetch = rewriteNodeFetch(code, prefix);
    code = nodeFetch.code;
    stats.nodeFetch += nodeFetch.rewritten;

    const meta = patchImportMetaRequire(code);
    code = meta.code;
    if (meta.patched) stats.metaRequire++;

    const metaProps = rewriteImportMeta(code);
    code = metaProps.code;
    stats.importMeta += metaProps.rewritten;

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
    for (const name of bunOnlyImportMeta(code)) bunOnly.push(`${rel}: import.meta.${name}`);
  }

  // Checked on what is about to ship, after every rewrite. An import.meta
  // property Node does not define reads as undefined without complaint, so
  // nothing downstream catches it — 2.1.281 shipped five such reads and
  // failed only when a user started a session.
  if (bunOnly.length > 0) {
    throw new Error(`Bun-only import.meta properties remain after patching:\n  ${bunOnly.join('\n  ')}`);
  }

  // Bun.Image is sharp's API under another name, so bundle sharp's JS half
  // next to the entry. Only the prebuilt natives stay external — they come
  // from the @img/sharp-* optional dependencies the main package lists, and
  // are picked per platform at install time. @img/colour is pure JS and has
  // to be inlined, or the bundle fails to resolve it at runtime.
  await esbuild({
    absWorkingDir: join(__dirname, '..'),
    entryPoints: {
      'bun-sharp-compat': 'sharp',
      // Backs Bun.Transpiler — Sucrase and Acorn, bundled so the shipped
      // package carries no dependency of its own for this.
      'bun-transpiler-compat': join(__dirname, '..', 'templates', 'bun-transpiler-compat.cjs'),
    },
    outdir: extractDir,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    minify: true,
    external: ['@img/sharp-*'],
  });
  await writeFile(
    join(extractDir, 'bun-image-compat.cjs'),
    readFileSync(join(__dirname, '..', 'templates', 'bun-image-compat.cjs')),
  );
  // Target of the E7 rewrites above. Written whether or not any fired, so a
  // chunk that starts importing node-fetch later resolves rather than
  // half-resolving against a file that was never shipped.
  await writeFile(
    join(extractDir, NODE_FETCH_MODULE),
    readFileSync(join(__dirname, '..', 'templates', 'node-fetch-compat.mjs')),
  );

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

  // A tree carrying the hooks worker has exactly one place that starts it.
  // Anything else means the shape moved and the rewrite is now aimed at the
  // wrong construction — or at none, which would ship hooks that cannot run.
  if (entries.length > 1 && stats.hooksWorkers !== 1) {
    throw new Error(
      `expected one hooks Worker creation site, rewrote ${stats.hooksWorkers}`,
    );
  }
  // The construction alone is not enough: with its URL still relative the
  // worker starts nowhere, and every plugin's hooks module fails to load.
  if (entries.length > 1 && stats.hooksWorkerUrls === 0) {
    throw new Error('found the hooks Worker, but no relative HOOKS_WORKER_URL in its helper to resolve');
  }

  // The argv survived but no spawn carrying it was rewritten: the call moved
  // to a shape E9 does not know, and plugin test children would start
  // without SourceTextModule again.
  if (stats.pluginTestMarkers > 0 && stats.pluginTests === 0) {
    throw new Error(
      `plugin test child argv found in ${stats.pluginTestMarkers} module(s), but no spawn site was rewritten`,
    );
  }

  return stats;
}

export { POLYFILL_MODULE, formatScanReport };
