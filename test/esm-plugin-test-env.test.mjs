import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';
import { rewritePluginTestEnv } from '../scripts/esm-chunk-patch.mjs';

const execFileAsync = promisify(execFile);
const FLAGS = '--experimental-vm-modules --disable-warning=ExperimentalWarning';

// The spawn as it appears in the chunks, with the helpers stubbed so the
// rewritten module can run: spawn() hands back the options it was given.
const STUBS = 'const spawn=(cmd,argv,opts)=>opts;'
  + 'const pick=(e)=>({PATH:e.PATH,CLAUDE_CODE_ENABLE_FUNCTION_HOOKS:"1"});'
  + 'const host=()=>({PATH:"/bin",SECRET:"x"});const extra=()=>({TERM:"dumb"});';
const site = (env) => STUBS
  + 'export function run(e,n){let r={cmd:"node",prefixArgs:["cli.js"]};'
  + `return spawn(r.cmd,[...r.prefixArgs,"plugin","test","--file",n,e],{cwd:e,env:${env},extendEnv:!1,stdin:"ignore"})}`;

async function load(code) {
  return import(`data:text/javascript,${encodeURIComponent(code)}`);
}

test('wraps a call-built environment (2.1.285)', async () => {
  const { code, rewritten } = rewritePluginTestEnv(site('pick(host())'));
  assert.equal(rewritten, 1);
  const { run } = await load(code);
  assert.deepEqual(run('/root', 'a.test.ts').env, {
    PATH: '/bin', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', NODE_OPTIONS: FLAGS,
  });
});

test('wraps an object-of-spreads environment (2.1.303)', async () => {
  const { code, rewritten } = rewritePluginTestEnv(site('{...pick(host()),...extra()}'));
  assert.equal(rewritten, 1);
  const { run } = await load(code);
  assert.deepEqual(run('/root', 'a.test.ts').env, {
    PATH: '/bin', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', TERM: 'dumb', NODE_OPTIONS: FLAGS,
  });
});

test('keeps a shorthand env property valid', async () => {
  const code = STUBS + 'export function run(env){'
    + 'return spawn("node",["plugin","test","--file","a","b"],{env})}';
  const out = rewritePluginTestEnv(code);
  assert.equal(out.rewritten, 1);
  const { run } = await load(out.code);
  assert.deepEqual(run({ A: '1' }).env, { A: '1', NODE_OPTIONS: FLAGS });
});

test('leaves an environment that already sets NODE_OPTIONS to upstream', () => {
  const code = site('{...pick(host()),NODE_OPTIONS:"--x"}');
  assert.deepEqual(rewritePluginTestEnv(code), { code, rewritten: 0 });
});

test('leaves other plugin subcommands alone', () => {
  const code = STUBS + 'spawn("node",["plugin","list","--json"],{env:host()});'
    + 'const usage=["plugin","test","--file"];';
  assert.equal(rewritePluginTestEnv(code).rewritten, 0);
});

test('the flags give a child SourceTextModule with nothing on stderr', async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    '-e', 'const vm=require("vm");new vm.SourceTextModule("export default 1");'
      + 'process.stdout.write(typeof vm.SourceTextModule)',
  ], { env: { PATH: process.env.PATH, NODE_OPTIONS: FLAGS } });
  assert.equal(stdout, 'function');
  assert.equal(stderr, '');
});
