# @cometix/claude-code

Claude Code restored for Node.js — extracted from official Bun SEA binaries and patched for Node.js runtime compatibility.

Starting from v2.1.113, Anthropic ships Claude Code as native Bun binaries instead of Node.js-runnable JavaScript. This project restores the npm package format so it can run under Node.js.

## Install

```bash
npm install -g @cometix/claude-code
```

## What it does

1. Downloads official Claude Code binaries from all 8 platforms (darwin/linux/win32 × arm64/x64)
2. Extracts the embedded JavaScript and native modules from Bun SEA format
3. Patches the code for Node.js compatibility (hardcoded paths, Bun-only APIs, module loading)
4. Reassembles into a standard npm package with `vendor/` dependencies

## Package contents

```
cli.js              Node.js entry point
sdk-tools.d.ts      SDK type definitions
vendor/
├── ripgrep/         Code search (6 platforms)
├── audio-capture/   Voice input (6 platforms)
└── seccomp/         Linux sandbox (arm64 + x64)
```

## Automated releases

A GitHub Actions workflow checks for new Claude Code versions every 6 hours, builds the restored package, and publishes to both GitHub Releases and npm.

## License

This project redistributes Claude Code under [Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance). Vendored dependencies retain their original licenses (ripgrep: Unlicense/MIT, seccomp: Apache-2.0).
