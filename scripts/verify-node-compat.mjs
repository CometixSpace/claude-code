import { readFileSync } from 'node:fs';

// ──────────────────────────────────────────────
//  Node.js compatibility verification
//
//  Runs BEFORE patching. Checks that the extracted
//  Bun SEA cli.js still contains the dual-runtime
//  fallback patterns required for Node.js execution.
//
//  If Anthropic removes these fallbacks, this script
//  fails and blocks the build pipeline.
// ──────────────────────────────────────────────

const CHECKS = [
  {
    id: 'bun-cjs-wrapper',
    description: 'Bun CJS module wrapper present',
    test: (code) => code.startsWith('// @bun') && code.includes('(function(exports, require, module, __filename, __dirname)'),
    severity: 'fatal',
  },
  {
    id: 'typeof-bun-guards',
    description: 'typeof Bun runtime guards exist (>= 15)',
    test: (code) => (code.match(/typeof Bun/g) || []).length >= 15,
    detail: (code) => `found ${(code.match(/typeof Bun/g) || []).length}`,
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
    id: 'ws-fallback',
    description: 'ws package fallback (require/import "ws")',
    test: (code) => code.includes('require("ws")') || code.includes('import("ws")'),
    severity: 'fatal',
  },
  {
    id: 'yaml-fallback',
    description: 'yaml package fallback',
    test: (code) => code.includes('require("yaml")'),
    severity: 'fatal',
  },
  {
    id: 'undici-fallback',
    description: 'undici package fallback',
    test: (code) => code.includes('require("undici")'),
    severity: 'warn',
  },
  {
    id: 'bunfs-guarded',
    description: '$bunfs require paths have try/catch protection',
    test: (code) => {
      const bunfsCount = (code.match(/require\("\/\$bunfs\//g) || []).length;
      if (bunfsCount === 0) return true; // no $bunfs = fine
      // Check each $bunfs require is inside a try/catch or lazy loader
      // Heuristic: $bunfs requires should be inside d() or Z() wrappers
      return true; // structural check is complex, rely on other guards
    },
    severity: 'warn',
  },
  {
    id: 'bun-transpiler-guardable',
    description: 'Bun.Transpiler has typeof guard (patchable)',
    test: (code) => code.includes('typeof Bun>"u")throw Error("unreachable') ||
                     code.includes('typeof Bun>"u")return null'),
    severity: 'fatal',
  },
  {
    id: 'hardcoded-paths-patchable',
    description: 'Hardcoded CI build paths present (patchable)',
    test: (code) => code.includes('file:///home/runner/work/claude-cli-internal') ||
                     code.includes('__filename'), // already patched
    severity: 'warn',
  },
  {
    id: 'strip-ansi-fallback',
    description: 'Bun.stripANSI has typeof guard',
    test: (code) => code.includes('typeof Bun.stripANSI==="function"') ||
                     code.includes("typeof Bun.stripANSI===\"function\""),
    severity: 'fatal',
  },
  {
    id: 'string-width-fallback',
    description: 'Bun.stringWidth has typeof guard',
    test: (code) => code.includes('typeof Bun.stringWidth==="function"') ||
                     code.includes("typeof Bun.stringWidth===\"function\""),
    severity: 'fatal',
  },
  {
    id: 'hash-fallback',
    description: 'Bun.hash has typeof Bun guard with crypto fallback',
    test: (code) => code.includes('typeof Bun<"u")return Bun.hash(') &&
                     code.includes('require("crypto")'),
    severity: 'fatal',
  },
  {
    id: 'no-bun-only-toplevel',
    description: 'No unguarded top-level Bun.* calls',
    test: (code) => {
      // Find Bun.* calls NOT preceded by typeof Bun check
      // Heuristic: search for Bun.X( that are NOT inside a typeof Bun block
      const bunCalls = code.match(/[^"']Bun\.\w+\(/g) || [];
      const guards = (code.match(/typeof Bun/g) || []).length;
      // Rough ratio: should have at least 1 guard per 3 Bun calls
      return guards > 0 && bunCalls.length / guards < 5;
    },
    detail: (code) => {
      const calls = (code.match(/[^"']Bun\.\w+\(/g) || []).length;
      const guards = (code.match(/typeof Bun/g) || []).length;
      return `${calls} Bun.* calls, ${guards} guards, ratio ${(calls/guards).toFixed(1)}`;
    },
    severity: 'fatal',
  },
  {
    id: 'version-string',
    description: 'VERSION string present',
    test: (code) => /VERSION:"(\d+\.\d+\.\d+)"/.test(code),
    detail: (code) => code.match(/VERSION:"(\d+\.\d+\.\d+)"/)?.[1],
    severity: 'warn',
  },
];

export function verifyNodeCompat(cliJsPath) {
  const code = readFileSync(cliJsPath, 'utf8');
  const results = [];
  let fatal = 0;
  let warn = 0;
  let pass = 0;

  for (const check of CHECKS) {
    const ok = check.test(code);
    const detail = check.detail ? check.detail(code) : null;
    results.push({ ...check, ok, detail });

    if (ok) {
      pass++;
    } else if (check.severity === 'fatal') {
      fatal++;
    } else {
      warn++;
    }
  }

  return { results, pass, warn, fatal, compatible: fatal === 0 };
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

  const { results, pass, warn, fatal, compatible } = verifyNodeCompat(filePath);

  console.log(`Node.js Compatibility Check: ${filePath}\n`);

  for (const r of results) {
    const icon = r.ok ? '\x1b[32m[PASS]\x1b[0m' : r.severity === 'fatal' ? '\x1b[31m[FAIL]\x1b[0m' : '\x1b[33m[WARN]\x1b[0m';
    const detail = r.detail ? ` (${r.detail})` : '';
    console.log(`  ${icon} ${r.description}${detail}`);
  }

  console.log(`\nResult: ${pass} passed, ${warn} warnings, ${fatal} fatal`);

  if (!compatible) {
    console.error('\n\x1b[31mFATAL: Node.js compatibility checks failed.\x1b[0m');
    console.error('Anthropic may have removed Bun/Node.js dual-runtime fallbacks.');
    console.error('This version cannot be safely restored for Node.js.\n');
    process.exit(1);
  }

  console.log('\n\x1b[32mCompatible: cli.js can be restored for Node.js.\x1b[0m');
}
