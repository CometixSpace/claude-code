import { readFile, writeFile } from 'node:fs/promises';
import * as acorn from 'acorn';

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

// ──────────────────────────────────────────────
//  P1/P2/P3 AST-based patching
// ──────────────────────────────────────────────

const BUILD_PATH_PREFIX = 'file:///home/runner/work/claude-cli-internal/claude-cli-internal/';

function isHardcodedBuildPath(node) {
  return node.type === 'Literal' &&
    typeof node.value === 'string' &&
    node.value.startsWith(BUILD_PATH_PREFIX);
}

export function astPatch(code) {
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' });
  const replacements = [];
  const stats = { p1Paths: 0, p1Requires: 0, p2: false, p3: 0, p5: false };

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
    // on macOS/Linux native builds. This causes Glob/Grep tools to be removed.
    //
    // AST pattern:
    //   FunctionDeclaration (params: 0)
    //     BlockStatement
    //       [0] IfStatement
    //             test: UnaryExpression(!)
    //               argument: CallExpression(args: [Literal("true")])
    //             consequent: ReturnStatement
    //       [1] VariableDeclaration
    //             init: MemberExpression containing "CLAUDE_CODE_ENTRYPOINT"
    //
    // Fix: replace Literal("true") with process.env.EMBEDDED_SEARCH_TOOLS
    //      so Node.js (without that env var) → false → Glob/Grep restored.
    if (node.type === 'FunctionDeclaration' &&
        node.params.length === 0 &&
        node.body?.type === 'BlockStatement' &&
        node.body.body.length >= 2) {
      const s1 = node.body.body[0];
      const s2 = node.body.body[1];

      if (s1?.type === 'IfStatement' &&
          s1.test?.type === 'UnaryExpression' &&
          s1.test.operator === '!' &&
          s1.test.argument?.type === 'CallExpression' &&
          s1.test.argument.arguments?.length === 1 &&
          s1.test.argument.arguments[0]?.type === 'Literal' &&
          s1.test.argument.arguments[0]?.value === 'true' &&
          s1.consequent?.type === 'ReturnStatement' &&
          s2?.type === 'VariableDeclaration') {

        const initSrc = code.slice(s2.declarations?.[0]?.init?.start ?? 0, s2.declarations?.[0]?.init?.end ?? 0);
        if (initSrc.includes('CLAUDE_CODE_ENTRYPOINT')) {
          const lit = s1.test.argument.arguments[0];
          replacements.push({
            start: lit.start,
            end: lit.end,
            replacement: 'process.env.EMBEDDED_SEARCH_TOOLS',
          });
          stats.p5 = true;
          return;
        }
      }
    }
  });

  const patched = applyReplacements(code, replacements);
  return { code: patched, stats, replacementCount: replacements.length };
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
  console.log(`[${s.p2 ? 'OK' : '! '}] P2: Bun.Transpiler guard ${s.p2 ? 'patched' : 'not found'}`);
  console.log(`[${s.p3 > 0 ? 'OK' : '! '}] P3: Patched ${s.p3} $bunfs require paths`);
  console.log(`[${s.p5 ? 'OK' : '! '}] P5: EMBEDDED_SEARCH_TOOLS guard ${s.p5 ? 'restored' : 'not found (may be Windows build)'}`);

  // AST validation
  try {
    acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' });
    console.log('[OK] Post-patch AST validation passed');
  } catch (e) {
    console.error('[X]  Post-patch AST validation FAILED:', e.message);
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
