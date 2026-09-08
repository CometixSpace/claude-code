import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────
//  Bun API coverage
//
//  templates/bun-polyfill.js is written by hand, so its contents track what
//  we happened to notice breaking. Nothing checks it against what the bundle
//  actually calls, and a missing global does not fail the build — it throws
//  at runtime, on whichever feature path first reaches it.
//
//  So read both sides instead of maintaining the list by memory: collect
//  every Bun.* the extracted chunks touch, collect what the polyfill defines,
//  and report the difference. Both sides are read from the AST — Bun is a
//  global, so `Bun.x` survives minification as a member expression, but a
//  substring scan also matches it inside strings, comments and longer
//  member chains, and misses shorthand properties on the polyfill side.
//
//  Compressed assets get the same treatment (see collectCompressedAssets):
//  since 2.1.251 embedded text ships zstd-framed, and the loader sniffs the
//  magic rather than the extension, so the only way to know what needs
//  Bun.zstdDecompress* is to look at the bytes.
// ──────────────────────────────────────────────

// zstd frame magic — what the bundle's own loader checks for.
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

export function isZstdFramed(buf) {
  return buf.length >= 4 && ZSTD_MAGIC.every((b, i) => buf[i] === b);
}

// ──────────────────────────────────────────────
//  What the bundle calls
// ──────────────────────────────────────────────

function walk(node, visit) {
  visit(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) if (item && typeof item.type === 'string') walk(item, visit);
    } else if (child && typeof child.type === 'string') {
      walk(child, visit);
    }
  }
}

// Bun.x / Bun.x.y / Bun["x"] — the object has to be the global itself, which
// keeps `foo.Bun.bar` and the string "Bun.spawn" out of the results.
//
// Also records whether the call site can survive the API being absent. An
// unguarded call throws where it stands; one behind `typeof`, `?.` or a
// try/catch degrades instead, which is the difference between a missing
// polyfill entry that breaks startup and one that quietly disables a
// feature. Bun.ant is only ever reached through such guards, for instance,
// while Bun.TOML.parse is not.
export function collectBunApis(code, sourceType = 'module') {
  const found = new Map();   // name → { guarded }
  if (!code.includes('Bun')) return found;
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType });
  } catch {
    return found;
  }

  const propName = (node) => (node.computed
    ? (node.property?.type === 'Literal' ? node.property.value : null)
    : node.property?.name);

  (function visit(node, guarded) {
    if (node.type === 'MemberExpression' &&
        node.object?.type === 'Identifier' && node.object.name === 'Bun') {
      const name = propName(node);
      if (typeof name === 'string') {
        const safe = guarded || node.optional === true;
        const prev = found.get(name);
        // One unguarded site is enough to make the API load-bearing.
        found.set(name, {
          guarded: prev ? prev.guarded && safe : safe,
          members: prev?.members ?? new Set(),
        });
      }
    }
    // Bun.X.Y — a namespace being polyfilled says nothing about the method
    // actually called on it. Bun.hash existed while Bun.hash.xxHash64 did
    // not, and only the second-level name shows that.
    if (node.type === 'MemberExpression' &&
        node.object?.type === 'MemberExpression' &&
        node.object.object?.type === 'Identifier' &&
        node.object.object.name === 'Bun') {
      const ns = propName(node.object);
      const member = propName(node);
      if (typeof ns === 'string' && typeof member === 'string') {
        const entry = found.get(ns) ?? { guarded: true, members: new Set() };
        entry.members.add(member);
        found.set(ns, entry);
      }
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      let g = guarded;
      if (node.type === 'TryStatement' && key === 'block') g = true;
      if (node.type === 'ChainExpression') g = true;
      if (node.type === 'UnaryExpression' && node.operator === 'typeof') g = true;
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item.type === 'string') visit(item, g);
      } else if (child && typeof child.type === 'string') {
        visit(child, g);
      }
    }
  })(ast, false);

  return found;
}

// ──────────────────────────────────────────────
//  What the polyfill defines
//
//  Reads the object assigned to globalThis.Bun, plus any later
//  `Bun.foo = ...` patches, so shorthand and getters are counted too.
// ──────────────────────────────────────────────

