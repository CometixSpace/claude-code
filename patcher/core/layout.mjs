import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

// ──────────────────────────────────────────────
//  Layout detection
//
//  Every one of the 14 standalone fix scripts does readFileSync(cliPath) and
//  parses that one file. Up to 2.1.241 this was right — the SEA embedded a
//  single ~28MB CommonJS bundle. From 2.1.242 cli.js is a ~20KB ESM entry and
//  the code lives in ~2000 chunk-*.js siblings, so all 14 report "target code
//  not found" against a current install: not because the sites drifted, but
//  because they are looking at the wrong file.
//
//  So layout dispatch belongs in the engine, not in each patch. A patch
//  declares what shape it is looking for; deciding which files to look in is
//  this module's job.
//
//  Detected by shape rather than by version: a user can point the CLI at any
//  cli.js, including one this tool has never seen a version number for, and
//  the file tree answers the question directly.
// ──────────────────────────────────────────────

// Chunk siblings the split layout emits. Named broadly on purpose — upstream
// has changed the prefix before (chunk-<hash>.js today) and the count, not the
// name, is what makes a tree "split".
const CHUNK_RE = /^chunk-[a-z0-9]+\.js$/i;

// Below this a cli.js cannot be the whole bundle; the real one is ~28MB.
const SINGLE_FILE_MIN_BYTES = 1_000_000;

export const SINGLE = 'single';
export const SPLIT = 'split';

// Subdirectories that ship alongside the entry and hold patchable code.
// vendor/ is ripgrep and friends — binaries, never parsed.
const CODE_SUBDIRS = new Set(['src']);

async function listJs(dir, root, acc) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Only recurse where code lives; node_modules and vendor are not ours
      // to patch, and walking them costs the scan its budget.
      if (dir === root && !CODE_SUBDIRS.has(entry.name)) continue;
      await listJs(full, root, acc);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      acc.push(relative(root, full));
    }
  }
  return acc;
}

// Resolve an install to { layout, root, entry, files }.
//
// `files` is every file a patch may be looked for in, relative to root, with
// the entry first — patches that only make sense in the entry (shebang, boot
// order) can stop after the first hit without scanning 2000 chunks.
export async function detectLayout(entryPath) {
  const root = dirname(entryPath);
  const entryRel = relative(root, entryPath);

  let size = 0;
  try {
    size = (await stat(entryPath)).size;
  } catch {
    throw new Error(`cannot read ${entryPath}`);
  }

  const all = await listJs(root, root, []);
  const chunks = all.filter((f) => CHUNK_RE.test(f));

  // A split tree is unmistakable: hundreds of chunk siblings next to a small
  // entry. Checking both guards against a single-file install that happens to
  // sit in a directory with an unrelated chunk-named file.
  const layout = chunks.length > 0 && size < SINGLE_FILE_MIN_BYTES ? SPLIT : SINGLE;

  const files = layout === SINGLE
    ? [entryRel]
    : [entryRel, ...all.filter((f) => f !== entryRel).sort()];

  return { layout, root, entry: entryRel, files, entrySize: size };
}

// The version as the package records it, when there is one. Only used for a
// patch's `versions` range — never for layout, which is decided by shape.
export async function readInstalledVersion(root) {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

export function describeLayout({ layout, files, entrySize }) {
  return layout === SINGLE
    ? `single-file · ${(entrySize / 1e6).toFixed(1)}MB bundle`
    : `split-esm · ${files.length} modules`;
}
