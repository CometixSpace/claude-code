# patcher

One scanner shell, patches declared as data. Opt-in changes to an installed
`@cometix/claude-code`, applied in a single scan and undone byte-for-byte.

```bash
git clone https://github.com/CometixSpace/claude-code.git
cd claude-code && npm install

node patcher/bin/patch.mjs list                  # every patch, and which are applied
node patcher/bin/patch.mjs check  <id...>        # locate sites, write nothing
node patcher/bin/patch.mjs apply  <id...>        # or: apply --all
node patcher/bin/patch.mjs status                # what is applied, site by site
node patcher/bin/patch.mjs restore               # everything back to what npm installed
```

The global install is found automatically; `--path /path/to/cli.js` targets
another. Reinstalling or upgrading the package replaces the patched files, so
run `apply` again afterwards — the version check and site scan decide what
still fits.

## Patches

Verified against 2.1.280. Patches marked **env** do nothing until the variable
is set, so applying them is harmless on its own.

| Patch | What it does | Switch | Risk |
|---|---|---|---|
| `cleanup-period` | Keep transcripts 9999 days instead of 30 | — | low |
| `disable-collapse-read-search` | Tool calls on their own rows instead of a folded summary; todo/task tools, ToolSearch and thinking still fold | — | low |
| `enable-keybindings` | Ctrl+C exits instead of aborting the agent loop | — | low |
| `file-read-limit` | Read accepts files up to 100k tokens instead of 25k | — | medium |
| `context-limit` | Set the context window for any model | env `CLAUDE_CODE_CONTEXT_LIMIT` | medium |
| `classifier-model` | Run the auto-mode safety classifier on a cheaper model | env `CLAUDE_CLASSIFIER_MODEL` | medium |
| `chrome-local-socket` | Claude in Chrome over the local native host instead of the cloud bridge | — | medium |
| `classifier-fail-open` | Unreachable classifier asks instead of denying | — | high |
| `transcript-dialog-replay` | Permission dialogs raised under Ctrl+O are no longer lost | — | high |
| `unlock-ultracode` | `/effort ultracode` on models that only advertise max effort | — | high |
| `enable-voice-mode` | Voice mode without claude.ai OAuth, plus a row in `/config` | — | high |
| `voice-asr-backend` | Transcribe through the bundled cometix-asr addon | on by default; `CLAUDE_CODE_ASR=0` to opt out | high |
| `computer-use` | Computer Use without Max/Pro or the feature flag | env `CLAUDE_CODE_COMPUTER_USE=1` | high |

Environment switches work from the shell or from the `env` block of
`~/.claude/settings.json`, which is applied before any of them are read:

```json
{
  "env": {
    "CLAUDE_CODE_COMPUTER_USE": "1",
    "CLAUDE_CODE_CONTEXT_LIMIT": "400000",
    "CLAUDE_CLASSIFIER_MODEL": "claude-haiku-4-5-20251001"
  }
}
```

### cleanup-period

Transcripts older than 30 days are deleted at startup. This raises the default
to 9999. An explicit `cleanupPeriodDays` in settings still wins — only the
fallback constant changes.

### disable-collapse-read-search

The main screen folds runs of tool calls into one summary line. With this
patch they show on their own rows with their results — reads, searches and
directory listings (including the read-only shell commands behind them:
`cat`, `grep`, `ls` and the like), MCP calls, memory / workshop / scratchpad
writes, REPL, and in fullscreen other shell commands.

Still folding — upstream absorbs these silently, and their rows carry nothing
to read:

- **Todo and task tools** (`TodoWrite`, `TaskCreate`, `TaskGet`, `TaskUpdate`,
  `TaskList`). One that fails still pops out on its own, as upstream does.
- **ToolSearch**, which loads deferred tool schemas and draws nothing.
  Upstream absorbs it only in fullscreen; inline it stood alone and split the
  thinking around it into two `Thought` lines. It is absorbed in both modes.

Also unchanged:

- **Thinking** folds into its own `Thought for Xs` line between tool calls.
  That line is the only place the main screen shows thinking — a raw thinking
  block renders nothing outside Ctrl+O or verbose mode.
- **PreToolUse hook summaries** and **recalled memories** are absorbed into a
  group that is open when they arrive, shown on their own otherwise.

How: one rule — a tool joins a fold only if upstream absorbs it silently and
it is not REPL — applied in two places that must agree. The grouping pass
asks one function whether a call may join; that function applies the rule. A
second scan decides whether the last fold is still live (drawn as
`Thinking…` with a running timer) by looking past anything foldable; it asks
the classifier, which would still call a Read foldable, so it takes the same
rule — otherwise a thinking line above a running Grep would keep ticking. The
classifier's ToolSearch branch loses its fullscreen condition; nothing else
reading the classifier draws ToolSearch or counts it.

### enable-keybindings

Since 2.1.x Ctrl+C is bound to `app:interrupt`, which aborts the agent loop —
easy to hit by accident. This rebinds it to `app:exit`, as in 2.0.x; Escape
still interrupts. The transcript view's own Ctrl+C binding is untouched.
Keybinding customisation (`~/.claude/keybindings.json`) is already enabled
upstream on 2.1.280; the patch reports that site as satisfied.

### file-read-limit

