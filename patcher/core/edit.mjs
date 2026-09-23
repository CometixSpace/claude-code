// ──────────────────────────────────────────────
//  DSL → (start, end, text)
//
//  Every rewrite in the 14 scripts reduces to a byte range and a replacement,
//  so that is what an op compiles to. The named ops exist because the ranges
//  they compute are fiddly and easy to get wrong by one character — body.end
//  points past the closing brace, so appending to a function body means
//  end - 1, and getting that wrong writes outside the function.
//
//  Observed distribution: whole-node replace 14, plain insert 6, replace the
//  function body 4, replace a subfield 2. `append-body` comes from
//  context-limit, which injects re-assignments at body.end - 1; the earlier
//  design only had prepend and could not express it.
// ──────────────────────────────────────────────

// {{name}} → captured value. Templating rather than concatenation is the
// whole point of capture: the scripts build strings like
// `name + '=(+process.env.X||' + name + ')'` because the identifier is only
// known at match time, and a JSON patch has no way to run that expression.
export function interpolate(text, values) {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key) => {
    if (!(key in values)) {
      throw new Error(`template refers to {{${key}}}, which was never captured`);
    }
    return String(values[key]);
  });
}

// The block body of a function, optionally reached through a field first.
//
// `field` exists because the interesting function is often not the matched
// node: a method is a Property whose value holds the body, and matching the
// Property is what makes it addressable by name.
function functionBody(node, field) {
  const target = field ? subNode(node, field) : node;
  const body = target.body;
  if (!body || body.type !== 'BlockStatement') {
    throw new Error(`${target.type} has no block body to rewrite`);
  }
  return body;
}

// Resolve a dotted field to a node, for ops that target part of a match
// rather than the whole of it (`init`, `right`, `value`, `argument`).
function subNode(node, path) {
  let current = node;
  for (const part of path.split('.')) {
    current = current?.[part];
    if (!current) throw new Error(`field "${path}" is absent on ${node.type}`);
  }
  if (typeof current.start !== 'number') {
    throw new Error(`field "${path}" is not a node`);
  }
  return current;
}

// Compile one edit against one matched node.
//
// Returns { start, end, text } — a splice. `end === start` is an insertion,
// which is how the plain-insert cases fall out without a separate code path.
export function compileEdit(edit, node, values) {
  const text = edit.text === undefined ? '' : interpolate(edit.text, values);

  switch (edit.op) {
    case 'replace':
      return { start: node.start, end: node.end, text };

    case 'replace-body': {
      const body = functionBody(node, edit.field);
      return { start: body.start, end: body.end, text };
    }

    // Inside the braces, so the guard runs before anything else in the body.
    case 'prepend-body': {
      const body = functionBody(node, edit.field);
      return { start: body.start + 1, end: body.start + 1, text };
    }

    // body.end is the offset *after* '}', so end - 1 lands on the brace and
    // the text goes in as the body's last statement.
    case 'append-body': {
      const body = functionBody(node, edit.field);
      return { start: body.end - 1, end: body.end - 1, text };
    }

    case 'replace-field': {
      const target = subNode(node, edit.field);
      return { start: target.start, end: target.end, text };
    }

    // Literal/Property values. Kept distinct from replace-field so the common
    // case does not have to name the field and get it right per node type.
    case 'replace-value': {
      const target = node.type === 'Property' ? node.value : node;
      return { start: target.start, end: target.end, text };
    }

    case 'insert-before':
      return { start: node.start, end: node.start, text };

    case 'insert-after':
      return { start: node.end, end: node.end, text };

    default:
      throw new Error(`unknown edit op "${edit.op}"`);
  }
}

// Apply splices to one file's source.
//
// Descending by start so earlier offsets stay valid as later ones are
// rewritten. Overlap is rejected rather than resolved: two patches editing the
// same bytes is a conflict the user has to see, and silently letting the last
// one win is how the standalone scripts corrupted files when run together.
export function applyEdits(source, edits) {
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);

  for (let i = 0; i < ordered.length - 1; i++) {
    const later = ordered[i];
    const earlier = ordered[i + 1];
    // Pure insertions at the same offset are allowed to coexist; only real
    // range overlap is a conflict.
    if (earlier.end > later.start && !(earlier.start === earlier.end || later.start === later.end)) {
      throw new Error(
        `overlapping edits: ${earlier.patch ?? '?'}@${earlier.start}-${earlier.end} `
        + `and ${later.patch ?? '?'}@${later.start}-${later.end}`,
      );
    }
  }

  let out = source;
  for (const edit of ordered) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}
