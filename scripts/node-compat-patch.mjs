import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────
//  AST helpers
// ──────────────────────────────────────────────

function walk(node, callback) {
  if (!node || typeof node !== 'object') return;
  if (node.type) callback(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item.type === 'string') walk(item, callback);
      }
    } else if (child && typeof child === 'object' && typeof child.type === 'string') {
      walk(child, callback);
    }
  }
}

function applyReplacements(code, replacements) {
  replacements.sort((a, b) => b.start - a.start);
  for (const r of replacements) {
    code = code.slice(0, r.start) + r.replacement + code.slice(r.end);
  }
  return code;
}

// ──────────────────────────────────────────────
//  Strip Bun CJS wrapper
// ──────────────────────────────────────────────

export function stripBunWrapper(code) {
  const BUN_HEADER = '// @bun @bytecode @bun-cjs';
  const CJS_OPEN = '(function(exports, require, module, __filename, __dirname) {';
  const CJS_CLOSE = '})';

  if (!code.startsWith(BUN_HEADER) && !code.startsWith(CJS_OPEN)) return code;

  if (code.startsWith(BUN_HEADER)) {
    code = code.slice(code.indexOf('\n') + 1);
  }
  if (code.startsWith(CJS_OPEN)) {
    code = code.slice(CJS_OPEN.length);
  }
  const trimmed = code.trimEnd();
  if (trimmed.endsWith(CJS_CLOSE)) {
    code = trimmed.slice(0, -CJS_CLOSE.length);
  }
  return code;
}

export function addShebangHeader(code) {
  if (code.startsWith('#!')) return code;
  return '#!/usr/bin/env node\n' + code;
}

function findCommentHeaderEnd(code) {
  // Use acorn to find the start of the first AST statement.
  // Everything before it is the comment header (copyright, version, etc.)
  try {
    const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
    if (ast.body.length > 0) return ast.body[0].start;
  } catch {}
  return 0;
}

// ──────────────────────────────────────────────
//  P1/P2/P3 AST-based patching
// ──────────────────────────────────────────────

function isHardcodedBuildPath(node) {
  if (node.type !== 'Literal' || typeof node.value !== 'string') return false;
  const v = node.value;
  // Linux/macOS CI: file:///home/runner/work/claude-cli-internal/...
  // Windows CI:     file:///D:/a/claude-cli-internal/... (any drive letter)
  return v.includes('/claude-cli-internal/') && v.startsWith('file:///');
}

