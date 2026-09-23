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
| Manifest backups | The scripts copy one file to `cli.js.backup`, which cannot restore a multi-file edit. |

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

  "verify": [{ "contains": "{{constName}}=9999", "describe": "…" }]
}
```

### match

| Field | Meaning |
|---|---|
| `node` | AST node type |
| `where` | dotted path → expected value. `[]` steps into an array (`arguments.[].value`). A value can be `{eq,ne,gt,gte,lt,lte,in,matches,exists}`. |
| `contains` / `excludes` | tested against the node's own source text; `"/…/flags"` is a regex, anything else a literal substring |
| `nth` | `0` (default), a number, `"last"`, or `"all"` |

### edit

`replace` · `replace-body` · `prepend-body` · `append-body` · `replace-value` ·
`replace-field` (needs `field`) · `insert-before` · `insert-after`

Text may be inline (`text`) or read from `payloads/` (`textFrom`). Injected
text is bimodal — twelve of the fourteen scripts inject ≤128 characters, but
`enable-voice-mode` injects 14,453 — so large payloads stay out of the JSON
where they can be read and diffed.

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
