# patcher

One scanner shell, patches declared as data.

```bash
node patcher/bin/patch.mjs list
node patcher/bin/patch.mjs check cleanup-period
node patcher/bin/patch.mjs apply cleanup-period
node patcher/bin/patch.mjs restore
```

## Why this replaces the standalone scripts

The 43 scripts under `fix_scripts/` and 60 under `new_scripts/` each embed
their own acorn walk and each do `readFileSync(cliPath)`. That was correct
while the SEA shipped one ~28MB bundle. Since 2.1.242 `cli.js` is a ~20KB ESM
entry with ~2000 `chunk-*.js` siblings, and **all 14 surveyed scripts report
"target code not found" against a current install** — not because their sites
drifted, but because they are reading the wrong file.

Running five of them also meant five full walks of the tree and five separate
writes to files they often shared, with no ordering between them.

So the shell owns what every script was reimplementing:

| Concern | Why it is here and not in a patch |
|---|---|
| Layout dispatch | The root cause of all 14 failing. A patch says what shape it wants; the engine decides which files to look in. |
| One pass | 35 scripts = 35 tree walks. Here each file is read once and parsed at most once, across every selected patch. |
| Marker pre-filter | Parsing 2000 modules costs seconds and hundreds of MB. A substring test drops all but a handful first. |
| Per-file merge | One chunk routinely holds sites from several patches. Writing per patch would have each write clobber the last. |
| Idempotence | All 14 hand-roll an `ALREADY_PATCHED` check. |
| Verification | 13 of 14 re-check after writing; 10 re-parse. |
| Pristine originals | The scripts copy one file to `cli.js.backup`, which cannot restore a multi-file edit — and a per-run snapshot restores the wrong thing (see below). |

## Markers: the install describes itself

Every rewrite leaves a comment beside it naming the patch **and the site**:

```js
var K=9999/*@cc:cleanup-period#declaration*/;
M.messages.forEach(__ccppM=>w.push(__ccppM))/*@cc:disable-collapse-read-search#fold-call*/
```

Per-site rather than per-patch, because a patch with several sites can be
half-present — one rewritten, another skipped — and one marker on the first
edit cannot tell those apart. `status` reads them back:

```
[x] cleanup-period                 …
    #declaration
[~] some-patch                     …        2/3 sites
```

`[~]` means the markers are only partly there: something disturbed the install
after it was patched. The files are the authority; the state file under
`.claude-patcher/` only records *where to look*, so answering this costs two
reads instead of a full tree scan.

## Backups: one pristine copy, taken once

Timestamped per-run snapshots look tidier but restore the wrong bytes. Apply A,
then apply B, and B's snapshot of a shared chunk **already contains A's
rewrite** — restoring it returns the file to "A applied", not to what npm
installed. Chain a few runs and there is no way back.

So a file is copied aside the first time any patch touches it and never again:

```
.claude-patcher/
  originals/
    manifest.json      { files: { "chunk-q6mcb18z.js": { patches: [...] } } }
    chunk-q6mcb18z.js  ← exactly what npm installed
  applied.json
```

That makes taking a backup idempotent — re-running `apply` cannot damage it —
and `restore` always returns the install to pristine. Keeping one patch out of
several means re-applying it, which is cheap and cannot get the layering wrong.

## Patch shape

```jsonc
{
  "id": "cleanup-period",
  "title": "…",           // shown in the picker
  "risk": "low",          // low | medium | high
  "versions": ">=2.1.242", // optional semver range

  "stages": [              // run in order; later stages see earlier captures
    {
      "id": "find-const",
      "when": { "captured": ["x"] },   // optional guard
      "sites": [
        {
          "id": "usage-site",
          "marker": "cleanupPeriodDays",  // cheap gate; required unless unfiltered
          "match": { "node": "…", "where": {}, "contains": "…", "nth": 0 },
          "capture": { "constName": "right.name" },
          "edit": { "op": "replace", "text": "…" },
          "expect": "required",            // or "optional"
          "sameFileAs": "another-site",    // scope to where that site matched
          "in": "entry"                    // only look at cli.js
        }
      ]
    }
  ],

  "verify": [{ "match": { "node": "…", "where": {} }, "describe": "…" }]
}
```

