#!/bin/bash
#
# Claude Code Cometix ASR Voice Stream Patch
#
# Replaces Anthropic Deepgram WSS STT (connectVoiceStream / d1o) with
# local cometix-asr Node-API addon (Frontier ASR), and unlocks VoiceMode UI
# for non-official / non-claude.ai subscription gates.
#
# THE BUG / GOAL:
# 1) Voice STT hardcodes Deepgram WSS:
#      /api/ws/speech_to_text/voice_stream + stt_provider=deepgram-nova3
# 2) VoiceMode is hidden unless official Claude.ai OAuth + allow_voice_mode:
#      Vmr() = l1o()&&aan()&&c1o()  → isHidden = !Vmr()
#      Uua() requires HE()+accessToken (blocks stream path without OAuth)
#
# FIX POINTS (all pure AST; names renamable):
# 1) Voice UI gate Gate() used by get isHidden(){return!Gate()} near name:"voice"
#      Gate body: return A()&&B()&&C()  (pre-2.1.212, 3-call)
#               or return A()&&B()      (2.1.212+, e.g. Jyr = wUo && CUo)
# 2) isVoiceStreamAvailable target (accessToken body)
# 3) name:"voice" availability:["claude-ai"] → void 0 (empty arrays are still rejected)
# 4) Add Voice mode (off / hold / tap) to the main /config settings array
# 5) Auth probe Lxo-like try{if(!Auth())return!1;return hasToken()}catch
# 6) Feature flag kxo-like return Vi("allow_voice_mode") → true
# 7) connectVoiceStream async fn → cometix-asr adapter
# 8) Copy libcometix-asr .node → vendor/cometix-asr
#
# Usage:
#   ./apply-claude-code-enable-voice-mode.sh
#   ./apply-claude-code-enable-voice-mode.sh /path/to/cli.js
#   ./apply-claude-code-enable-voice-mode.sh --check
#   ./apply-claude-code-enable-voice-mode.sh --restore
#
# Runtime Preview trace (opt-in; contains transcript text):
#   COMETIX_ASR_TRACE_FILE=/absolute/path/cometix-asr-preview.jsonl claude
#
# Layout (relative sibling only):
#   apply-claude-code-enable-voice-mode.sh
#   cometix-asr/libcometix-asr.<platform>.node
#   cometix-asr/index.js
#
# did / product config: all inside Rust addon (not this script)
#

set -e

# ============================================================
# Configuration
# ============================================================
BACKUP_SUFFIX="backup-cometix-asr"
FIX_DESCRIPTION="Unlock VoiceMode gate + replace STT with Cometix Frontier ASR (libcometix-asr.node)"

# ============================================================
# Color output
# ============================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

success() { echo -e "${GREEN}[OK]${NC} $1"; }
warning() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[X]${NC} $1"; }
info() { echo -e "${BLUE}[>]${NC} $1"; }

# ============================================================
# 原生模块：固定与脚本同级 ./cometix-asr/（无环境变量、无绝对路径）
#   new_scripts/apply-claude-code-enable-voice-mode.sh
#   new_scripts/cometix-asr/libcometix-asr.<platform>.node
#   new_scripts/cometix-asr/index.js
# ============================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$SCRIPT_DIR/cometix-asr"
if ! compgen -G "$DIST_DIR"/libcometix-asr*.node >/dev/null 2>&1; then
  error "缺少同级原生模块: $DIST_DIR/libcometix-asr*.node"
  echo "布局: $(basename "$SCRIPT_DIR")/cometix-asr/{libcometix-asr.<platform>.node,index.js}"
  exit 1
fi

# ============================================================
# Args
# ============================================================
CHECK_ONLY=false
RESTORE=false
CLI_PATH_ARG=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --check|-c) CHECK_ONLY=true; shift ;;
    --restore|-r) RESTORE=true; shift ;;
    --help|-h)
      echo "Usage: $0 [options] [cli.js path]"
      echo ""
      echo "$FIX_DESCRIPTION"
      echo ""
      echo "Options:"
      echo "  --check, -c    Check only"
      echo "  --restore, -r  Restore from backup"
      echo "  --help, -h     Help"
      echo ""
      echo "Sibling module required: ./cometix-asr/libcometix-asr.<platform>.node"
      exit 0
      ;;
    -*)
      error "Unknown option: $1"
      exit 1
      ;;
    *)
      if [[ -z "$CLI_PATH_ARG" ]]; then
        CLI_PATH_ARG="$1"
      else
        error "Unexpected argument: $1"
        exit 1
      fi
      shift
      ;;
  esac
done

# ============================================================
# Find cli.js
# ============================================================
find_cli_path() {
  local locations=(
    "$HOME/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js"
    "$HOME/.claude/local/node_modules/@cometix/claude-code/cli.js"
    "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js"
    "/usr/local/lib/node_modules/@cometix/claude-code/cli.js"
    "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"
  )
  if command -v npm &>/dev/null; then
    local npm_root
    npm_root=$(npm root -g 2>/dev/null || true)
    if [[ -n "$npm_root" ]]; then
      locations+=("$npm_root/@anthropic-ai/claude-code/cli.js")
      locations+=("$npm_root/@cometix/claude-code/cli.js")
    fi
  fi
  # also search common ClaudeCodeRev trees
  if [[ -d "$HOME/WorkSpace/Node/ClaudeCodeRev" ]]; then
    local found
    found=$(find "$HOME/WorkSpace/Node/ClaudeCodeRev" -path '*/cc/cli.js' 2>/dev/null | sort -V | tail -1 || true)
    if [[ -n "$found" ]]; then
      locations+=("$found")
    fi
  fi
  for path in "${locations[@]}"; do
    if [[ -f "$path" ]]; then
      echo "$path"
      return 0
    fi
  done
  return 1
}

if [[ -n "$CLI_PATH_ARG" ]]; then
  if [[ -f "$CLI_PATH_ARG" ]]; then
    CLI_PATH="$CLI_PATH_ARG"
    info "Using specified cli.js: $CLI_PATH"
  else
    error "Specified file not found: $CLI_PATH_ARG"
    exit 1
  fi
else
  CLI_PATH=$(find_cli_path) || {
    error "Claude Code cli.js not found"
    echo "Tip: $0 /path/to/cli.js"
    exit 1
  }
  info "Found Claude Code: $CLI_PATH"
fi

CLI_DIR=$(dirname "$CLI_PATH")

# ============================================================
# Restore
# ============================================================
if $RESTORE; then
  LATEST_BACKUP=$(ls -t "$CLI_DIR"/cli.js.${BACKUP_SUFFIX}-* 2>/dev/null | head -1)
  if [[ -z "$LATEST_BACKUP" ]]; then
    LATEST_BACKUP=$(ls -t "$CLI_DIR"/cli.js.backup-* 2>/dev/null | head -1)
  fi
  if [[ -n "$LATEST_BACKUP" ]]; then
    cp "$LATEST_BACKUP" "$CLI_PATH"
    success "Restored from backup: $LATEST_BACKUP"
    exit 0
  else
    error "No backup file found (cli.js.${BACKUP_SUFFIX}-*)"
    exit 1
  fi
fi

echo ""
info "cometix-asr dist: $DIST_DIR"

