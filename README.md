# @cometix/claude-code

Claude Code restored for Node.js — extracted from the official Bun SEA binaries and patched to run on the Node.js runtime.

Since v2.1.113 Anthropic ships Claude Code as native Bun binaries rather than Node-runnable JavaScript. This project unpacks them and reassembles a standard npm package.

## Install

```bash
npm install -g @cometix/claude-code
```

Requires **Node.js 24 or newer**. The bundle uses `using` / `await using` (explicit resource management), which earlier releases reject at parse time, and reads zstd-framed assets through `node:zlib`.

## How it works

1. Download the official binaries for all 8 targets (darwin/linux/win32 × arm64/x64, plus the two musl variants)
2. Extract the embedded modules and native libraries from the Bun SEA container
3. Rewrite the code for Node: virtual-filesystem paths, Bun-only globals, module loading
4. Reassemble as an npm package — a thin main package plus 9 platform packages, one of which aliases linux-arm64 for Android

## Bundle layouts

The upstream binary has changed shape twice, so the pipeline picks its path by version:

| Layout | Versions | Shape |
|--------|----------|-------|
| `single-cjs` | ≤ 2.1.241 | One ~28MB CommonJS bundle, patched as a single `cli.js` |
| `split-esm` | ≥ 2.1.242 | A ~20KB ESM entry plus ~1400–1800 modules importing each other through Bun's virtual filesystem (`/$bunfs/root/`, or `B:/~BUN/root/` on Windows) |

The boundary was bisected against the official binaries: 2.1.241 embeds 15 modules, 2.1.242 embeds 1391.

### Split-ESM rewrites

Applied directory-wide by `scripts/esm-chunk-patch.mjs`:

| Rewrite | Description |
|---------|-------------|
| E1 | Virtual-filesystem paths → specifiers relative to the referencing file (~100k–124k per platform). Both sides may be nested; the prefix is computed per file |
| E2 | Runtime paths — native modules and `fs.readFile` assets — get the same treatment. They stay where upstream puts them, beside the modules, so nothing has to move |
| E3 | `import.meta.require` (Bun-only) → a `createRequire` wrapper. Returns file *content* for `.md`/`.txt`, matching Bun's text loader — since 2.1.246 the bundled skills are pulled in that way, and Node would otherwise compile markdown as JS |
| E4 | The Bun polyfill ships as `bun-polyfill.mjs`, imported first by `cli.js` and by the hooks worker, so `globalThis.Bun` exists before any module body runs |
| E5 | Since 2.1.250 modules `require()` each other at top level, and some of those close a cycle the import graph cannot break. Two layers: hoist the require to a bare `import` so the target evaluates first (clears ~90% of sites), and hand the rest a lazy stand-in that resolves on first touch. Returning `undefined` there is what broke startup in 2.1.259 |

## Compatibility patches

Applied by `scripts/node-compat-patch.mjs` — to the single `cli.js` on CJS builds, and to the matching modules on split builds.

| Patch | Description |
|-------|-------------|
| P1 | Build-machine paths baked in at compile time — `fileURLToPath("file:///home/runner/…")`, `createRequire(…)`, or a bare `__dirname` assignment — resolved at runtime instead. Matches both separators, since Windows builds bake in `D:\a\…` |
| P2 | `if (typeof Bun > "u") throw Error("Bun required")` → graceful `null`. Absent from recent versions; P6 covers it |
| P3 | Native module loads through the virtual filesystem → resolved relative to the package. Matched on the `.node` argument rather than the callee, which the minifier renames |
| P5 | `EMBEDDED_SEARCH_TOOLS` guard restored (env check + binary availability). macOS/Linux builds inline it to a literal, which forces shadow mode and hides the Grep/Glob tools; Windows builds keep the env read, so there the patch has nothing to do |
| P6 | Global `Bun` shim. Implements `spawn`, `file`, `listen`, `connect`, `serve`, `hash` (incl. `xxHash64`), `deepEquals`, `stdin`, `which`, `semver`, `YAML`, `TOML` (via `smol-toml`), `zstdDecompress`/`Sync` (embedded assets ship zstd-framed since 2.1.251), `stringWidth`/`stripANSI`/`wrapAnsi`; `JSONL.parseChunk` is deliberately `null` so callers take their own path, and `SQL`/`Terminal`/`WebView`/heap-snapshot APIs are guarded no-ops |
| P7 | Bundled `HttpsProxyAgent` exposed as `globalThis.__HttpsProxyAgent` — Node's `ws` needs an explicit agent to honour a proxy, unlike Bun |
| P8 | `AF_()` shadow function patched — the official binary impersonates `bfs`/`ugrep` through ARGV0 multicall, which under Node resolves from PATH via `which` instead |
| P9 | Package name rebranded so the built-in updater installs this package rather than the official Bun build |
| P10 | Virtual-filesystem path constants for the artifact runtimes and, since 2.1.229, the design-canvas template |