export function astPatch(code) {
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' });
  const replacements = [];
  const stats = { p1Paths: 0, p1Requires: 0, p2: false, p3: 0, p5: false, p7: false, p8: false, p9: 0 };

  walk(ast, (node) => {
    // P1: fileURLToPath("file:///home/runner/...") → __filename
    if (node.type === 'CallExpression' &&
        node.callee?.type === 'MemberExpression' &&
        node.callee.property?.name === 'fileURLToPath' &&
        node.arguments?.length === 1 &&
        isHardcodedBuildPath(node.arguments[0])) {
      replacements.push({ start: node.start, end: node.end, replacement: '__filename' });
      stats.p1Paths++;
      return;
    }

    // P1: createRequire("file:///home/runner/...") → require
    if (node.type === 'CallExpression' &&
        node.callee?.type === 'MemberExpression' &&
        node.callee.property?.name === 'createRequire' &&
        node.arguments?.length === 1 &&
        isHardcodedBuildPath(node.arguments[0])) {
      replacements.push({ start: node.start, end: node.end, replacement: 'require' });
      stats.p1Requires++;
      return;
    }

    // P2: if (typeof Bun > "u") throw Error("...Bun required...") → return null
    if (node.type === 'IfStatement' &&
        node.test?.type === 'BinaryExpression' &&
        node.test.operator === '>' &&
        node.test.left?.type === 'UnaryExpression' &&
        node.test.left.operator === 'typeof' &&
        node.test.left.argument?.name === 'Bun' &&
        node.test.right?.value === 'u' &&
        node.consequent?.type === 'ThrowStatement' &&
        node.consequent.argument?.arguments?.[0]?.value?.includes('Bun required')) {
      replacements.push({ start: node.start, end: node.end, replacement: 'if(typeof Bun>"u")return null;' });
      stats.p2 = true;
      return;
    }

    // P3: require("/$bunfs/root/xxx.node") → vendor fallback
    if (node.type === 'CallExpression' &&
        node.callee?.type === 'Identifier' &&
        node.callee.name === 'require' &&
        node.arguments?.length === 1 &&
        node.arguments[0].type === 'Literal' &&
        typeof node.arguments[0].value === 'string' &&
        node.arguments[0].value.startsWith('/$bunfs/root/')) {
      const modulePath = node.arguments[0].value;
      const moduleName = modulePath.replace('/$bunfs/root/', '');
      const baseName = moduleName.replace(/\.node$/, '');
      const vendorRequire = [
        '(function(){try{',
        `var d=require("path").join(__dirname,"vendor","${baseName}",process.arch+"-"+process.platform,"${moduleName}");`,
        'return require(d)',
        `}catch{return require(${JSON.stringify(modulePath)})}`,
        '})()'
      ].join('');
      replacements.push({ start: node.start, end: node.end, replacement: vendorRequire });
      stats.p3++;
      return;
    }

    // P5: Restore isInBundledMode / hasEmbeddedSearchTools guard
    //
    // Bun inlines isEnvTruthy(process.env.EMBEDDED_SEARCH_TOOLS) → isEnvTruthy("true")
    // on macOS/Linux native builds. This causes Glob/Grep tools to be removed
    // because the DP() function always returns true → shadow mode active → tools hidden.
    //
    // Fix (two parts):
    //   a) Replace Literal("true") with process.env.EMBEDDED_SEARCH_TOOLS
    //      → env unset: DP()=false → Grep/Glob tools available (default)
    //      → env=true:  DP() continues to binary check
    //
    //   b) Inject binary availability check after the env check
    //      → bfs+ugrep installed: shadow mode
    //      → not installed: DP()=false → fall back to Grep/Glob tools
    //
    //      Uses globalThis.__dpBinOk for memoization (which runs once).
    if (node.type === 'FunctionDeclaration' &&
        node.params.length === 0 &&
        node.body?.type === 'BlockStatement' &&
        node.body.body.length >= 2) {
      const s1 = node.body.body[0];

      if (s1?.type === 'IfStatement' &&
          s1.test?.type === 'UnaryExpression' &&
          s1.test.operator === '!' &&
          s1.test.argument?.type === 'CallExpression' &&
          s1.test.argument.arguments?.length === 1 &&
          s1.test.argument.arguments[0]?.type === 'Literal' &&
          s1.test.argument.arguments[0]?.value === 'true' &&
          s1.consequent?.type === 'ReturnStatement') {

        const restSrc = code.slice(s1.end, node.body.end);
        if (restSrc.includes('CLAUDE_CODE_ENTRYPOINT')) {
          // P5a: restore env var check
          const lit = s1.test.argument.arguments[0];
          replacements.push({
            start: lit.start,
            end: lit.end,
            replacement: 'process.env.EMBEDDED_SEARCH_TOOLS',
          });

          // P5b: inject binary availability check after the env-check if-statement
          // Uses "which" on unix, "where" on windows. If both bfs+ugrep are
          // found, shadow mode proceeds; otherwise DP() returns false → Tool mode.
          const binCheck = 'if(typeof globalThis.__dpBinOk>"u"){try{let _wc=process.platform==="win32"?"where":"which";require("child_process").execFileSync(_wc,["bfs"],{encoding:"utf8",timeout:2e3});require("child_process").execFileSync(_wc,["ugrep"],{encoding:"utf8",timeout:2e3});globalThis.__dpBinOk=!0}catch{globalThis.__dpBinOk=!1}}if(!globalThis.__dpBinOk)return!1;';
          replacements.push({
            start: s1.end,
            end: s1.end,
            replacement: binCheck,
          });

          stats.p5 = true;
          return;
        }
      }
    }

    // P8: Fix AF_() shadow fallback path for Node.js
    //
    // Bun native build: ARGV0=bfs "$claude_multicall_binary" args
    // Node.js: process.execPath = node, ~/.local/bin/claude doesn't exist.
    //
    // Fix: after the fallback path `M` is computed (M = ~/.local/bin/claude),
    // inject a JS-level `which` resolution that overwrites M with the real
    // system binary path (e.g. /usr/local/bin/bfs). This runs ONCE at
    // snapshot-generation time, not on every shell invocation.
    //
    // AST pattern: FunctionDeclaration (2-4 params) whose body contains
    // 'ARGV0' and '_cc_bin'. Find the VariableDeclarator for M (the
    // fallback path) and inject resolution after it.
    if (!stats.p8 &&
        node.type === 'FunctionDeclaration' &&
        node.params.length >= 2 && node.params.length <= 4) {
      const body = code.slice(node.start, node.end);
      if (body.includes('ARGV0') && body.includes('_cc_bin') && body.includes('command')) {
        // Find `M=L?PV(f):f` or similar — the assignment that sets the fallback path.
        // It's a ternary (ConditionalExpression) involving the windows check.
        // We look for the variable M (3rd declarator in the `let` chain).
        const fnName = node.id?.name || 'AF_';
        // params[1] = _ (target binary name). May be Identifier or AssignmentPattern (default param)
        const p1 = node.params[1];
        const paramTarget = p1?.name ?? p1?.left?.name; // _ = "bfs" or "ugrep"

        // Inject before the `return[` statement that builds the shell function array.
        // The return statement is always present and unique within AF_.
        // We insert a try/catch that resolves the system binary via `which`
        // and overwrites M (the fallback path variable).
        const returnIdx = code.indexOf('return[', node.start);
        if (returnIdx !== -1 && returnIdx < node.end) {
          const injection = `try{let _wc=process.platform==="win32"?"where":"which",_w=require("child_process").execFileSync(_wc,[${paramTarget}],{encoding:"utf8",timeout:2e3}).trim();if(_w&&require("fs").existsSync(_w))M=_w}catch{}`;
          replacements.push({ start: returnIdx, end: returnIdx, replacement: injection });
          stats.p8 = true;
        }
      }
    }

    // P7: Expose bundled HttpsProxyAgent as globalThis.__HttpsProxyAgent
    //
    // Bun's ws supports {proxy: url} natively; Node's ws does not.
    // The polyfill patches ws.WebSocket to convert proxy → agent, but needs
    // HttpsProxyAgent which is already bundled in cli.js.
    //
    // AST pattern:
    //   AssignmentExpression: <exports>.HttpsProxyAgent = <Identifier>
    //   where the RHS is the class reference
    //
    // Fix: append globalThis.__HttpsProxyAgent = <Identifier> after the assignment
    if (!stats.p7 &&
        node.type === 'AssignmentExpression' &&
        node.operator === '=' &&
        node.left?.type === 'MemberExpression' &&
        node.left.property?.type === 'Identifier' &&
        node.left.property.name === 'HttpsProxyAgent' &&
        node.right?.type === 'Identifier') {
      const className = node.right.name;
      replacements.push({
        start: node.end,
        end: node.end,
        replacement: `;globalThis.__HttpsProxyAgent=${className}`,
      });
      stats.p7 = true;
      return;
    }
  });

  let patched = applyReplacements(code, replacements);

  // P9: Rebrand npm package name for update/install commands
  //
  // The build-time constant PACKAGE_URL is inlined as "@anthropic-ai/claude-code"
  // throughout the code. This affects `claude update`, install-type detection,
  // and auto-updater — all of which run `npm install @anthropic-ai/claude-code`.
  //
  // Replace with @cometix/claude-code so updates pull from the correct registry.
  // Safe because "@anthropic-ai/claude-code" only appears as PACKAGE_URL values
  // and path detection strings, not in GitHub URLs (those use "anthropics/claude-code").
  const P9_FROM = '@anthropic-ai/claude-code';
  const P9_TO = '@cometix/claude-code';
  const p9Count = patched.split(P9_FROM).length - 1;
  if (p9Count > 0) {
    patched = patched.replaceAll(P9_FROM, P9_TO);
    stats.p9 = p9Count;
  }

  return { code: patched, stats, replacementCount: replacements.length + p9Count };
}