# ============================================================
# Install vendor addon next to cli.js (skip in --check)
# ============================================================
install_vendor() {
  local vendor="$CLI_DIR/vendor/cometix-asr"
  mkdir -p "$vendor"
  # This directory is dedicated to the ASR binding; purge stale natives.
  rm -f "$vendor"/*.node 2>/dev/null || true

  local copied=0
  # ONLY libcometix-asr platform binaries — never copy unrelated *.node
  local f
  for f in "$DIST_DIR"/libcometix-asr.*.node "$DIST_DIR"/libcometix-asr.node; do
    if [[ -f "$f" ]]; then
      cp -f "$f" "$vendor/"
      copied=1
      info "Installed $(basename "$f")"
    fi
  done
  if [[ -f "$DIST_DIR/index.js" ]]; then
    cp -f "$DIST_DIR/index.js" "$vendor/index.js"
    copied=1
  fi
  if [[ -f "$DIST_DIR/index.d.ts" ]]; then
    cp -f "$DIST_DIR/index.d.ts" "$vendor/" 2>/dev/null || true
  fi
  if [[ -f "$DIST_DIR/package.json" ]]; then
    cp -f "$DIST_DIR/package.json" "$vendor/" 2>/dev/null || true
  fi

  if [[ $copied -eq 0 ]]; then
    error "No libcometix-asr*.node under $DIST_DIR — run: cd api/cometix-asr && npm run build"
    exit 1
  fi

  # verify NAPI surface
  if ! node -e "const m=require(process.argv[1]); if(typeof m.startSession!=='function') process.exit(2);" "$vendor/index.js" 2>/dev/null \
    && ! node -e "
      const fs=require('fs'),p=process.argv[1];
      const n=fs.readdirSync(p).find(f=>f.startsWith('libcometix-asr')&&f.endsWith('.node'));
      if(!n) process.exit(3);
      const m=require(p+'/'+n);
      if(typeof m.startSession!=='function') process.exit(2);
    " "$vendor" 2>/dev/null; then
    error "vendor load failed: startSession missing (wrong .node?)"
    ls -la "$vendor" || true
    exit 1
  fi
  success "Vendor OK: $vendor (startSession present)"
}

if ! $CHECK_ONLY; then
  install_vendor
fi

# ============================================================
# Acorn
# ============================================================
ACORN_PATH="/tmp/acorn-claude-fix.js"
if [[ ! -f "$ACORN_PATH" ]]; then
  info "Downloading acorn parser..."
  curl -sL "https://unpkg.com/acorn@8.16.0/dist/acorn.js" -o "$ACORN_PATH" || {
    error "Failed to download acorn parser"
    exit 1
  }
fi

# ============================================================
# Node patch (AST)
# ============================================================
PATCH_SCRIPT=$(mktemp)
cat > "$PATCH_SCRIPT" << 'PATCH_EOF'
const fs = require('fs');
const path = require('path');
const acornPath = process.argv[2];
const acorn = require(acornPath);

const cliPath = process.argv[3];
const checkOnly = process.argv[4] === '--check';
const backupSuffix = process.env.BACKUP_SUFFIX || 'backup-cometix-asr';

let code = fs.readFileSync(cliPath, 'utf-8');

let shebang = '';
if (code.startsWith('#!')) {
  const idx = code.indexOf('\n');
  shebang = code.slice(0, idx + 1);
  code = code.slice(idx + 1);
}

const MARKER = '/*COMETIX_ASR_VOICE_STREAM*/';
const GATE_MARKER = '/*COMETIX_VOICE_GATE*/';
const STREAM_MARKER = '/*COMETIX_VOICE_STREAM_AVAIL*/';
const ALREADY =
  /COMETIX_ASR_VOICE_STREAM|COMETIX_VOICE_GATE|COMETIX_VOICE_AVAIL|COMETIX_VOICE_AUTH|COMETIX_VOICE_FLAG|cometix-asr voice adapter/i;

let fixes = {
  voiceGateVmr: { found: false, patched: false, node: null },
  voiceStreamAvail: { found: false, patched: false, node: null },
  voiceAvailability: { found: false, patched: false, node: null },
  voiceSettings: { found: false, patched: false, node: null, bindings: null },
  voiceAuthProbe: { found: false, patched: false, node: null }, // Lxo-like
  voiceFeatureFlag: { found: false, patched: false, node: null }, // kxo-like allow_voice_mode
  connectVoiceStream: { found: false, patched: false, node: null, name: null },
};

function findNodes(node, predicate, results = []) {
  if (!node || typeof node !== 'object') return results;
  if (predicate(node)) results.push(node);
  for (const key in node) {
    if (node[key] && typeof node[key] === 'object') {
      if (Array.isArray(node[key])) {
        node[key].forEach((child) => findNodes(child, predicate, results));
      } else {
        findNodes(node[key], predicate, results);
      }
    }
  }
  return results;
}

const src = (node) => code.slice(node.start, node.end);

let ast;
try {
  ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true });
} catch (e) {
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true });
  } catch (e2) {
    console.error('PARSE_ERROR:' + e2.message);
    process.exit(1);
  }
}

// ---------- AST helpers (structure only, no regex matching) ----------
function isId(n, name) {
  if (!n || n.type !== 'Identifier') return false;
  if (name === undefined) return true;
  return n.name === name;
}
function isCall(n, name) {
  return n && n.type === 'CallExpression' && isId(n.callee, name);
}
function isLit(n, v) {
  return n && n.type === 'Literal' && n.value === v;
}
/** MemberExpression e.accessToken */
function isMember(n, obj, prop) {
  return (
    n &&
    n.type === 'MemberExpression' &&
    !n.computed &&
    isId(n.object, obj) &&
    isId(n.property, prop)
  );
}
/** BinaryExpression a && b (flat collect) */
function collectAnd(n, out = []) {
  if (!n) return out;
  if (n.type === 'LogicalExpression' && n.operator === '&&') {
    collectAnd(n.left, out);
    collectAnd(n.right, out);
  } else {
    out.push(n);
  }
  return out;
}
function collectStringLits(node, out = []) {
  findNodes(node, (n) => n.type === 'Literal' && typeof n.value === 'string').forEach((n) =>
    out.push(n.value),
  );
  return out;
}
function collectPropNames(node, out = new Set()) {
  findNodes(node, (n) => n.type === 'Property' || n.type === 'MethodDefinition').forEach((n) => {
    if (n.key) {
      if (n.key.type === 'Identifier') out.add(n.key.name);
      if (n.key.type === 'Literal' && typeof n.key.value === 'string') out.add(n.key.value);
    }
  });
  findNodes(node, (n) => n.type === 'MemberExpression' && !n.computed && isId(n.property)).forEach(
    (n) => out.add(n.property.name),
  );
  return out;
}

