import { readFileSync } from 'node:fs';

// ──────────────────────────────────────────────
//  Node.js compatibility verification
//
//  Runs BEFORE patching. Classifies the cli.js into:
//  - "dual-runtime": has typeof Bun guards + Node.js fallbacks (≤2.1.127)
//  - "bun-only": removed guards, needs polyfill injection (≥2.1.128)
//  - "incompatible": fundamental structure changed, cannot restore
// ──────────────────────────────────────────────

const CHECKS = [
  {
    id: 'bun-cjs-wrapper',
    description: 'Bun CJS module wrapper present',
    test: (code) => code.startsWith('// @bun') && code.includes('(function(exports, require, module, __filename, __dirname)'),
    severity: 'fatal',
  },
  {
    id: 'require-calls',
    description: 'CJS require() calls present (>= 100)',
    test: (code) => (code.match(/require\(/g) || []).length >= 100,
    detail: (code) => `found ${(code.match(/require\(/g) || []).length}`,
    severity: 'fatal',
  },
  {
    id: 'version-string',
    description: 'VERSION string present',
    test: (code) => /VERSION:"(\d+\.\d+\.\d+)"/.test(code),
    detail: (code) => code.match(/VERSION:"(\d+\.\d+\.\d+)"/)?.[1],
    severity: 'fatal',
  },
  {
    id: 'typeof-bun-guards',
    description: 'typeof Bun runtime guards',
    test: (code) => (code.match(/typeof Bun/g) || []).length >= 1,
    detail: (code) => {
      const count = (code.match(/typeof Bun/g) || []).length;
      return `${count} (${count >= 15 ? 'dual-runtime' : 'bun-only, polyfill needed'})`;
    },
    severity: 'info',
  },
  {
    id: 'ws-dependency',
    description: 'ws package referenced',
    test: (code) => code.includes('require("ws")') || code.includes('import("ws")'),
    severity: 'warn',
  },
  {
    id: 'yaml-dependency',
    description: 'yaml package referenced (or Bun.YAML used)',
    test: (code) => code.includes('require("yaml")') || code.includes('Bun.YAML'),
    severity: 'info',
  },
  {
    id: 'undici-dependency',
    description: 'undici package referenced',
    test: (code) => code.includes('require("undici")'),
    severity: 'info',
  },
  {
    id: 'bun-api-calls',
    description: 'Bun.* API calls inventory',
    test: () => true,
    detail: (code) => {
      const calls = code.match(/[^"']Bun\.\w+\(/g) || [];
      const guards = (code.match(/typeof Bun/g) || []).length;
      return `${calls.length} calls, ${guards} guards`;
    },
    severity: 'info',
  },
  {
    id: 'hardcoded-paths',
    description: 'CI build paths present (patchable)',
    test: (code) => code.includes('/claude-cli-internal/') || code.includes('__filename'),
    detail: (code) => {
      const count = (code.match(/file:\/\/\/[^"]*claude-cli-internal/g) || []).length;
      return count > 0 ? `${count} paths` : 'already patched or absent';
    },
    severity: 'info',
  },
];

export function verifyNodeCompat(cliJsPath) {
  const code = readFileSync(cliJsPath, 'utf8');
  const results = [];
  let fatal = 0;
  let warn = 0;
  let info = 0;
  let pass = 0;

  for (const check of CHECKS) {
    const ok = check.test(code);
    const detail = check.detail ? check.detail(code) : null;
    results.push({ ...check, ok, detail });

    if (ok) { pass++; }
    else if (check.severity === 'fatal') { fatal++; }
    else if (check.severity === 'warn') { warn++; }
    else { info++; }
  }

  // Classify the build mode
  const guardCount = (code.match(/typeof Bun/g) || []).length;
  const mode = guardCount >= 15 ? 'dual-runtime' : guardCount >= 1 ? 'bun-only' : 'unknown';

  return { results, pass, warn, fatal, info, compatible: fatal === 0, mode, guardCount };
}

// ──────────────────────────────────────────────
//  CLI
// ──────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith('verify-node-compat.mjs');
if (isMain) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node verify-node-compat.mjs <cli.js>');
    process.exit(1);
  }

  const { results, pass, warn, fatal, compatible, mode, guardCount } = verifyNodeCompat(filePath);

  console.log(`Node.js Compatibility Check: ${filePath}\n`);

  for (const r of results) {
    const icon = r.ok ? '\x1b[32m[PASS]\x1b[0m'
      : r.severity === 'fatal' ? '\x1b[31m[FAIL]\x1b[0m'
      : r.severity === 'warn' ? '\x1b[33m[WARN]\x1b[0m'
      : '\x1b[36m[INFO]\x1b[0m';
    const detail = r.detail ? ` (${r.detail})` : '';
    console.log(`  ${icon} ${r.description}${detail}`);
  }

  console.log(`\nMode: ${mode} (${guardCount} typeof Bun guards)`);
  console.log(`Result: ${pass} passed, ${warn} warnings, ${fatal} fatal\n`);

  if (!compatible) {
    console.error('\x1b[31mFATAL: Fundamental compatibility checks failed.\x1b[0m');
    console.error('The binary structure may have changed beyond what can be restored.\n');
    process.exit(1);
  }

  if (mode === 'bun-only') {
    console.log('\x1b[33mBun-only build detected. Polyfill shim will be injected.\x1b[0m');
  } else {
    console.log('\x1b[32mDual-runtime build. Standard patches sufficient.\x1b[0m');
  }
}