Patch sites are declared in `scripts/patch-sites.mjs` and located by walking the AST with the same predicates the rewrite uses, across worker threads. With one `cli.js` a dead pattern showed up as a zero counter; across ~1800 minified modules it is indistinguishable from a file that never had it, so a required site that disappears fails the build. A marker that survives while every predicate stops matching is reported too — that is how the Windows path form was caught.

`scripts/bun-api-coverage.mjs` does the same for the polyfill: it collects every `Bun.*` the bundle calls, checks it against the shim loaded in a sandbox (including second-level members like `Bun.hash.xxHash64`), and reports which gaps are guarded and which are not.

## Search tools

Claude Code has two search paths, selected by `EMBEDDED_SEARCH_TOOLS`:

| Mode | Env setting | Search method | Requirements |
|------|------------|---------------|-------------|
| **Tool mode** (default) | unset | Grep/Glob Tool → ripgrep (bundled) | None |
| **Shadow mode** | `=true` | Bash `find` → bfs, `grep` → ugrep | bfs + ugrep installed |

In Tool mode the model uses the built-in Grep and Glob tools backed by bundled ripgrep. In Shadow mode, `find`/`grep` inside the Bash tool are redirected to bfs/ugrep. Setting the variable without those binaries present falls back to Tool mode.

```bash
# Tool mode (default, recommended)
claude

# Shadow mode (requires: brew install bfs ugrep)
EMBEDDED_SEARCH_TOOLS=true claude
```

## Package contents

Split-ESM builds keep upstream's own layout — modules, native libraries and assets all sit together, which is where the code looks for them:

```
cli.js                ESM entry point
chunk-*.js            Code-split modules (~1400–1800)
bun-polyfill.mjs      Bun globals, imported first
*.node                Native modules — see below
*.md, *.txt           Embedded skill prompts and templates (2.1.246+)
*.min.js, *.asset     Artifact runtimes and the design-canvas template
sdk-tools.d.ts        SDK type definitions
vendor/
├── ripgrep/          Code search — added here, not shipped upstream
└── seccomp/          Linux sandbox (arm64 + x64)
```

Which native modules a package carries depends on the target — upstream builds most of them for one platform only:

| Module | Purpose | darwin | linux | win32 |
|--------|---------|:------:|:-----:|:-----:|
| `audio-capture` | Voice input | ✓ | ✓ | ✓ |
| `image-processor` | Image handling | ✓ | ✓ | ✓ |
| `computer-use-swift` | Screen capture / control | ✓ | | |
| `computer-use-input` | Synthetic input events | ✓ | | |
| `url-handler` | URL scheme registration | ✓ | | |
| `clipboard-napi` | Clipboard access | | ✓ | |

So a darwin package ships five, linux three and win32 two. Patch-site counts differ for the same reason, which is why the scanner checks that required sites exist rather than that a fixed number of them do.

`clipboard-napi` is loaded differently from the rest: the code tries the embedded copy first and falls back to a `vendor/clipboard-napi/<arch>-<os>/` lookup of its own. Keeping the extract's layout means the first path resolves, so the fallback never has to.

Assets stay compressed on disk where upstream compresses them; the loader sniffs the zstd magic and decompresses on read.

Single-CJS builds keep the older shape: one `cli.js` with native modules and assets under `vendor/`.

## Releases

`.github/workflows/release.yml` builds a version on demand (`workflow_dispatch`), publishes the platform packages plus the main package to npm, and attaches the tarballs to a GitHub release. A failed platform publish fails the job rather than leaving the main package pointing at versions that were never published.

## License

This project redistributes Claude Code under [Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance). Vendored dependencies keep their own licenses (ripgrep: Unlicense/MIT, seccomp: Apache-2.0).