// --- Gate 1: voice UI gate (name-agnostic) ---
// Pattern A: get isHidden(){ return !Gate() } near voice command object
//   (argumentHint hold|tap|off, availability claude-ai, isEnabled)
// Gate function body:
//   pre-2.1.212: return A() && B() && C()   (3 zero-arg calls)
//   2.1.212+:    return A() && B()          (2 zero-arg calls, e.g. Jyr=wUo&&CUo)
{
  // Accept 2-call (2.1.212+) and 3-call (older) AND-chains of zero-arg calls.
  function isVoiceGateAndChain(retArg) {
    const parts = collectAnd(retArg);
    const calls = parts.filter(
      (p) => p.type === 'CallExpression' && isId(p.callee) && (!p.arguments || p.arguments.length === 0),
    );
    // every leaf must be a zero-arg call; length 2 or 3
    if (calls.length !== parts.length) return null;
    if (calls.length !== 2 && calls.length !== 3) return null;
    return calls;
  }

  const getters = findNodes(
    ast,
    (n) =>
      n.type === 'Property' &&
      n.kind === 'get' &&
      ((n.key && n.key.type === 'Identifier' && n.key.name === 'isHidden') ||
        (n.key && n.key.type === 'Literal' && n.key.value === 'isHidden')),
  );
  for (const g of getters) {
    const fnExpr = g.value; // FunctionExpression
    const stmts = fnExpr && fnExpr.body && fnExpr.body.body;
    if (!stmts || stmts.length !== 1 || stmts[0].type !== 'ReturnStatement') continue;
    const arg = stmts[0].argument;
    if (!arg || arg.type !== 'UnaryExpression' || arg.operator !== '!') continue;
    if (arg.argument.type !== 'CallExpression' || !isId(arg.argument.callee)) continue;
    if (arg.argument.arguments && arg.argument.arguments.length) continue;
    const gateName = arg.argument.callee.name;
    // contextual: nearby object should look like /voice command
    const around = code.slice(Math.max(0, g.start - 500), Math.min(code.length, g.end + 300));
    const voiceCtx =
      around.includes('hold|tap|off') ||
      around.includes('[hold|tap|off]') ||
      around.includes('claude-ai') ||
      around.includes('Voice mode') ||
      around.includes('voice mode') ||
      around.includes('allow_voice') ||
      /argumentHint:\s*["']\[hold/.test(around) ||
      around.includes('hold-to-talk') ||
      around.includes('name:"voice"') ||
      around.includes('name:\'voice\'');
    if (!voiceCtx) continue;
    // resolve FunctionDeclaration gateName
    const gateFns = findNodes(
      ast,
      (n) => n.type === 'FunctionDeclaration' && isId(n.id, gateName) && n.params.length === 0,
    );
    if (!gateFns.length) continue;
    const gateFn = gateFns[0];
    const body = gateFn.body && gateFn.body.body;
    if (!body || body.length !== 1 || body[0].type !== 'ReturnStatement') continue;
    // already patched: return !0 /*marker*/
    if (src(gateFn).includes('COMETIX_VOICE_GATE')) {
      fixes.voiceGateVmr.found = true;
      fixes.voiceGateVmr.already = true;
      fixes.voiceGateVmr.name = gateName;
      console.log('FOUND:voiceGateVmr -> already patched ' + gateName);
      break;
    }
    const calls = isVoiceGateAndChain(body[0].argument);
    if (calls) {
      fixes.voiceGateVmr.found = true;
      fixes.voiceGateVmr.node = gateFn;
      fixes.voiceGateVmr.name = gateName;
      console.log(
        'FOUND:voiceGateVmr -> AST ' +
          gateName +
          '() ' +
          calls.length +
          '-call &&-chain via isHidden near voice',
      );
      break;
    }
  }
  // Pattern B fallback: 0-arg FunctionDeclaration return A()&&B()[&&C()] where
  // one callee's body contains Literal "allow_voice_mode" (CUo/kxo pattern)
  if (!fixes.voiceGateVmr.found) {
    const fns = findNodes(
      ast,
      (n) => n.type === 'FunctionDeclaration' && n.id && n.params.length === 0,
    );
    for (const fn of fns) {
      const body = fn.body && fn.body.body;
      if (!body || body.length !== 1 || body[0].type !== 'ReturnStatement') continue;
      const calls = isVoiceGateAndChain(body[0].argument);
      if (!calls) continue;
      // one of the AND leaves should resolve to allow_voice_mode feature check
      let hasAllowVoice = false;
      for (const c of calls) {
        const callees = findNodes(
          ast,
          (n) => n.type === 'FunctionDeclaration' && isId(n.id, c.callee.name),
        );
        if (!callees[0]) continue;
        const lits = [];
        collectStringLits(callees[0], lits);
        if (lits.some((s) => s === 'allow_voice_mode')) {
          hasAllowVoice = true;
          break;
        }
      }
      if (hasAllowVoice) {
        fixes.voiceGateVmr.found = true;
        fixes.voiceGateVmr.node = fn;
        fixes.voiceGateVmr.name = fn.id.name;
        console.log(
          'FOUND:voiceGateVmr -> AST ' +
            fn.id.name +
            '() ' +
            calls.length +
            '-call chain + allow_voice_mode callee',
        );
        break;
      }
    }
  }
}

// --- Gate 2: stream availability (name-agnostic, pure body structure) ---
// function X(){ if(!Auth()) return !1; let e = Session(); return e!==null && e.accessToken!==null }
// Prefer function referenced by isVoiceStreamAvailable: () => X  (arrow returns X ref, not call)
{
  const candidates = [];
  const fns = findNodes(
    ast,
    (n) => n.type === 'FunctionDeclaration' && n.id && n.params.length === 0,
  );
  for (const fn of fns) {
    const stmts = fn.body && fn.body.body;
    if (!stmts || stmts.length < 2) continue;
    const if0 = stmts[0];
    if (if0.type !== 'IfStatement') continue;
    const test = if0.test;
    if (
      !(
        test &&
        test.type === 'UnaryExpression' &&
        test.operator === '!' &&
        test.argument &&
        test.argument.type === 'CallExpression'
      )
    )
      continue;
    // variable binding from a call
    const hasLetCall = stmts.some(
      (s) =>
        s.type === 'VariableDeclaration' &&
        s.declarations.some((d) => d.init && d.init.type === 'CallExpression'),
    );
    if (!hasLetCall) continue;
    const ret = stmts.find((s) => s.type === 'ReturnStatement');
    if (!ret || !ret.argument) continue;
    const hasAccess =
      findNodes(
        ret.argument,
        (n) =>
          n.type === 'MemberExpression' &&
          !n.computed &&
          isId(n.property, 'accessToken'),
      ).length > 0;
    if (!hasAccess) continue;
    candidates.push(fn);
  }
  // Prefer fn whose Identifier is returned by isVoiceStreamAvailable arrow
  let chosen = null;
  const props = findNodes(
    ast,
    (n) =>
      n.type === 'Property' &&
      (isId(n.key, 'isVoiceStreamAvailable') ||
        (n.key && n.key.type === 'Literal' && n.key.value === 'isVoiceStreamAvailable')),
  );
  for (const p of props) {
    const v = p.value;
    // () => tVs   → body Identifier tVs
    if (v && v.type === 'ArrowFunctionExpression' && isId(v.body)) {
      const name = v.body.name;
      chosen = candidates.find((f) => f.id && f.id.name === name) || null;
      if (chosen) break;
    }
    // () => tVs() → body CallExpression
    if (
      v &&
      v.type === 'ArrowFunctionExpression' &&
      v.body &&
      v.body.type === 'CallExpression' &&
      isId(v.body.callee)
    ) {
      const name = v.body.callee.name;
      chosen = candidates.find((f) => f.id && f.id.name === name) || null;
      if (chosen) break;
    }
  }
  if (!chosen && candidates.length === 1) chosen = candidates[0];
  // if multiple, pick shortest body (stream check is tiny)
  if (!chosen && candidates.length > 1) {
    candidates.sort((a, b) => a.end - a.start - (b.end - b.start));
    chosen = candidates[0];
  }
  if (chosen) {
    fixes.voiceStreamAvail.found = true;
    fixes.voiceStreamAvail.node = chosen;
    fixes.voiceStreamAvail.name = chosen.id.name;
    if (src(chosen).includes('COMETIX_VOICE_STREAM_AVAIL')) {
      fixes.voiceStreamAvail.already = true;
      console.log('FOUND:voiceStreamAvail -> already patched ' + chosen.id.name);
    } else {
      console.log(
        'FOUND:voiceStreamAvail -> AST ' +
          chosen.id.name +
          '() !Auth + accessToken (isVoiceStreamAvailable)',
      );
    }
  } else {
    // already-patched: isVoiceStreamAvailable:()=>tVs where tVs body has marker
    const props = findNodes(
      ast,
      (n) =>
        n.type === 'Property' &&
        (isId(n.key, 'isVoiceStreamAvailable') ||
          (n.key && n.key.type === 'Literal' && n.key.value === 'isVoiceStreamAvailable')),
    );
    for (const p of props) {
      const v = p.value;
      let name = null;
      if (v && v.type === 'ArrowFunctionExpression' && isId(v.body)) name = v.body.name;
      if (!name) continue;
      const fns = findNodes(
        ast,
        (n) => n.type === 'FunctionDeclaration' && isId(n.id, name),
      );
      if (fns[0] && src(fns[0]).includes('COMETIX_VOICE_STREAM_AVAIL')) {
        fixes.voiceStreamAvail.found = true;
        fixes.voiceStreamAvail.already = true;
        fixes.voiceStreamAvail.name = name;
        console.log('FOUND:voiceStreamAvail -> already patched ' + name);
        break;
      }
    }
  }
}

// --- Gate 3: command registry availability ---
// ohr(command) returns true only when `!command.availability` or one listed
// account class matches. An empty array is truthy and therefore rejects the
// command, so the value must become undefined rather than `[]`.
{
  const objs = findNodes(ast, (n) => n.type === 'ObjectExpression');
  for (const o of objs) {
    const props = o.properties.filter((p) => p.type === 'Property');
    const nameP = props.find(
      (p) =>
        (isId(p.key, 'name') ||
          (p.key && p.key.type === 'Literal' && p.key.value === 'name')) &&
        p.value &&
        p.value.type === 'Literal' &&
        p.value.value === 'voice',
    );
    if (!nameP) continue;
    const av = props.find(
      (p) =>
        isId(p.key, 'availability') ||
        (p.key && p.key.type === 'Literal' && p.key.value === 'availability'),
    );
    if (!av || !av.value) continue;

    const afterValue = code.slice(av.value.start, Math.min(o.end, av.value.end + 96));
    const hasMarker = afterValue.includes('COMETIX_VOICE_AVAIL');
    const isUndefined =
      av.value.type === 'UnaryExpression' &&
      av.value.operator === 'void' &&
      av.value.argument &&
      av.value.argument.type === 'Literal' &&
      av.value.argument.value === 0;
    if (hasMarker && isUndefined) {
      fixes.voiceAvailability.found = true;
      fixes.voiceAvailability.already = true;
      console.log('FOUND:voiceAvailability -> already unlocked with undefined');
      break;
    }

    if (av.value.type !== 'ArrayExpression') continue;
    const hasClaudeAi = av.value.elements.some(
      (el) => el && el.type === 'Literal' && el.value === 'claude-ai',
    );
    const isEmpty = av.value.elements.length === 0;
    if (!hasClaudeAi && !(hasMarker && isEmpty)) continue;

    fixes.voiceAvailability.found = true;
    fixes.voiceAvailability.node = av.value;
    console.log(
      hasMarker
        ? 'FOUND:voiceAvailability -> migrate rejected empty array to undefined'
        : 'FOUND:voiceAvailability -> AST name:"voice" account-gated availability',
    );
    break;
  }
}

// --- Gate 3b: expose a Voice mode row in /config ---
// The command exists independently from the settings panel in this build, so
// add an enum mirroring `/voice off|hold|tap` to the main settings array.
{
  const bindingFor = (pattern, key) => {
    if (!pattern || pattern.type !== 'ObjectPattern') return null;
    const p = pattern.properties.find(
      (x) =>
        x.type === 'Property' &&
        (isId(x.key, key) || (x.key && x.key.type === 'Literal' && x.key.value === key)),
    );
    if (!p) return null;
    if (p.value && p.value.type === 'Identifier') return p.value.name;
    if (
      p.value &&
      p.value.type === 'AssignmentPattern' &&
      p.value.left &&
      p.value.left.type === 'Identifier'
    )
      return p.value.left.name;
    return null;
  };

  const fns = findNodes(ast, (n) => n.type === 'FunctionDeclaration' && n.params.length > 0);
  for (const fn of fns) {
    if (src(fn).includes('COMETIX_VOICE_SETTING')) {
      fixes.voiceSettings.found = true;
      fixes.voiceSettings.already = true;
      console.log('FOUND:voiceSettings -> already exposed');
      break;
    }

    const settingProps = findNodes(
      fn,
      (n) =>
        n.type === 'Property' &&
        (isId(n.key, 'settings') ||
          (n.key && n.key.type === 'Literal' && n.key.value === 'settings')) &&
        n.value &&
        n.value.type === 'ArrayExpression',
    );
    for (const settingsProp of settingProps) {
      const ids = new Set(
        findNodes(
          settingsProp.value,
          (n) =>
            n.type === 'Property' &&
            (isId(n.key, 'id') ||
              (n.key && n.key.type === 'Literal' && n.key.value === 'id')) &&
            n.value &&
            n.value.type === 'Literal' &&
            typeof n.value.value === 'string',
        ).map((n) => n.value.value),
      );
      if (!ids.has('autoCompact') || !ids.has('language') || !ids.has('editor')) continue;

      let pattern = fn.params[0];
      if (pattern && pattern.type === 'Identifier') {
        const destructure = findNodes(
          fn,
          (n) =>
            n.type === 'VariableDeclarator' &&
            n.id &&
            n.id.type === 'ObjectPattern' &&
            n.init &&
            isId(n.init, pattern.name),
        )[0];
        if (destructure) pattern = destructure.id;
      }
      const settingsData = bindingFor(pattern, 'settingsData');
      const setAppState = bindingFor(pattern, 'setAppState');
      const setSettingsData = bindingFor(pattern, 'setSettingsData');
      const setChanges = bindingFor(pattern, 'setChanges');
      const writerCall = findNodes(
        fn,
        (n) =>
          n.type === 'CallExpression' &&
          isId(n.callee) &&
          n.arguments &&
          n.arguments[0] &&
          n.arguments[0].type === 'Literal' &&
          n.arguments[0].value === 'userSettings',
      )[0];
      const writer = writerCall && writerCall.callee.name;
      if (!settingsData || !setAppState || !setSettingsData || !setChanges || !writer) continue;

      fixes.voiceSettings.found = true;
      fixes.voiceSettings.node = settingsProp.value;
      fixes.voiceSettings.bindings = {
        settingsData,
        setAppState,
        setSettingsData,
        setChanges,
        writer,
      };
      console.log('FOUND:voiceSettings -> AST main /config settings array');
      break;
    }
    if (fixes.voiceSettings.found) break;
  }
}

// --- Gate 4: Lxo-like auth probe (still used by UI after Gate short-circuit) ---
// function X(){ try { if (!Auth()) return !1; return TokenProbe(); } catch { return !1 } }
{
  const fns = findNodes(
    ast,
    (n) => n.type === 'FunctionDeclaration' && n.id && n.params.length === 0,
  );
  for (const fn of fns) {
    const stmts = fn.body && fn.body.body;
    if (!stmts || stmts.length !== 1 || stmts[0].type !== 'TryStatement') continue;
    const tryBlock = stmts[0].block && stmts[0].block.body;
    if (!tryBlock || tryBlock.length < 2) continue;
    const if0 = tryBlock[0];
    if (if0.type !== 'IfStatement') continue;
    const test = if0.test;
    if (
      !(
        test &&
        test.type === 'UnaryExpression' &&
        test.operator === '!' &&
        test.argument &&
        test.argument.type === 'CallExpression'
      )
    )
      continue;
    const ret = tryBlock.find((s) => s.type === 'ReturnStatement');
    if (!ret || !ret.argument || ret.argument.type !== 'CallExpression') continue;
    // cross-check: function is one of the 3-call &&-chain callees of voice gate, OR
    // its return callee body mentions accessToken
    const retCallee = ret.argument.callee;
    let mentionsToken = false;
    if (isId(retCallee)) {
      const callees = findNodes(
        ast,
        (n) => n.type === 'FunctionDeclaration' && isId(n.id, retCallee.name),
      );
      if (callees[0]) {
        const lits = [];
        // also check member accessToken in body
        mentionsToken =
          findNodes(
            callees[0],
            (n) =>
              n.type === 'MemberExpression' &&
              !n.computed &&
              isId(n.property, 'accessToken'),
          ).length > 0;
      }
    }
    // also: this fn is called from voice gate's former 3-chain (Lxo/Enn/kxo) — name free:
    // accept if try/catch auth probe near allow_voice_mode sibling in source window
    const around = code.slice(Math.max(0, fn.start - 80), Math.min(code.length, fn.end + 120));
    const nearVoiceFlag = around.includes('allow_voice_mode');
    if (mentionsToken || nearVoiceFlag) {
      fixes.voiceAuthProbe.found = true;
      fixes.voiceAuthProbe.node = fn;
      fixes.voiceAuthProbe.name = fn.id.name;
      console.log(
        'FOUND:voiceAuthProbe -> AST ' +
          fn.id.name +
          '() try/!Auth/token' +
          (nearVoiceFlag ? ' near allow_voice_mode' : ''),
      );
      break;
    }
  }
}

// --- Gate 5: kxo-like return feature("allow_voice_mode") ---
{
  const fns = findNodes(
    ast,
    (n) => n.type === 'FunctionDeclaration' && n.id && n.params.length === 0,
  );
  for (const fn of fns) {
    const stmts = fn.body && fn.body.body;
    if (!stmts || stmts.length !== 1 || stmts[0].type !== 'ReturnStatement') continue;
    const arg = stmts[0].argument;
    if (!arg || arg.type !== 'CallExpression' || !arg.arguments || arg.arguments.length !== 1)
      continue;
    const a0 = arg.arguments[0];
    if (!(a0.type === 'Literal' && a0.value === 'allow_voice_mode')) continue;
    fixes.voiceFeatureFlag.found = true;
    fixes.voiceFeatureFlag.node = fn;
    fixes.voiceFeatureFlag.name = fn.id.name;
    console.log(
      'FOUND:voiceFeatureFlag -> AST ' + fn.id.name + '() return *("allow_voice_mode")',
    );
    break;
  }
}

// --- STT: async FunctionDeclaration (name often d1o/Mxo) = connectVoiceStream ---
// Structure signals: string Literals + Property keys (no free-text regex scan)
{
  const asyncFns = findNodes(
    ast,
    (n) => n.type === 'FunctionDeclaration' && n.async === true && n.id,
  );
  const scored = [];
  for (const fn of asyncFns) {
    const lits = collectStringLits(fn);
    const props = collectPropNames(fn);
    const hasDeepgram = lits.some(
      (s) => s.includes('deepgram') || s === 'stt_provider' || s.includes('deepgram-nova'),
    );
    // also object key stt_provider as Identifier in Property
    const hasSttKey =
      hasDeepgram ||
      findNodes(
        fn,
        (n) =>
          n.type === 'Property' &&
          ((isId(n.key, 'stt_provider') ||
            (n.key.type === 'Literal' && n.key.value === 'stt_provider'))),
      ).length > 0;
    const hasPath = lits.some(
      (s) => s.includes('speech_to_text/voice_stream') || s === '/api/ws/speech_to_text/voice_stream',
    );
    const hasLinear = lits.some((s) => s === 'linear16');
    const hasCbs =
      props.has('onTranscript') ||
      props.has('onReady') ||
      findNodes(fn, (n) => isId(n, 'onTranscript') || isId(n, 'onReady')).length > 0;
    if ((hasSttKey || hasDeepgram) && (hasPath || hasLinear) && hasCbs) {
      scored.push({ fn, score: (hasPath ? 4 : 0) + (hasDeepgram || hasSttKey ? 2 : 0) + (hasCbs ? 1 : 0) + (hasLinear ? 1 : 0) });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.fn.end - a.fn.start - (b.fn.end - b.fn.start));
  if (scored.length > 0) {
    const fn = scored[0].fn;
    fixes.connectVoiceStream.found = true;
    fixes.connectVoiceStream.node = fn;
    fixes.connectVoiceStream.name = fn.id.name;
    console.log(
      'FOUND:connectVoiceStream -> AST ' +
        fn.id.name +
        ' score=' +
        scored[0].score +
        ' len=' +
        (fn.end - fn.start),
    );
  }
}

// Mark already-patched sites by marker (re-apply partial)
{
  const fns = findNodes(ast, (n) => n.type === "FunctionDeclaration" && n.id);
  for (const fn of fns) {
    const b = src(fn);
    if (b.includes("COMETIX_VOICE_AUTH") && !fixes.voiceAuthProbe.found) {
      fixes.voiceAuthProbe.found = true;
      fixes.voiceAuthProbe.already = true;
      fixes.voiceAuthProbe.name = fn.id.name;
      console.log("FOUND:voiceAuthProbe -> already patched " + fn.id.name);
    }
    if (b.includes("COMETIX_VOICE_FLAG") && !fixes.voiceFeatureFlag.found) {
      fixes.voiceFeatureFlag.found = true;
      fixes.voiceFeatureFlag.already = true;
      fixes.voiceFeatureFlag.name = fn.id.name;
      console.log("FOUND:voiceFeatureFlag -> already patched " + fn.id.name);
    }
    if (b.includes("COMETIX_ASR_VOICE_STREAM") && !fixes.connectVoiceStream.found) {
      fixes.connectVoiceStream.found = true;
      fixes.connectVoiceStream.already = true;
      fixes.connectVoiceStream.name = fn.id.name;
      fixes.connectVoiceStream.node = fn;
      console.log("FOUND:connectVoiceStream -> already patched " + fn.id.name);
    }
  }
  const availabilityUnlocked = code.includes('void 0/*COMETIX_VOICE_AVAIL*/');
  if (availabilityUnlocked && !fixes.voiceAvailability.found) {
    fixes.voiceAvailability.found = true;
    fixes.voiceAvailability.already = true;
    console.log('FOUND:voiceAvailability -> already unlocked with undefined');
  }
}

const voiceAvailabilityUnlocked = code.includes('void 0/*COMETIX_VOICE_AVAIL*/');

// Required targets for full unlock
const missing = [];
if (!fixes.voiceGateVmr.found) missing.push('voiceGate');
if (!fixes.voiceStreamAvail.found) missing.push('voiceStreamAvail');
if (!fixes.voiceAvailability.found) missing.push('voiceAvailability');
if (!fixes.voiceSettings.found) missing.push('voiceSettings');
if (!fixes.connectVoiceStream.found) missing.push('connectVoiceStream');
// auth probe + feature flag strongly recommended
if (!fixes.voiceAuthProbe.found) missing.push('voiceAuthProbe');
if (!fixes.voiceFeatureFlag.found) missing.push('voiceFeatureFlag');
if (missing.length) {
  console.error('NOT_FOUND:AST miss: ' + missing.join(', '));
  process.exit(1);
}

// Fully applied only when every unlock marker is present AND CC bridge is final-only
const fullyPatched =
  code.includes('COMETIX_VOICE_GATE') &&
  code.includes('COMETIX_VOICE_STREAM_AVAIL') &&
  voiceAvailabilityUnlocked &&
  code.includes('COMETIX_VOICE_SETTING') &&
  code.includes('COMETIX_VOICE_AUTH') &&
  code.includes('COMETIX_VOICE_FLAG') &&
  code.includes('COMETIX_ASR_VOICE_STREAM') &&
  code.includes('__emitFinalOnce');
if (fullyPatched) {
  console.log('ALREADY_PATCHED');
  process.exit(2);
}

if (checkOnly) {
  console.log('NEEDS_PATCH');
  // count still-unpatched sites among found
  let need = 0;
  if (!code.includes('COMETIX_VOICE_GATE')) need++;
  if (!code.includes('COMETIX_VOICE_STREAM_AVAIL')) need++;
  if (!voiceAvailabilityUnlocked) need++;
  if (!code.includes('COMETIX_VOICE_SETTING')) need++;
  if (!code.includes('COMETIX_VOICE_AUTH')) need++;
  if (!code.includes('COMETIX_VOICE_FLAG')) need++;
  if (!code.includes('COMETIX_ASR_VOICE_STREAM')) need++;
  console.log('PATCH_COUNT:' + need);
  process.exit(1);
}

// ============================================================
// Apply gate unlocks + STT replacement (end→start positions)
// ============================================================
function replaceAt(str, start, end, rep) {
  return str.slice(0, start) + rep + str.slice(end);
}

let replacements = [];

// Only queue replacements for sites not yet marked
function queueFn(fix, marker, markerComment) {
  if (!fix.found || fix.already || !fix.node) return;
  if (src(fix.node).includes(marker)) {
    fix.already = true;
    return;
  }
  const gname = (fix.node.id && fix.node.id.name) || fix.name || 'fn';
  replacements.push({
    start: fix.node.start,
    end: fix.node.end,
    replacement: `function ${gname}(){return!0${markerComment}}`,
    name: fix._key,
  });
}

fixes.voiceGateVmr._key = 'voiceGateVmr';
fixes.voiceStreamAvail._key = 'voiceStreamAvail';
fixes.voiceAuthProbe._key = 'voiceAuthProbe';
fixes.voiceFeatureFlag._key = 'voiceFeatureFlag';

queueFn(fixes.voiceGateVmr, 'COMETIX_VOICE_GATE', GATE_MARKER);
queueFn(fixes.voiceStreamAvail, 'COMETIX_VOICE_STREAM_AVAIL', STREAM_MARKER);
queueFn(fixes.voiceAuthProbe, 'COMETIX_VOICE_AUTH', '/*COMETIX_VOICE_AUTH*/');
queueFn(fixes.voiceFeatureFlag, 'COMETIX_VOICE_FLAG', '/*COMETIX_VOICE_FLAG*/');

// Gate: remove the account-class restriction. `[]` is not sufficient because
// the registry treats an empty availability array as unavailable.
if (
  fixes.voiceAvailability.found &&
  !fixes.voiceAvailability.already &&
  fixes.voiceAvailability.node
) {
  const n = fixes.voiceAvailability.node;
  replacements.push({
    start: n.start,
    end: n.end,
    replacement: `void 0/*COMETIX_VOICE_AVAIL*/`,
    name: 'voiceAvailability',
  });
}

// Settings: add an always-visible Voice mode enum (off / hold / tap).
if (
  fixes.voiceSettings.found &&
  !fixes.voiceSettings.already &&
  fixes.voiceSettings.node &&
  fixes.voiceSettings.bindings
) {
  const n = fixes.voiceSettings.node;
  const b = fixes.voiceSettings.bindings;
  const setting = `{id:"voiceMode",label:"Voice mode",value:((${b.settingsData}?.voice?.enabled??${b.settingsData}?.voiceEnabled)===!0?(${b.settingsData}?.voice?.mode??"hold"):"off"),options:["off","hold","tap"],type:"enum",async onChange(__mode){const __enabled=__mode!=="off",__voiceMode=__mode==="tap"?"tap":__mode==="hold"?"hold":(${b.settingsData}?.voice?.mode??"hold");const __result=await ${b.writer}("userSettings",{voiceEnabled:__enabled,voice:{...${b.settingsData}?.voice,enabled:__enabled,mode:__voiceMode}});if(__result?.error)return{error:__result.error};${b.setSettingsData}(__state=>({...__state,voiceEnabled:__enabled,voice:{...__state?.voice,enabled:__enabled,mode:__voiceMode}}));${b.setAppState}(__state=>({...__state,settings:{...__state.settings,voiceEnabled:__enabled,voice:{...__state.settings?.voice,enabled:__enabled,mode:__voiceMode}}}));${b.setChanges}(__state=>({...__state,"Voice mode":__mode}))}}/*COMETIX_VOICE_SETTING*/,`;
  replacements.push({
    start: n.start + 1,
    end: n.start + 1,
    replacement: setting,
    name: 'voiceSettings',
  });
}

// STT adapter
const fnName = (fixes.connectVoiceStream && fixes.connectVoiceStream.name) || 'd1o';

// Re-apply STT if missing / wrong loader / still embeds product fields
const sttSrc =
  fixes.connectVoiceStream.node ? src(fixes.connectVoiceStream.node) : '';
const sttNeedsWrite =
  fixes.connectVoiceStream.found &&
  fixes.connectVoiceStream.node &&
  (!sttSrc.includes('COMETIX_ASR_VOICE_STREAM') ||
    !sttSrc.includes('startSession==="function"') ||
    sttSrc.includes('f.endsWith(".node")') ||
    sttSrc.includes('appName') ||
    sttSrc.includes('appKey') ||
    sttSrc.includes('wssUrl') ||
    sttSrc.includes('enablePostAsr') ||
    !sttSrc.includes('__emitFinalOnce'));
if (sttNeedsWrite) {
  // wiring only — CC needs ONE final onTranscript(text,true); no product fields here
  const sttBody = `async function ${fnName}(e,t){${MARKER}
/* CC voice bridge: cumulative Preview + one final result for the whole hold */
const _path=require("path"),_fs=require("fs");
function __loadCometixAsr(){
  const tryLoad=(p)=>{try{if(!p)return null;const m=require(p);if(m&&typeof m.startSession==="function")return m}catch{}return null};
  const dirs=[];
  try{dirs.push(_path.join(__dirname,"vendor","cometix-asr"))}catch{}
  for(const dir of dirs){
    if(!dir||!_fs.existsSync(dir))continue;
    let m=tryLoad(_path.join(dir,"index.js"));if(m)return m;
    m=tryLoad(dir);if(m)return m;
    try{for(const f of _fs.readdirSync(dir).filter(x=>x.startsWith("libcometix-asr")&&x.endsWith(".node"))){m=tryLoad(_path.join(dir,f));if(m)return m}}catch{}
  }
  return null;
}
const __asr=__loadCometixAsr();
if(!__asr){try{e.onError("cometix-asr vendor missing startSession",{fatal:true,connectFailureCode:"cometix_asr_missing"})}catch{}return null}
let __handle=null,__connected=false,__finalized=false,__closed=false,__readyFired=false;
let __finalText="",__previewText="",__previewBase="",__livePiece="";
let __previewAcceptedAt=0;
let __emittedFinal=false,__finResolve=null,__finTimer=null;
let __audioChunks=0,__audioBytes=0;
const __traceFile=String(process.env.COMETIX_ASR_TRACE_FILE||"").trim();
const __traceId=String(process.pid)+"-"+String(Date.now())+"-"+Math.random().toString(36).slice(2,8);
const __traceStartedAt=Date.now();
let __traceLastAt=__traceStartedAt,__traceSeq=0,__traceWriteFailed=false;
function __trace(kind,data){
  if(!__traceFile)return;
  const now=Date.now();
  const row={
    schema:1,traceId:__traceId,seq:++__traceSeq,
    at:new Date(now).toISOString(),elapsedMs:now-__traceStartedAt,
    deltaMs:now-__traceLastAt,kind,...(data||{})
  };
  __traceLastAt=now;
  try{
    const line=JSON.stringify(row,(key,value)=>{
      if(typeof value==="string"&&value.length>2000)return value.slice(0,2000)+"…<len="+String(value.length)+">";
      return value;
    });
    _fs.appendFileSync(__traceFile,line+String.fromCharCode(10),"utf8");
  }catch(err){
    if(!__traceWriteFailed){
      __traceWriteFailed=true;
      try{if(typeof v==="function")v("[cometix_asr_trace] write failed: "+String(err))}catch{}
    }
  }
}
function __previewState(){
  return {
    previewText:__previewText,previewBase:__previewBase,livePiece:__livePiece,
    previewAcceptedAt:__previewAcceptedAt,
    finalText:__finalText,emittedFinal:__emittedFinal
  };
}
function __cleanTranscript(text){return String(text||"").trim()}
function __commonPrefixLength(a,b){
  let n=Math.min(a.length,b.length),i=0;
  while(i<n&&a.charCodeAt(i)===b.charCodeAt(i))i++;
  return i;
}
function __sameLiveRewrite(a,b){
  a=__cleanTranscript(a);b=__cleanTranscript(b);
  if(!a||!b||a.startsWith(b)||b.startsWith(a))return true;
  const short=Math.min(a.length,b.length),common=__commonPrefixLength(a,b);
  return common>=Math.min(4,Math.max(1,Math.ceil(short*0.45)));
}
function __isStrictProjection(container,candidate){
  return Boolean(
    container&&candidate&&container!==candidate&&
    (container.startsWith(candidate)||container.endsWith(candidate))
  );
}
function __appendTranscript(base,tail){
  base=__cleanTranscript(base);tail=__cleanTranscript(tail);
  if(!base)return tail;
  if(!tail||base.endsWith(tail))return base;
  if(tail.startsWith(base))return tail;
  for(let n=Math.min(base.length,tail.length);n>0;n--){
    if(base.endsWith(tail.slice(0,n)))return base+tail.slice(n);
  }
  const sep=/[A-Za-z0-9]$/.test(base)&&/^[A-Za-z0-9]/.test(tail)?" ":"";
  return base+sep+tail;
}
function __cumulativePreview(full,piece,stage){
  full=__cleanTranscript(full);piece=__cleanTranscript(piece);
  const before=__previewState(),incoming=full||piece,previous=__previewText;
  const now=Date.now(),projectionAgeMs=__previewAcceptedAt?now-__previewAcceptedAt:null;
  if(!incoming){
    __trace("preview.normalize",{
      stage,decision:"empty",full,piece,projectionAgeMs,
      before,after:__previewState(),output:__previewText
    });
    return __previewText;
  }

  let decision="",next=previous,accepted=false;
  const live=piece||incoming;
  if(!previous){
    decision=stage+".first";
    next=incoming;
    accepted=true;
  }else if(incoming===previous){
    decision=stage+".ignore_duplicate";
    // A duplicate cumulative projection is the anchor for the remaining
    // prefix/suffix entries emitted from the same results[] batch.
    __previewAcceptedAt=now;
  }else if(
    __isStrictProjection(previous,incoming)&&
    projectionAgeMs!==null&&projectionAgeMs<=20
  ){
    // The addon can publish cumulative, stable-prefix and live-suffix entries
    // from one results[] batch within the same tick. Only the cumulative entry
    // is a new Preview; the other two are parallel projections.
    decision=stage+".ignore_parallel_projection";
    if(stage==="stable"&&previous.startsWith(incoming)){
      __previewBase=incoming;
      __livePiece=previous.slice(incoming.length);
    }
  }else if(incoming.startsWith(previous)){
    decision=stage+".accept_extension";
    next=incoming;
    accepted=true;
  }else if(previous.startsWith(incoming)||__sameLiveRewrite(previous,incoming)){
    decision=stage+".accept_whole_rewrite";
    next=incoming;
    accepted=true;
  }else if(__previewBase){
    if(incoming.startsWith(__previewBase)&&incoming.length>__previewBase.length){
      decision=stage+".accept_cumulative_display";
      next=incoming;
    }else if(__livePiece&&__sameLiveRewrite(__livePiece,live)){
      decision=stage+".rewrite_live_piece";
      next=__appendTranscript(__previewBase,live);
    }else{
      decision=stage+".rebuild_from_base";
      next=__appendTranscript(__previewBase,live);
    }
    accepted=true;
  }else{
    // Fallback for providers that really reset to phrase-only interim text.
    decision=stage+".new_phrase_reset";
    __previewBase=previous;
    __livePiece=live;
    next=__appendTranscript(__previewBase,live);
    accepted=true;
  }

  if(accepted){
    __previewText=next;
    __previewAcceptedAt=now;
    if(stage==="stable"){
      __previewBase=next;
      __livePiece="";
    }else if(__previewBase&&next.startsWith(__previewBase)){
      __livePiece=next.slice(__previewBase.length);
    }else{
      __livePiece=live;
    }
  }
  __trace("preview.normalize",{
    stage,decision,full,piece,projectionAgeMs,accepted,
    before,after:__previewState(),output:__previewText
  });
  return __previewText;
}
function __emitFinalOnce(text,source){
  text=__cleanTranscript(text);source=source||"unknown";
  if(!text){
    __trace("final.skip",{source,reason:"empty",state:__previewState()});
    return;
  }
  if(__emittedFinal){
    __trace("final.skip",{source,reason:"already_emitted",text,textLength:text.length,state:__previewState()});
    return;
  }
  __emittedFinal=true;
  __finalText=text;
  __trace("cc.onTranscript",{source,isFinal:true,text,textLength:text.length,state:__previewState()});
  try{e.onTranscript(text,true)}catch(err){__trace("cc.onTranscript.error",{source,isFinal:true,error:String(err)})}
  if(__finResolve){
    const r=__finResolve;__finResolve=null;
    if(__finTimer){clearTimeout(__finTimer);__finTimer=null}
    __trace("bridge.finalize.resolve",{source,result:"session_final",state:__previewState()});
    r("session_final");
  }
}
__trace("bridge.init",{pid:process.pid,traceFile:__traceFile});
const __api={
  send(k){
    if(!__connected||__finalized||__closed||__handle==null)return;
    const size=k&&typeof k.length==="number"?k.length:0;
    __audioChunks++;__audioBytes+=size;
    try{__asr.feedPcm(__handle,Buffer.from(k))}catch(err){
      __trace("audio.feed.error",{error:String(err),chunkBytes:size,audioChunks:__audioChunks,audioBytes:__audioBytes});
    }
  },
  finalize(){
    if(__finalized||__closed){
      __trace("bridge.finalize.skip",{reason:"already_closed",finalized:__finalized,closed:__closed,state:__previewState()});
      return Promise.resolve("ws_already_closed");
    }
    __finalized=true;
    __trace("bridge.finalize.request",{audioChunks:__audioChunks,audioBytes:__audioBytes,state:__previewState()});
    return new Promise((resolve)=>{
      __finResolve=resolve;
      try{__asr.finalizeSession(__handle)}catch(err){__trace("addon.finalize.error",{error:String(err)})}
      // wait SessionFinished/final text; do not resolve early or CC → No speech detected
      __finTimer=setTimeout(()=>{
        __finTimer=null;
        __trace("bridge.finalize.timeout",{hasFinalText:Boolean(__finalText),state:__previewState()});
        if(!__emittedFinal&&__finalText)__emitFinalOnce(__finalText,"finalize_timeout_fallback");
        const r=__finResolve;__finResolve=null;
        if(r){
          const result=__emittedFinal?"session_final":"safety_timeout";
          __trace("bridge.finalize.resolve",{source:"timeout",result,state:__previewState()});
          r(result);
        }
      },12000);
    });
  },
  close(){
    __trace("bridge.close.request",{audioChunks:__audioChunks,audioBytes:__audioBytes,state:__previewState()});
    __closed=true;__connected=false;
    try{if(__handle!=null)__asr.closeSession(__handle)}catch(err){__trace("addon.close.error",{error:String(err)})}
    __handle=null;
    if(__finResolve){
      const r=__finResolve;__finResolve=null;
      if(__finTimer){clearTimeout(__finTimer);__finTimer=null}
      __trace("bridge.finalize.resolve",{source:"api.close",result:"ws_close",state:__previewState()});
      r("ws_close");
    }
    try{e.onClose&&e.onClose()}catch(err){__trace("cc.onClose.error",{error:String(err)})}
  },
  isConnected(){return __connected&&!__closed}
};
function __startLive(){
  // empty → Rust product_config + ensureDid (post-asr default off in product_config for CC)
  __trace("addon.start.request",{});
  __handle=__asr.startSession("{}",(err,j)=>{
    if(err){
      __trace("addon.callback.error",{error:String(err)});
      try{e.onError(String(err))}catch(callbackErr){__trace("cc.onError.error",{error:String(callbackErr)})}
      return;
    }
    let ev;
    try{ev=JSON.parse(j)}catch(parseErr){
      __trace("addon.event.parse_error",{error:String(parseErr),raw:String(j||"")});
      return;
    }
    if(ev.type==="ready"){
      __connected=true;
      __trace("addon.ready",{sessionId:ev.session_id||"",mode:ev.mode||""});
      if(!__readyFired){
        __readyFired=true;
        __trace("cc.onReady",{});
        try{e.onReady(__api)}catch(callbackErr){__trace("cc.onReady.error",{error:String(callbackErr)})}
      }
    }else if(ev.type==="transcript"){
      const display=__cleanTranscript(ev.display),piece=__cleanTranscript(ev.text);
      const full=display||piece;
      const stage=ev.stage||((ev.is_vad_finished||ev.is_final)?"stable":"interim");
      __trace("addon.transcript",{
        rawStage:ev.stage||"",stage,isInterim:Boolean(ev.is_interim),
        isVadFinished:Boolean(ev.is_vad_finished),isFinal:Boolean(ev.is_final),
        text:piece,textLength:piece.length,display,displayLength:display.length,
        passCount:Number(ev.pass_count||0),
        stableText:__cleanTranscript(ev.stable_text),
        liveText:__cleanTranscript(ev.live_text),
        state:__previewState()
      });
      if(!full&&!__previewText){
        __trace("transcript.skip",{reason:"empty",stage,state:__previewState()});
        return;
      }
      if(stage==="session_final"){
        // SessionFinished is authoritative. Commit exactly once so CC does not
        // append the already-previewed stable segments a second time.
        __emitFinalOnce(full||__previewText,"addon.session_final");
      }else{
        // CC replaces voiceInterimTranscript on every isFinal=false callback.
        // Therefore both interim and stable must carry a cumulative Preview.
        const normalizedStage=stage==="stable"?"stable":"interim";
        const previousPreview=__previewText;
        const preview=__cumulativePreview(full,piece,normalizedStage);
        if(!preview){
          __trace("transcript.skip",{reason:"normalized_empty",stage,state:__previewState()});
          return;
        }
        __finalText=preview;
        if(preview===previousPreview){
          __trace("cc.onTranscript.skip",{
            source:"preview."+normalizedStage,reason:"unchanged_projection",
            text:preview,textLength:preview.length,state:__previewState()
          });
          return;
        }
        __trace("cc.onTranscript",{
          source:"preview."+normalizedStage,isFinal:false,text:preview,
          textLength:preview.length,state:__previewState()
        });
        try{e.onTranscript(preview,false)}catch(callbackErr){
          __trace("cc.onTranscript.error",{source:"preview."+normalizedStage,isFinal:false,error:String(callbackErr)});
        }
      }
    }else if(ev.type==="processed"){
      __trace("addon.processed",{text:__cleanTranscript(ev.text),fmtText:__cleanTranscript(ev.fmt_text)});
      // if post ever enabled, prefer single processed final
      __emitFinalOnce(ev.text||ev.fmt_text||"","addon.processed");
    }else if(ev.type==="error"){
      __trace("addon.error",{message:ev.message||"asr error",code:ev.code||""});
      try{e.onError(ev.message||"asr error")}catch(callbackErr){__trace("cc.onError.error",{error:String(callbackErr)})}
    }else if(ev.type==="close"){
      __connected=false;
      __trace("addon.close",{state:__previewState(),audioChunks:__audioChunks,audioBytes:__audioBytes});
      if(__finalText&&!__emittedFinal)__emitFinalOnce(__finalText,"addon.close_fallback");
      if(__finResolve){
        const r=__finResolve;__finResolve=null;
        if(__finTimer){clearTimeout(__finTimer);__finTimer=null}
        const result=__emittedFinal?"session_final":"close";
        __trace("bridge.finalize.resolve",{source:"addon.close",result,state:__previewState()});
        r(result);
      }
      try{e.onClose&&e.onClose()}catch(callbackErr){__trace("cc.onClose.error",{error:String(callbackErr)})}
    }else if(ev.type==="debug"){
      __trace("addon.debug",{message:ev.message||""});
    }else{
      __trace("addon.unknown",{event:ev});
    }
  });
}
try{__startLive()}catch(err){
  __trace("addon.start.error",{error:String(err)});
  try{e.onError(String(err),{fatal:true,connectFailureCode:"cometix_start_failed"})}catch(callbackErr){__trace("cc.onError.error",{error:String(callbackErr)})}
  return null;
}
return __api;
}`;
  const n = fixes.connectVoiceStream.node;
  replacements.push({
    start: n.start,
    end: n.end,
    replacement: sttBody,
    name: 'connectVoiceStream',
  });
}

if (replacements.length === 0) {
  // everything already applied
  console.log('ALREADY_PATCHED');
  process.exit(2);
}

// Apply AST replacements from end → start (preserve positions)
replacements.sort((a, b) => b.start - a.start);
let newCode = code;
for (const r of replacements) {
  newCode = replaceAt(newCode, r.start, r.end, r.replacement);
  if (fixes[r.name]) fixes[r.name].patched = true;
  console.log('PATCH:' + r.name + ' - AST applied');
}

const patchedCount = replacements.length;
const needMarks = [
  'COMETIX_ASR_VOICE_STREAM',
  'COMETIX_VOICE_GATE',
  'COMETIX_VOICE_STREAM_AVAIL',
  'COMETIX_VOICE_AVAIL',
  'COMETIX_VOICE_SETTING',
  'COMETIX_VOICE_AUTH',
  'COMETIX_VOICE_FLAG',
];
for (const m of needMarks) {
  if (!newCode.includes(m)) {
    console.error('VERIFY_FAILED:marker missing: ' + m);
    process.exit(1);
  }
}
if (!newCode.includes('void 0/*COMETIX_VOICE_AVAIL*/')) {
  console.error('VERIFY_FAILED:voice command availability must be undefined');
  process.exit(1);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupPath = cliPath + '.' + backupSuffix + '-' + timestamp;
fs.copyFileSync(cliPath, backupPath);
console.log('BACKUP:' + backupPath);

fs.writeFileSync(cliPath, shebang + newCode);
console.log('SUCCESS:' + patchedCount);
PATCH_EOF

# ============================================================
# Run
# ============================================================
CHECK_ARG=""
if $CHECK_ONLY; then
  CHECK_ARG="--check"
fi

export BACKUP_SUFFIX
OUTPUT=$(node "$PATCH_SCRIPT" "$ACORN_PATH" "$CLI_PATH" "$CHECK_ARG" 2>&1) || true
EXIT_CODE=$?

rm -f "$PATCH_SCRIPT"

while IFS= read -r line; do
  case "$line" in
    ALREADY_PATCHED)
      success "Already patched"
      exit 0
      ;;
    PARSE_ERROR:*)
      error "Failed to parse cli.js: ${line#PARSE_ERROR:}"
      exit 1
      ;;
    NOT_FOUND:*)
      error "Target code not found: ${line#NOT_FOUND:}"
      exit 1
      ;;
    FOUND:*)
      info "Found: ${line#FOUND:}"
      ;;
    PATCH:*)
      info "Patch: ${line#PATCH:}"
      ;;
    NEEDS_PATCH)
      echo ""
      warning "Patch needed — run without --check to apply"
      ;;
    PATCH_COUNT:*)
      info "Need to patch ${line#PATCH_COUNT:} location(s)"
      exit 1
      ;;
    BACKUP:*)
      echo ""
      echo "Backup: ${line#BACKUP:}"
      ;;
    SUCCESS:*)
      echo ""
      success "Fix applied! Patched ${line#SUCCESS:} location(s)"
      echo ""
      info "Vendor: $CLI_DIR/vendor/cometix-asr"
      info "did: managed inside addon → ~/.cache/cometix-asr/did.json"
      echo ""
      warning "Restart Claude Code for changes to take effect"
      ;;
    VERIFY_FAILED:*)
      error "Verification failed: ${line#VERIFY_FAILED:}"
      exit 1
      ;;
    *)
      # pass through other lines
      if [[ -n "$line" ]]; then
        echo "$line"
      fi
      ;;
  esac
done <<< "$OUTPUT"

exit $EXIT_CODE