export function collectPolyfillApis(polyfillSource) {
  const defined = new Set();
  const ast = acorn.parse(polyfillSource, { ecmaVersion: 'latest', sourceType: 'script' });
  walk(ast, (node) => {
    if (node.type !== 'AssignmentExpression' || node.left?.type !== 'MemberExpression') return;
    const target = node.left;
    // globalThis.Bun = { … }
    if (target.property?.name === 'Bun' && node.right?.type === 'ObjectExpression') {
      for (const prop of node.right.properties) {
        const key = prop.key;
        if (!key) continue;
        defined.add(key.name ?? key.value);
      }
      return;
    }
    // Bun.foo = …
    if (target.object?.type === 'Identifier' && target.object.name === 'Bun') {
      const name = target.computed
        ? (target.property?.type === 'Literal' ? target.property.value : null)
        : target.property?.name;
      if (typeof name === 'string') defined.add(name);
    }
  });
  return defined;
}

// ──────────────────────────────────────────────
//  Scanning a tree
// ──────────────────────────────────────────────

export async function scanBunApis(extractDir, files, { sourceType = 'module' } = {}) {
  const used = new Map();   // api → { files, guarded, members }
  for (const rel of files) {
    const code = await readFile(join(extractDir, rel), 'utf8');
    for (const [api, info] of collectBunApis(code, sourceType)) {
      const prev = used.get(api);
      if (prev) {
        prev.files.push(rel);
        prev.guarded = prev.guarded && info.guarded;
        for (const m of info.members) prev.members.add(m);
      } else {
        used.set(api, { files: [rel], guarded: info.guarded, members: new Set(info.members) });
      }
    }
  }

  const polyfill = readFileSync(join(__dirname, '..', 'templates', 'bun-polyfill.js'), 'utf8');
  const defined = collectPolyfillApis(polyfill);
  const missing = [...used.keys()].filter((api) => !defined.has(api)).sort();
  // Unguarded and unpolyfilled: throws as soon as that code path runs.
  const fatal = missing.filter((api) => !used.get(api).guarded);

  // Second-level names need the shim actually loaded — Bun.hash.xxHash64 is
  // attached with Object.assign, which reading the source cannot see.
  const shallow = [];
  const live = loadPolyfillGlobals(polyfill);
  if (live) {
    for (const [api, { members, guarded }] of used) {
      if (!defined.has(api) || members.size === 0) continue;
      const ns = live[api];
      const gaps = [...members].filter((m) => ns?.[m] === undefined).sort();
      if (gaps.length) shallow.push({ api, members: gaps, guarded });
    }
  }

  return { used, defined, missing, fatal, shallow };
}

// Evaluate the shim in a throwaway global so its real shape can be probed.
// Returns null when that is not possible (missing optional deps, say), in
// which case second-level checking is simply skipped.
function loadPolyfillGlobals(source) {
  try {
    const sandbox = { globalThis: undefined, require: createRequire(import.meta.url), Buffer, process };
    sandbox.globalThis = sandbox;
    const fn = new Function('globalThis', 'require', 'Buffer', 'process', source);
    fn(sandbox, sandbox.require, Buffer, process);
    return sandbox.Bun ?? null;
  } catch {
    return null;
  }
}

// Which extracted assets arrive zstd-framed. The loader sniffs the magic
// rather than trusting the name, so ".md" and ".md.zst" can both be framed.
export async function collectCompressedAssets(extractDir, names) {
  const compressed = [];
  for (const name of names) {
    try {
      const buf = await readFile(join(extractDir, name));
      if (isZstdFramed(buf)) compressed.push(name);
    } catch {}
  }
  return compressed;
}

export function formatCoverageReport({ used, missing, fatal, shallow = [] }, compressed = []) {
  const lines = [`  Bun APIs called: ${used.size}, polyfilled: ${used.size - missing.length}`];
  for (const api of missing) {
    const { files, guarded, members } = used.get(api);
    const detail = members.size ? ` {${[...members].sort().join(', ')}}` : '';
    lines.push(`  [${guarded ? '--' : '!!'}] Bun.${api}${detail} — ${files.length} file(s), ` +
      `e.g. ${files[0]}${guarded ? '  (guarded, degrades)' : '  (unguarded)'}`);
  }
  for (const { api, members, guarded } of shallow) {
    lines.push(`  [${guarded ? '--' : '!!'}] Bun.${api} is polyfilled but ` +
      `${members.map((m) => `.${m}`).join(', ')} ${members.length > 1 ? 'are' : 'is'} missing`);
  }
  if (fatal.length > 0) {
    lines.push(`  Unpolyfilled and unguarded: ${fatal.join(', ')}`);
  }
  if (compressed.length > 0) {
    lines.push(`  zstd-framed assets: ${compressed.length}`);
  }
  return lines.join('\n');
}