Read refuses files over 25,000 tokens and asks for offset/limit. This raises
the ceiling to 100,000. An explicit `maxTokens` in settings still wins.

### context-limit

```bash
CLAUDE_CODE_CONTEXT_LIMIT=400000
```

The resolver already reads `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, but only for
models passing an eligibility check. This variable applies to every model.
Only a positive finite number takes effect; anything else falls through to
the normal resolution. The official variable keeps its meaning.

### classifier-model

```bash
CLAUDE_CLASSIFIER_MODEL=claude-haiku-4-5-20251001
```

Auto mode classifies every tool call with the conversation's own model, so an
Opus session pays Opus rates for classification. Unset or empty, nothing
changes.

Auto mode itself needs no unlocking on 2.1.280 — it is on by default, and the
old eligibility bypass has nothing left to do.

### classifier-fail-open

When the classifier cannot be reached, auto mode fails closed and denies the
tool call. This turns that one branch into a permission prompt, so an outage
costs a confirmation rather than a blocked action. Every other denial,
including an actual unsafe verdict, is unchanged.

### transcript-dialog-replay

Permission requests raised while the Ctrl+O transcript is open had no screen
listening for them and were cancelled on the spot, leaving the tool at
"Waiting…". Pending requests are now kept and shown by the next screen that
listens — returning to the prompt brings the dialog up. Once answered, a
request is not shown again.

### chrome-local-socket

The browser client always took the cloud WebSocket bridge, which needs OAuth,
while the extension's native host listens on a local socket — so tool calls
reported "Browser extension is not connected". This forces the local path and
clears the bridge configuration. The bridge-only tools (`switch_browser`,
`list_connected_browsers`, `select_browser`) then answer that they need a
bridge connection — they cannot work over a socket.

### unlock-ultracode

Ultracode is xhigh effort plus dynamic workflow orchestration, offered only on
models advertising xhigh support. This forces that capability check, which
unlocks it on models such as opus-4-6 and sonnet-4-6 that support max effort.

### enable-voice-mode

Two things:

- Lifts the gate — claude.ai OAuth and the `allow_voice_mode` flag — behind
  both `/voice` and the UI.
- Adds a **Voice mode** row to `/config` with `off` / `hold` / `tap`. 2.1.280
  has none; `voiceEnabled` was settable only through `/voice`. The row writes
  the same settings `/voice` does, and turning it off keeps the chosen mode.

Transcription is `voice-asr-backend`'s job; apply both.

### voice-asr-backend

Replaces the WebSocket voice transport with the cometix-asr addon. Audio —
16 kHz mono 16-bit PCM, as captured — goes to the addon, and transcripts come
back through the host's own callbacks, including live interim text.

- The addon is installed to `vendor/cometix-asr` beside the entry. Only the
  binary for the running platform is copied (darwin-arm64, darwin-x64,
  linux-x64-gnu, win32-x64-msvc are available); `restore` removes it.
- `CLAUDE_CODE_ASR=0` switches back to the stock transport.
- `COMETIX_ASR_TRACE_FILE=/path/trace.jsonl` records the session event by
  event, for diagnosing a transcript that goes missing.

Binary provenance is in `assets/cometix-asr/PROVENANCE.txt`.

### computer-use

```bash
CLAUDE_CODE_COMPUTER_USE=1
```

Computer Use ships complete — 24 tools covering screenshots, mouse, keyboard,
clipboard, app launching and display switching — behind a Max/Pro check and a
server flag whose local default is off. This variable lifts both.

- **Interactive sessions only.** Upstream never registers Computer Use under
  `-p`, and `--restricted` disables it too. Check with `/mcp`: a
  `computer-use` server should be listed as connected.
- **macOS.** The native modules it drives are macOS-only.
- The server runs in-process, and asks for per-app access (`request_access`)
  before controlling anything; screen takeover has its own consent.
- **HIPAA is not bypassed.** Organisations can mark a session with a HIPAA
  compliance taint through policy; it latches, and it disables Computer Use
  regardless of this variable. That is a policy boundary, not a product tier.

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

## Assets

A patch can install files, not only rewrite them — `voice-asr-backend` is
inert without the addon it feeds audio to.

```jsonc
"assets": [{
  "from": "cometix-asr",
  "to": "vendor/cometix-asr",
  "perPlatform": true
}]
```

All four platform binaries live under `assets/`, so the patcher works wherever
it is cloned. `perPlatform` installs only the one that can load here: 13MB of
addon becomes a 3.4MB install, and the other three would be dead weight in the
target's vendor directory.

Installed files are tracked apart from originals: restore deletes them rather
than writing bytes back, and only when still the size it wrote — a file
replaced since is left alone. Emptied directories go via `rmdir`, which
refuses a non-empty one, so `vendor/` survives on account of ripgrep.

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
          "sameFileAs": "another-site",    // scope to the file that site matched in
          "within": "another-site",        // scope to the node that site matched
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

The first port of `disable-collapse-read-search` pinned an arity —
`params.length: 1`, `arguments.length: 1` — as the standalone script did. By
2.1.280 the creator is `N1r(e,n)` and the call is `w.push(N1r(M,h))`, so both
found nothing. Reading the first parameter's `messages` array is what the
function *is*; how many arguments it happens to take is not. Prefer `{gte: 1}`
and a `has` over an exact count.

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