// ──────────────────────────────────────────────
//  Full pipeline
// ──────────────────────────────────────────────

export async function patchFile(inputPath, outputPath) {
  const raw = await readFile(inputPath, 'utf8');
  console.log(`Input:  ${inputPath} (${raw.length} bytes)`);

  // Strip Bun wrapper
  let code = stripBunWrapper(raw);
  console.log('[OK] Stripped Bun CJS wrapper');

  // AST patching (P1/P2/P3)
  console.log('[..] Parsing AST...');
  const result = astPatch(code);
  code = result.code;

  const s = result.stats;
  console.log(`[OK] P1: Patched ${s.p1Paths} fileURLToPath + ${s.p1Requires} createRequire`);
  console.log(`[${s.p2 ? 'OK' : '--'}] P2: Bun.Transpiler guard ${s.p2 ? 'patched' : 'not found (polyfill handles this)'}`);
  console.log(`[${s.p3 > 0 ? 'OK' : '! '}] P3: Patched ${s.p3} $bunfs require paths`);
  console.log(`[${s.p5 ? 'OK' : '! '}] P5: EMBEDDED_SEARCH_TOOLS guard ${s.p5 ? 'restored' : 'not found (may be Windows build)'}`);
  console.log(`[${s.p7 ? 'OK' : '! '}] P7: HttpsProxyAgent ${s.p7 ? 'exposed as globalThis.__HttpsProxyAgent' : 'not found'}`);
  console.log(`[${s.p8 ? 'OK' : '! '}] P8: AF_ shadow function ${s.p8 ? 'patched to prefer system bfs/ugrep' : 'not found'}`);
  console.log(`[${s.p9 > 0 ? 'OK' : '! '}] P9: Package name ${s.p9 > 0 ? `rebranded (${s.p9} occurrences)` : 'no @anthropic-ai references found'}`);

  // AST validation
  try {
    acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' });
    console.log('[OK] Post-patch AST validation passed');
  } catch (e) {
    console.error('[X]  Post-patch AST validation FAILED:', e.message);
  }

  // Inject Bun polyfill shim (for versions that removed typeof Bun guards)
  const bunGuardCount = (code.match(/typeof Bun/g) || []).length;
  if (bunGuardCount < 10) {
    let polyfill = readFileSync(join(__dirname, '..', 'templates', 'bun-polyfill.js'), 'utf8');
    // Strip polyfill's own shebang — we'll add a unified one at the end
    polyfill = polyfill.replace(/^#![^\n]*\n/, '');

    // Insert polyfill after the comment header (copyright + version lines)
    // so the shebang block stays at the top for readability
    const commentEnd = findCommentHeaderEnd(code);
    code = code.slice(0, commentEnd) + polyfill + '\n' + code.slice(commentEnd);
    console.log(`[OK] P6: Injected Bun polyfill shim (${bunGuardCount} guards < 10 threshold)`);
  } else {
    console.log(`[! ] P6: Bun polyfill skipped (${bunGuardCount} guards >= 10 — dual-runtime fallbacks present)`);
  }

  // Add shebang header
  code = addShebangHeader(code);

  console.log(`Output: ${outputPath} (${code.length} bytes)`);
  await writeFile(outputPath, code);
  return { inputSize: raw.length, outputSize: code.length, stats: s };
}

// ──────────────────────────────────────────────
//  CLI
// ──────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith('node-compat-patch.mjs');
if (isMain) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath) {
    console.error('Usage: node node-compat-patch.mjs <input-cli.js> [output-cli.js]');
    process.exit(1);
  }
  await patchFile(inputPath, outputPath ?? inputPath.replace(/\.js$/, '-patched.js'));
}
