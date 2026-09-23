// ──────────────────────────────────────────────
//  DSL → AST predicate
//
//  Surveying the 14 scripts, the way they locate code collapses to a handful
//  of moves. Node types: Literal 69, Identifier 38, FunctionDeclaration 37,
//  CallExpression 33. Field tests: length 53, value 25, key.type 20,
//  key.value 17, params.length 13. All of it is "a node of type T whose field
//  F equals V", which is what `node` + `where` express.
//
//  Two things the survey turned up that a naive matcher would not cover:
//
//  `contains` has to accept a regex, not just a substring. Every one of the
//  14 falls back to a regex somewhere — /argumentHint:\s*["']\[hold/ and
//  friends — because minified source has no stable whitespace to match on.
//
//  `capture` is the important one. 11 of 14 read an identifier out of the
//  match and splice it into the replacement, because the bundle is minified
//  and the name changes every release: a patch cannot hardcode `Ay8`, it has
//  to find the function and then refer to whatever it turned out to be called.
//  Without capture the DSL could locate these sites but never rewrite them.
// ──────────────────────────────────────────────

// Read a dotted path off a node. `[]` steps into an array, so
// `arguments.[].value` tests "any argument whose value is …", which is how
// the scripts inspect call arguments without pinning the position.
function readPath(node, path) {
  const parts = path.split('.');
  let current = [node];
  for (const part of parts) {
    const next = [];
    for (const item of current) {
      if (item === null || item === undefined) continue;
      if (part === '[]') {
        if (Array.isArray(item)) next.push(...item);
        continue;
      }
      const value = item[part];
      if (value !== undefined) next.push(value);
    }
    current = next;
    if (current.length === 0) return [];
  }
  return current;
}

function toRegExp(spec) {
  if (spec instanceof RegExp) return spec;
  // "/…/flags" is an explicit regex; anything else is a literal substring, so
  // metacharacters in ordinary code text cannot turn into a pattern by accident.
  const m = /^\/(.*)\/([gimsuy]*)$/s.exec(spec);
  return m ? new RegExp(m[1], m[2]) : null;
}

function textMatches(text, spec) {
  const re = toRegExp(spec);
  return re ? re.test(text) : text.includes(spec);
}

// One `where` entry. A plain value means equality; an object opens the door to
// the comparisons the scripts actually use beyond `===`.
function fieldMatches(values, expected) {
  if (values.length === 0) return expected === undefined;
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    return values.some((v) => {
      if ('eq' in expected) return v === expected.eq;
      if ('ne' in expected) return v !== expected.ne;
      if ('gt' in expected) return typeof v === 'number' && v > expected.gt;
      if ('gte' in expected) return typeof v === 'number' && v >= expected.gte;
      if ('lt' in expected) return typeof v === 'number' && v < expected.lt;
      if ('lte' in expected) return typeof v === 'number' && v <= expected.lte;
      if ('in' in expected) return expected.in.includes(v);
      if ('matches' in expected) return typeof v === 'string' && textMatches(v, expected.matches);
      if ('exists' in expected) return expected.exists === (v !== undefined && v !== null);
      return false;
    });
  }
  return values.some((v) => v === expected);
}

export function nodeMatches(node, spec, source) {
  if (spec.node && node.type !== spec.node) return false;

  for (const [path, expected] of Object.entries(spec.where ?? {})) {
    if (!fieldMatches(readPath(node, path), expected)) return false;
  }

  // `contains` / `excludes` run against the node's own source text. Checked
  // after the structural tests because slicing is the expensive part.
  if (spec.contains !== undefined || spec.excludes !== undefined) {
    const text = source.slice(node.start, node.end);
    if (spec.contains !== undefined) {
      const all = Array.isArray(spec.contains) ? spec.contains : [spec.contains];
      if (!all.every((c) => textMatches(text, c))) return false;
    }
    if (spec.excludes !== undefined) {
      const all = Array.isArray(spec.excludes) ? spec.excludes : [spec.excludes];
      if (all.some((c) => textMatches(text, c))) return false;
    }
  }

  return true;
}

// Pull the values a patch wants to reuse in its replacement text out of a
// matched node. `{ "fn": "id.name" }` yields { fn: "Ay8" }, which edit.mjs
// then interpolates as {{fn}}.
//
// A capture that resolves to nothing is not an error here — `required` is
// enforced by the caller, which knows whether the site is optional.
export function captureFrom(node, captureSpec) {
  const out = {};
  for (const [name, path] of Object.entries(captureSpec ?? {})) {
    const values = readPath(node, path);
    if (values.length > 0) out[name] = values[0];
  }
  return out;
}

export function walk(node, visit) {
  visit(node);
  for (const key of Object.keys(node)) {
    // `start`/`end`/`type` are scalars; skipping them here is measurably
    // cheaper across a 2000-file tree than testing every property.
    if (key === 'start' || key === 'end' || key === 'type') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item.type === 'string') walk(item, visit);
      }
    } else if (child && typeof child.type === 'string') {
      walk(child, visit);
    }
  }
}

// Every node in `ast` satisfying `spec`, in source order.
//
// `nth` selects among them: a number picks one, "all" keeps them all, and the
// default of 0 takes the first. The scripts overwhelmingly want the first
// match and `break`; "all" exists for the sweeps (every 200000 literal, every
// deny-behavior property).
export function findMatches(ast, spec, source) {
  const hits = [];
  walk(ast, (node) => {
    if (nodeMatches(node, spec, source)) hits.push(node);
  });
  if (hits.length === 0) return [];
  const nth = spec.nth ?? 0;
  if (nth === 'all') return hits;
  if (nth === 'last') return hits.slice(-1);
  const one = hits[nth];
  return one ? [one] : [];
}