### match

| Field | Meaning |
|---|---|
| `node` | AST node type |
| `where` | dotted path → expected value. `[]` steps into an array (`arguments.[].value`). A value can be `{eq,ne,gt,gte,lt,lte,in,matches,exists}`. |
| `contains` / `excludes` | tested against the node's own source text; `"/…/flags"` is a regex, anything else a literal substring |
| `has` / `hasNot` | a shape somewhere inside this node, resolved against **this node's** captures |
| `nth` | `0` (default), a number, `"last"`, or `"all"` |

`has` is what tells apart two functions that look alike from the outside.
`disable-collapse-read-search` has several functions building a
`{type:"collapsed_read_search"}` object; only the accumulator reads
`<param>.messages[0]` — and `<param>` is that function's own parameter, whose
minified name is known only once the function is matched. So `capture` runs
first and `has` is resolved against it.

### Match on meaning, not on surface

Both sites of `disable-collapse-read-search` originally pinned an arity —
`params.length: 1`, `arguments.length: 1`. By 2.1.280 the creator is
`N1r(e,n)` and the call is `w.push(N1r(M,h))`, so both find nothing. Reading
the first parameter's `messages` array is what the function *is*; how many
arguments it happens to take is not. Prefer `{gte: 1}` and a `has` over an
exact count.

### edit

`replace` · `replace-body` · `prepend-body` · `append-body` · `replace-value` ·
`replace-field` (needs `field`) · `insert-before` · `insert-after`

Text may be inline (`text`) or read from `payloads/` (`textFrom`). Injected
text is bimodal — twelve of the fourteen scripts inject ≤128 characters, but
`enable-voice-mode` injects 14,453 — so large payloads stay out of the JSON
where they can be read and diffed.

## Everything is a predicate, including verification

Locating, rewriting and checking all go through the AST. `verify` states the
shape the rewrite should have produced and is run against a fresh parse of
what was written — not a text search of the file.

Text matching has exactly one legitimate place: `match.contains`, where the
text being tested is a node's own source, already delimited by the AST. A
check against a whole file has no such anchor, and would additionally have to
step over the marker comment now sitting between the rewritten bytes and
whatever followed them — precisely the incidental detail a predicate should
not have to encode.

## The two things a flat matcher cannot do

**Capture.** 11 of the 14 scripts read an identifier out of the match and
splice it into the replacement, because the bundle is minified and the name
changes every release. A patch cannot hardcode `K`; it finds the site and
refers to whatever the constant turned out to be called. `capture` puts it in
scope, `{{name}}` interpolates it — in replacement text *and* in a later
site's `where`, since the usual next step is to search by the captured name.

**Stage dependency.** `context-limit` rewrites the `200000` literals, collects
the variable names it touched, then generates re-assignments from those names
— the third phase's input is the first phase's output, and it skips entirely
when nothing was captured. `stages` plus `when` model that; a flat `sites[]`
cannot.

## sameFileAs is a correctness requirement

Each chunk is its own module scope, so a minified name is only unique within
one file. `cleanup-period` captures `K` from `…cleanupPeriodDays ?? K` in
`chunk-q6mcb18z.js` — and an unconstrained search for `K = <number>` also
finds an unrelated `K` in `chunk-rrpdrd2h.js`. Editing that one would corrupt
a module the patch has nothing to do with. Any site searching by a captured
identifier needs `sameFileAs`.

## Reporting

A site whose marker is present but whose predicate matched **nothing at all**
is reported as possible drift. The distinction matters: with one bundle a
`found: false` was visible, but across 2000 files "no match" and "this file
never had it" look identical. Note the marker is a coarse filter — several
files mentioning the word while one holds the real shape is normal, so this
only fires when the site ends with zero hits everywhere.
