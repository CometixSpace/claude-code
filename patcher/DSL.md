# Writing a patch

A patch is a JSON file in `patches/`. It says *where* a change goes and *what*
the change is. Everything the standalone scripts each did for themselves —
finding the files, parsing, backing up, detecting a second run, merging with
other fixes, verifying, restoring — belongs to the engine.

This is the guide to writing one. [`README.md`](README.md) covers using the
patches and why the engine is shaped the way it is.

Every example here is run by
[`test/patcher-dsl-examples.test.mjs`](../test/patcher-dsl-examples.test.mjs):
if one stops being true, a test fails.

Commands are written `patcher …`, short for `node patcher/bin/patch.mjs …`
(or `pnpm patcher …`).

## From the script template to a declaration

Each part of `_template-claude-code-fix.sh` has a place in a patch. The parts
not listed are the engine's now.

| Script template | Patch |
|---|---|
| Header: THE BUG, ROOT CAUSE | `title`, `description` |
| FIX POINTS 1), 2), … | one site each, with its own `description` |
| `findNodes(ast, n => …)` | `match` |
| `src(node)`, reading a minified name | `capture` |
| `code.slice(0, s) + repl + code.slice(e)` | `edit` |
| re-parse, walk back to the patched node | `verify` |
| `ALREADY_PATCHED` grep, backup suffix, `--check`, `--restore` | markers, originals, `check`, `restore` |

[`templates/patch.template.json`](templates/patch.template.json) is the
starting point. Copy it to `patches/<id>.json` and it loads as it is: `list`
shows it, and `check` reports its placeholder site as missing until the site
is filled in.

## Anatomy

```jsonc
{
  "id": "cleanup-period",       // what `apply` takes; also names the marker
  "title": "…",                 // one line, shown by `list`
  "description": "…",           // the bug, its cause, the fix
  "risk": "low",                // low | medium | high, shown by `list`
  "versions": ">=2.1.242",      // optional semver range; outside it, not offered

  "sites": [ … ],               // or "stages": [{ "id", "when"?, "sites": [ … ] }]
  "verify": [ … ],              // optional: what the rewrite must have produced
  "assets": [ … ]               // optional: files installed beside the entry
}
```

A **site** is one place in the code:

```jsonc
{
  "id": "declaration",          // unique in the patch; the marker's #suffix
  "description": "…",           // what this is, and why the predicate looks like this
  "marker": "cleanupPeriodDays",// text a file must contain before it is parsed
  "match": { … },               // which node
  "capture": { … },             // names to read off it
  "edit": { … },                // what to change; an array for several; omit to only locate
  "expect": "required",         // or "optional"
  "satisfiedWhen": { … },       // what "upstream already did this" looks like
  "sameFileAs": "usage-site",   // scope: only the file(s) that site matched in
  "within": "builder",          // scope: only inside the node that site matched
  "in": "entry"                 // scope: only cli.js
}
```

What happens to it, in order:

1. Each candidate file is tested for the **marker** as raw text. Only files
   that pass are parsed — once per run, shared by every selected patch.
2. **match** is tried against every node. The first hit is taken unless `nth`
   says otherwise, and the search stops at the first file with a hit.
3. **capture** reads values off the hit. Later sites and stages can search by
   them and splice them into text.
4. **edit** compiles to a byte range and replacement text, with
   `/*@cc:<patch>#<site>*/` appended. Edits from all patches are merged per
   file, checked for overlap, applied, and the result is re-parsed before
   anything is written.
5. **verify** runs against a fresh parse of what was written.

## Workflow

**1. Find the code.** In a fresh install, `grep -l` for a string next to the
thing you want. User-visible text, setting names and feature-flag names are
all good starting points.

**2. Probe until exactly one hit.** `probe` runs a site's marker and match
over the whole tree, and lists every hit together with what `capture` would
read from it:

```
$ patcher probe '{"marker":"allow_voice_mode",
    "match":{"node":"FunctionDeclaration","where":{"params.length":0,
      "body.body.length":1,"body.body.0.argument.operator":"&&"}},
    "capture":{"gate":"id.name"}}' --limit 3

[>] 2 of 1998 file(s) passed the marker and were parsed

  chunk-d07eav3e.js  FunctionDeclaration Rq  @56663  44B
    capture {"gate":"Rq"}
    async function Rq(){return cy()&&await Eu()}

  chunk-d07eav3e.js  FunctionDeclaration FX  @56707  32B
    capture {"gate":"FX"}
    function FX(){return cy()&&Es()}
  …
[!] 14 hit(s) (showing 3; --limit for more) — a site takes the first unless nth says otherwise
```

That predicate looks reasonable, and the site would have rewritten `Rq`. The
voice gate is `O2e`, the 13th hit. See [Pitfalls](#pitfalls) for what
narrowed it down. `probe` also takes a path to a `.json` file holding the site.

**3. Check.** `patcher check <id>` locates every site without writing:

```
[OK] cleanup-period: 2 site(s) located  {"constName":"K"}
      usage-site             chunk-q6mcb18z.js
      declaration            chunk-q6mcb18z.js
```

The report can also show:

- `already satisfied upstream`: `satisfiedWhen` held. Not a failure.
- `[!] n site(s) found their marker but matched nothing`: a file mentions the
  marker, but no file matches the predicate. This is how drift shows up.
- `[X] <id>: site "x" not found (stage y)`: a required site is missing, so
  the whole patch is skipped. No patch is ever applied partially.

**4. Dry run.** `patcher apply <id> --dry-run` compiles, merges and re-parses
every edit and prints what would be written. It catches overlapping edits and
text that does not parse.

**5. Apply, look, restore.** `patcher apply <id>`, then `patcher status`,
then run Claude Code. `patcher restore` returns every touched file to the
bytes npm installed. Edit the patch and repeat.

## Locating

### marker

A marker is a substring the file must contain; an array means any one of
them. It is only a cheap filter in front of the parser: a
2000-module tree drops to a handful of files before acorn runs. Choose text
that survives minification — string literals, property names, flag names —
and never a minified identifier, since those change every release. A marker
may use `{{capture}}` from an earlier site.

A site with no marker is rejected unless it says `"unfiltered": true`,
because parsing the whole tree costs seconds and hundreds of MB.

### node and where

`node` is the ESTree type, as [acorn](https://github.com/acornjs/acorn) emits
it. `where` maps dotted paths on that node to expected values:

- Numbers index arrays: `arguments.1`, `body.body.0.argument`.
- `length` works as on any array: `params.length`.
- `[]` steps into *every* element: `arguments.[].value`.
- A field passes if **any** value its path reaches matches.

```js
// source
var g={"ctrl+c":"app:interrupt","ctrl+d":"app:exit"},t={"ctrl+c":"transcript:exit"};
```
```json
"match": { "node": "Property", "where": { "key.value": "ctrl+c", "value.value": "app:interrupt" } },
"edit":  { "op": "replace-value", "text": "\"app:exit\"" }
```
```js
// result — the transcript table's ctrl+c is a lookalike, and is left alone
var g={"ctrl+c":"app:exit","ctrl+d":"app:exit"},t={"ctrl+c":"transcript:exit"};
```

An expected value can be a comparison instead of a literal:

| | passes when the value… |
|---|---|
| `{"eq": v}` / `{"ne": v}` | is / is not `v` |
| `{"gt": n}` `{"gte": n}` `{"lt": n}` `{"lte": n}` | is a number and compares so |
| `{"in": [a, b]}` | is one of these |
| `{"matches": "/re/flags"}` | is a string the regex matches (no slashes: substring) |
| `{"exists": true}` / `{"exists": false}` | is present and non-null / is absent or null |

```js
var K=30,T=86400000;
```
```json
"match": { "node": "VariableDeclarator", "where": { "init.type": "Literal", "init.value": { "lte": 365 } } },
"edit":  { "op": "replace-field", "field": "init", "text": "9999" }
```
```js
var K=9999,T=86400000;
```

`[]` and an index together. The first argument names the flag, the second
must be `!1`:

```js
H("tengu_keys",!1);H("tengu_other",!1);
```
```json
"match": { "node": "CallExpression",
           "where": { "arguments.[].value": "tengu_keys", "arguments.1.argument.value": 1 } },
"edit":  { "op": "replace-field", "field": "arguments.1", "text": "!0" }
```
```js
H("tengu_keys",!0);H("tengu_other",!1);
```

### contains and excludes

Both test the node's **own source text**, a range the AST has already
delimited. This is the only place text matching is allowed. The value is a
literal substring, or a regex written `"/…/flags"`. An array means all of
them (`contains`) or any of them (`excludes`).

A regex is worth using when spacing or quoting may vary:

```js
function a(){return{argumentHint:  "[hold]"}}function b(){return{argumentHint:"[tap]"}}
```
```json
"match": { "node": "FunctionDeclaration", "contains": "/argumentHint:\\s*\"\\[hold/" },
"edit":  { "op": "replace-body", "text": "{return null}" }
```
```js
function a(){return null}function b(){return{argumentHint:"[tap]"}}
```

`excludes` rules out a lookalike by a telltale it carries:

```js
var a={behavior:"deny",noVerdict:!0},b={behavior:"deny",status:500};
```
```json
"match": { "node": "ObjectExpression", "contains": "behavior:\"deny\"", "excludes": "noVerdict" },
"edit":  { "op": "replace-field", "field": "properties.0.value", "text": "\"ask\"" }
```
```js
var a={behavior:"deny",noVerdict:!0},b={behavior:"ask",status:500};
```

### has and hasNot

A shape somewhere **inside** the node: a nested predicate, with the same
fields as `match`. This is how to tell apart functions that look the same
from outside, by what they do.

Often the inner shape refers to the outer node's own minified names, for
example "reads `<its first parameter>.messages[0]`". A `capture` placed
*inside* `match` reads those names first, and `has` is resolved against them.
Those names stay local to the predicate. The site-level `capture` is the
one that exports:

```js
function acc(e,n){return{type:"C",m:e.messages[0]}}function wrap(e){return{type:"C"}}
```
```json
"match": {
  "node": "FunctionDeclaration",
  "contains": "type:\"C\"",
  "capture": { "param": "params.0.name" },
  "has": { "node": "MemberExpression",
           "where": { "property.value": 0, "object.property.name": "messages",
                      "object.object.name": "{{param}}" } }
},
"capture": { "fn": "id.name" },
"edit": { "op": "prepend-body", "text": "return null;" }
```
```js
// fn = "acc"
function acc(e,n){return null;return{type:"C",m:e.messages[0]}}function wrap(e){return{type:"C"}}
```

`hasNot` is the same test, inverted. Both accept an array, which must hold
all / none.

### nth and nthFile

A site takes one node: the first hit, in the first file that has one. `nth`
chooses a different one. **It counts within a file, not across the tree.**

| | on `var x=[1,1,1];`, `{"node":"Literal","where":{"value":1}}` |
|---|---|
| omitted / `0` | `[2,1,1]` |
| `1` | `[1,2,1]` |
| `"last"` | `[1,1,2]` |
| `"all"` | `[2,2,2]`, and every hit in every other candidate file too |

`"nthFile": "all"` keeps going after the first file, taking one node (the
`nth`) from each. Files are visited entry first, then by file name.

## Capturing

`capture` maps a name to a path on the matched node, and takes the first
value the path reaches. With a `$src:` prefix it takes the node's source text
instead, for when an expression rather than a name has to be carried along.

A captured name is used as `{{name}}`:

- **In edit text.** An unknown name is an error when the edit is compiled.
- **In a later site's `match`, `marker` or `satisfiedWhen`.** An unknown name
  is left as literal text, so it matches nothing, and the site reports as
  missing. A typo in a placeholder therefore looks like drift. Check names
  with `probe` first.

Values flow forward in declaration order. A site sees everything captured by
the sites and stages before it. With `nth: "all"`, each hit keeps its own
captures, so every rewrite uses the names of its own site.

Reading a name into a replacement:

```js
function run(a,b,m){return send({classifierModel:m,stage:"s1"})}
```
```json
"stages": [
  { "id": "find", "sites": [{ "id": "arg", "marker": "classifierModel",
      "match": { "node": "Property", "where": { "key.name": "classifierModel", "value.type": "Identifier" } },
      "capture": { "model": "value.name" } }] },
  { "id": "edit", "sites": [{ "id": "entry", "sameFileAs": "arg", "marker": "classifierModel",
      "match": { "node": "FunctionDeclaration",
                 "has": { "node": "Property", "where": { "key.name": "classifierModel", "value.name": "{{model}}" } } },
      "edit": { "op": "prepend-body", "text": "if(process.env.M){{model}}=process.env.M;" } }] }
]
```
```js
function run(a,b,m){if(process.env.M)m=process.env.M;return send({classifierModel:m,stage:"s1"})}
```

An expression, carried with `$src:`:

```js
h.emit({id:F,kind:k});
```
```json
"match":   { "node": "CallExpression", "where": { "callee.property.name": "emit" } },
"capture": { "event": "$src:arguments.0", "id": "arguments.0.properties.0.value.name" },
"edit":    { "op": "replace-field", "field": "arguments.0", "text": "P.set({{id}},{{event}}).get({{id}})" }
```
```js
h.emit(P.set(F,{id:F,kind:k}).get(F));
```

### Scope: sameFileAs, within, in

Every chunk is its own module scope, so **a minified name is unique only
within one file**. Once a site searches by a captured name, it has to say
where to search.

`sameFileAs` limits a site to the file(s) another site matched in. Here the
other chunk has an unrelated `K` of its own:

```js
// chunk-a.js                                            // chunk-b.js
var K=30;function f(c){return c.cleanupPeriodDays??K}    var K=30;export{K};
```
```json
"stages": [
  { "id": "find", "sites": [{ "id": "usage", "marker": "cleanupPeriodDays",
      "match": { "node": "LogicalExpression", "where": { "operator": "??", "left.property.name": "cleanupPeriodDays" } },
      "capture": { "k": "right.name" } }] },
  { "id": "raise", "sites": [{ "id": "decl", "sameFileAs": "usage", "marker": "cleanupPeriodDays",
      "match": { "node": "VariableDeclarator", "where": { "id.name": "{{k}}" } },
      "edit": { "op": "replace-field", "field": "init", "text": "9999" } }] }
]
```
```js
// chunk-a.js: var K=9999;…    chunk-b.js: untouched
```

`within` limits a site to the inside of the node another site matched (the
node itself is excluded). It is needed when the thing searched for is a
*local* of one function, and the same file has others of the same name:

```js
function other(n){let{settingsData:x}=n;return x}function builder(n){let{settingsData:r}=n;return[{id:"a"}]}
```
```json
"sites": [
  { "id": "builder", "marker": "id:\"a\"", "match": { "node": "FunctionDeclaration", "contains": "id:\"a\"" } },
  { "id": "sd", "within": "builder", "marker": "id:\"a\"",
    "match": { "node": "Property", "where": { "key.name": "settingsData" } }, "capture": { "sd": "value.name" } },
  { "id": "row", "within": "builder", "marker": "id:\"a\"",
    "match": { "node": "ObjectExpression", "where": { "properties.0.value.value": "a" } },
    "edit": { "op": "insert-before", "text": "{id:\"z\",v:{{sd}}}," } }
]
```
```js
// sd = "r", not "x"
…function builder(n){let{settingsData:r}=n;return[{id:"z",v:r},{id:"a"}]}
```

`"in": "entry"` restricts a site to `cli.js`, for boot-order or shebang edits
that should never cost a tree walk.

### Stages and when

`stages` run in order, and name the steps of a patch; a `not found` report
gives the stage's id. A site already sees captures from the sites before it
in its own stage, as the `within` example shows, so a new stage is only
*required* for `when`. A stage with `"when": { "captured": "name" }` (or
`notCaptured`, or an array of names) runs only if that holds. A required site
in a skipped stage fails nothing:

```json
"stages": [
  { "id": "probe", "sites": [{ "id": "opt", "marker": "legacy", "expect": "optional",
      "match": { "node": "Identifier", "where": { "name": "legacy" } }, "capture": { "hit": "name" } }] },
  { "id": "fix", "when": { "captured": "hit" }, "sites": [{ "id": "req", "marker": "legacy",
      "match": { "node": "Identifier", "where": { "name": "legacy" } }, "edit": { "op": "replace", "text": "modern" } }] }
]
```
```js
var x=1;        // → unchanged, patch OK
var x=legacy;   // → var x=modern;
```

## Editing

| op | what it rewrites |
|---|---|
| `replace` | the whole node |
| `replace-body` | the function's `{…}` block, braces included |
| `prepend-body` | inserts just inside the opening `{` |
| `append-body` | inserts just inside the closing `}` |
| `replace-field` | the sub-node at `field`, a dotted path |
| `replace-value` | a `Property`'s value; any other node, the node itself |
| `insert-before` / `insert-after` | inserts at the node's start / end |

On `function f(a){let x=1;return x}`:

| edit | result |
|---|---|
| `{"op":"replace","text":"function f(){}"}` | `function f(){}` |
| `{"op":"replace-body","text":"{return!0}"}` | `function f(a){return!0}` |
| `{"op":"prepend-body","text":"if(!a)return;"}` | `function f(a){if(!a)return;let x=1;return x}` |
| `{"op":"append-body","text":";done(x)"}` on `function f(a){let x=1}` | `function f(a){let x=1;done(x)}` |

The body ops also take `field`, to reach a function held by the matched node,
such as a method on a `Property`. An arrow function with an expression body
has no block, and the body ops refuse it:

```js
var ch={subscribe(l){add(l)},reply(r){send(r)}};
```
```json
"match":   { "node": "Property", "where": { "key.name": "subscribe" } },
"capture": { "l": "value.params.0.name" },
"edit":    { "op": "prepend-body", "field": "value", "text": "replay({{l}});" }
```
```js
var ch={subscribe(l){replay(l);add(l)},reply(r){send(r)}};
```

`replace-field` is the precise one: rewrite only the part that changes, and
use `$src:` to keep the rest. Removing one operand of a condition:

```js
if(s?.aborted||n===0)cancel();
```
```json
"match":   { "node": "IfStatement" },
"capture": { "keep": "$src:test.left" },
"edit":    { "op": "replace-field", "field": "test", "text": "{{keep}}" }
```
```js
if(s?.aborted)cancel();
```

Inserting a sibling. Separators are part of the text:

```js
var rows=[{id:"a"},{id:"b"}];
```
| edit on `{id:"b"}` | result |
|---|---|
| `{"op":"insert-before","text":"{id:\"new\"},"}` | `[{id:"a"},{id:"new"},{id:"b"}]` |
| `{"op":"insert-after","text":",{id:\"new\"}"}` | `[{id:"a"},{id:"b"},{id:"new"}]` |

Several edits from one site: `edit` takes an array.

```json
"edit": [ { "op": "prepend-body", "text": "if(!a)return;" }, { "op": "append-body", "text": ";" } ]
```
```js
function f(a){go(a)}   →   function f(a){if(!a)return;go(a);}
```

### Text, payloads and the marker

`text` is inline. For anything longer than a line, `"textFrom": "name.js"`
reads the text from `payloads/`, where it can be read and diffed. A payload
is spliced into an **ESM chunk**, so there is no `require`, `module` or
`__dirname`; build them from `import.meta.url` as
`payloads/voice-asr-cometix.js` does. Prefix injected names with `__ccpp` so
they cannot collide with minified ones.

Each edit's text gets its site marker appended:

```js
var K=9999/*@cc:cleanup-period#declaration*/;
```

That comment is how `status` reads the install and how a second `apply` knows
to skip the patch. It also means the text must not end inside a `//`
comment: the marker and the original code that follows would both be
commented out.

Two edits whose ranges overlap, from one patch or from two, are refused with
the names of both. Pure insertions at the same offset are allowed.

## Required, optional, satisfied

`expect` defaults to `required`. A required site that finds nothing makes
the patch report `not found` and skips it entirely. `optional` is for a site
worth rewriting if present, whose absence breaks nothing.

`satisfiedWhen` separates *gone* from *no longer needed*. Upstream sometimes
moves to the value a patch was forcing. The site then finds nothing, which is
not drift, and saying so would teach the reader to ignore the warning when it
matters:

```js
H("tengu_keys",!0);      // upstream already ships it on
```
```json
"match":         { "node": "CallExpression", "where": { "arguments.0.value": "tengu_keys", "arguments.1.argument.value": 1 } },
"satisfiedWhen": { "node": "CallExpression", "where": { "arguments.0.value": "tengu_keys", "arguments.1.argument.value": 0 } },
"edit":          { "op": "replace-field", "field": "arguments.1", "text": "!0" }
```
`enable-keybindings` has this site. On 2.1.280:

```
[OK] enable-keybindings: 1 site(s) located
      ctrl-c-binding         chunk-y98hx08d.js
      feature-flag           already satisfied upstream
```

A required site that is simply gone:

```
[X] demo: site "gone" not found (stage main)
```

`versions` takes the patch out of the list entirely when the installed
version is outside the range, before any scanning.

## Verify

`verify` lists shapes that must be present after writing, as `match`
predicates run against a fresh parse. Captures are available:

```json
"verify": [{
  "match": { "node": "VariableDeclarator", "where": { "id.name": "{{constName}}", "init.value": 9999 } },
  "describe": "retention constant now reads 9999"
}]
```

By default every file written in the run is searched; `"file": "…"` names
one. A failure prints the `describe` text. Verification is AST-only for the
same reason location is: a text search over a whole file has no anchor, and
would have to step over the marker comment.

## Assets

A patch can install files as well as rewrite them:

```json
"assets": [{ "from": "cometix-asr", "to": "vendor/cometix-asr", "perPlatform": true }]
```

`from` is under `patcher/assets/`, `to` is relative to the install root.
With `perPlatform`, a `.node` binary is copied only if its name carries the
host's platform-arch (napi-rs naming: `darwin-arm64`, `linux-x64-gnu`,
`win32-x64-msvc`, …); other files are copied as they are. Assets are installed before any code is rewritten,
so a missing asset fails while the install is still untouched. `restore`
removes them.

## Pitfalls

Each of these has cost a broken patch at least once.

**Match on meaning, not on arity.** `params.length: 1` held on 2.1.241 and
not on 2.1.280, where the same function had gained a parameter. What the
function *does*, stated with `has`, survives; how many arguments it happens to
take does not. Prefer `{"gte": 1}` to an exact count.

**The first hit wins silently.** A predicate that looks unique in the chunk
you are reading often is not. The voice gate's first draft rewrote the wrong
function: 14 functions in that chunk have the shape `return a()&&b()`, and
the gate is the 13th. The fix was two stages: find the function that reads the `allow_voice_mode` flag and capture
its name, then find the gate as "`return <x> && <that function>()`". Probe
until the count is 1.

**Minified names are per chunk.** Any site that searches by a captured name
needs `sameFileAs`, or `within` if the name is a local.

**A placeholder typo looks like drift.** `{{contName}}` in a `match` does not
fail; it searches for the literal text and finds nothing.

**Markers must survive a release.** A string literal or a property name, not
an identifier the minifier chose.

**Payloads run in ESM.** No `require`, no `__dirname`. Test the patched
install, not only the payload on its own.

**Rewrite the least that works.** A smaller range is less likely to overlap
another patch's edit, and less likely to swallow code a later release adds
beside it. Prefer `replace-field` to `replace`, and `$src:` to retyping.

**Check upstream before forcing.** If a flag already reads the value the
patch was forcing, add `satisfiedWhen` instead of deleting the site. It keeps
reporting if upstream ever gates it again.
