import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import * as acorn from 'acorn';
import {
  buildPolyfillModule,
  pruneRedundantBareImports,
  rewriteNoopSlowOpUsing,
  rewriteParallelReplImports,
  rewriteSystemCaCertCache,
  rewriteUdsSweep,
  rewriteWindowsProcessCreationTime,
  rewriteWindowsWhere,
} from '../scripts/esm-chunk-patch.mjs';
import { astPatch } from '../scripts/node-compat-patch.mjs';

test.before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-startup-polyfill-'));
  const path = join(dir, 'bun-polyfill.mjs');
  const source = await readFile(new URL('../templates/bun-polyfill.js', import.meta.url), 'utf8');
  await writeFile(path, buildPolyfillModule(source));
  await import(pathToFileURL(path).href);
  await rm(dir, { recursive: true, force: true });
});

test('polyfill sets CLAUDE_CODE_LAZY_ENV_GETTERS default to 1', () => {
  assert.equal(process.env.CLAUDE_CODE_LAZY_ENV_GETTERS, '1');
});

test('Bun.which and __ccFindExecutableCandidates resolve executables without spawning', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-which-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const binA = join(dir, 'bin-a');
  const binB = join(dir, 'bin-b');
  await mkdir(binA, { recursive: true });
  await mkdir(binB, { recursive: true });

  // Windows mode test (cross-platform via opts.platform = 'win32')
  const winToolA = join(binA, 'mytool.cmd');
  const winToolB = join(binB, 'mytool.exe');
  await writeFile(winToolA, '@echo off\r\n');
  await writeFile(winToolB, 'MZ');

  const winCandidates = globalThis.__ccFindExecutableCandidates('mytool', {
    platform: 'win32',
    PATH: `"${binA}";${binB}`,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    cwd: dir,
  });
  assert.deepEqual(winCandidates, [winToolA, winToolB]);

  // With includeCwd + firstOnly, keeps the cwd match (so $Br knows cwd had a shadow)
  // and stops right after the first non-cwd PATH match (skipping binB).
  const cwdShadow = join(dir, 'mytool.exe');
  await writeFile(cwdShadow, 'MZ');
  const firstNonCwd = globalThis.__ccFindExecutableCandidates('mytool', {
    platform: 'win32',
    PATH: `"${binA}";${binB}`,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    cwd: dir,
    includeCwd: true,
    firstOnly: true,
  });
  assert.deepEqual(firstNonCwd, [cwdShadow, winToolA]);

  // Empty lookup with throwOnEmpty sets status=1 (matching where.exe miss)
  assert.throws(
    () => globalThis.__ccFindExecutableCandidates('nonexistent-tool-xyz', {
      platform: 'win32',
      PATH: binA,
      throwOnEmpty: true,
    }),
    (err) => err && err.status === 1,
  );

  if (process.platform !== 'win32') {
    const posixTool = join(binA, 'my-posix-tool');
    await writeFile(posixTool, '#!/bin/sh\necho ok\n');
    await chmod(posixTool, 0o755);

    const found = Bun.which('my-posix-tool', { PATH: `${binA}${delimiter}${binB}`, cwd: dir });
    assert.equal(found, posixTool);
    assert.equal(Bun.which('missing-posix-tool', { PATH: binA, cwd: dir }), null);
  }
});

test('rewriteWindowsWhere replaces where.exe execFileSync while preserving cwd exclusion and extension filter', () => {
  const sample = [
    'function $Br(e,t=!1){',
    'let c=rQn("SYSTEMROOT")||"C:\\\\Windows",d=m(c,"System32","where.exe");',
    'try{let i=p(d,[e],{stdio:"pipe",encoding:"utf8",timeout:h,windowsHide:!0,env:process.env}).trim().split(/\\r?\\n/).filter(Boolean),a=process.cwd(),l=!1;',
    'for(let r of i){if(u(r))continue;if(pQn(r,a)){l=!0;continue}if(!b(r))continue;return n.remember(e,r),r}',
    'if(i.length>0&&!l)n.remember(e,null);return null}catch(s){if(v(s))n.remember(e,null);return null}}',
  ].join('');
  const { code, rewritten } = rewriteWindowsWhere(sample);
  assert.equal(rewritten, 1);
  assert.ok(code.includes('globalThis.__ccFindExecutableCandidates(e,{includeCwd:!0,firstOnly:!0,throwOnEmpty:!0})'));
  assert.ok(code.includes('if(pQn(r,a)){l=!0;continue}'));
  assert.doesNotThrow(() => acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' }));
});

test('rewriteWindowsProcessCreationTime rewrites WMI CreationDate to Get-Process StartTime and adds 1ms tolerance', async () => {
  const sample = [
    'function YWe(e){try{if(u())return KUt(e)?.toString();return smn(`powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\\\"ProcessId=${e}\\\\").CreationDate.Ticks"`,{timeout:1000})?.trim()||void 0}catch{return}}',
    'function GEe(e,t){if(t===e)return!0;let n=Number(e),r=Number(t);return Number.isFinite(n)&&Number.isFinite(r)&&n>300000000000000000!==r>300000000000000000}',
    'async function S(e,t){let n=t===void 0?{}:{env:t,extendEnv:!1};try{let o="powershell.exe";let s=await ct(o,["-NoProfile","-Command",`(Get-CimInstance Win32_Process -Filter "ProcessId=${e}").CreationDate.Ticks`],{timeout:1e4,...n});return s.stdout?.trim()}catch{return}}',
    'async function mQe(e){let r=await ct("powershell.exe",["-NoProfile","-Command",`[DateTimeOffset]::new((Get-CimInstance Win32_Process -Filter "ProcessId=${e}").CreationDate).ToUnixTimeMilliseconds()`],{timeout:1000});return r}',
    'export{YWe,GEe,S};',
  ].join('');
  const { code, rewritten } = rewriteWindowsProcessCreationTime(sample);
  assert.equal(rewritten, 6);
  assert.ok(!code.includes('CreationDate'));
  assert.ok(code.includes('(Get-Process -Id ${e}).StartTime.Ticks'));
  assert.ok(code.includes('Math.abs(n-r)<1e4'));
  assert.doesNotThrow(() => acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' }));

  const mod = await import(`data:text/javascript,${encodeURIComponent(code)}`);
  // WMI truncates last digit to 0 (e.g. 638982123456789000 vs 638982123456789007)
  assert.equal(mod.GEe('638982123456789000', '638982123456789007'), true);
  // Different processes separated by > 1ms (e.g. 50,000 ticks = 5ms) must not match
  assert.equal(mod.GEe('638982123456700000', '638982123456750000'), false);
});

test('rewriteUdsSweep defers stale .tmp sweep off the critical startup path', () => {
  const sample = 'async function o2s(e,n,r,{sweepPermitted:i}){let c=Qte();await pe(c,{recursive:!0,mode:448}),await Ee(c,i);return c}';
  const { code, rewritten } = rewriteUdsSweep(sample);
  assert.equal(rewritten, 1);
  assert.ok(code.includes('setTimeout(()=>{Ee(c,i).catch(()=>{})},2e3).unref?.()'));
  assert.doesNotThrow(() => acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' }));
});

test('rewriteParallelReplImports converts sequential AppRoot/REPL imports and wires interactive preload', () => {
  const sampleRepl = 'async function h5s(d,a,r,s){let{AppRoot:i}=await import("./chunk-pxd59j4h.js"),{REPL:n}=await import("./chunk-z2sjg6vz.js");return[i,n]}';
  const outRepl = rewriteParallelReplImports(sampleRepl);
  assert.equal(outRepl.rewritten, 2);
  assert.ok(outRepl.code.includes('globalThis.__ccPreloadRepl??='));
  assert.ok(outRepl.code.includes('let[{AppRoot:i},{REPL:n}]=await(globalThis.__ccPreloadRepl?globalThis.__ccPreloadRepl():Promise.all([import("./chunk-pxd59j4h.js"),import("./chunk-z2sjg6vz.js")]));'));
  assert.doesNotThrow(() => acorn.parse(outRepl.code, { ecmaVersion: 'latest', sourceType: 'module' }));

  const sampleSetup = 'async function kYr(){if(!we()){let h=req();h.startPreviewBrowserDiscovery()}yo("action_before_setup");let{setup:_d}=await import("./chunk-g6swey1c.js");return _d}';
  const outSetup = rewriteParallelReplImports(sampleSetup);
  assert.equal(outSetup.rewritten, 2);
  assert.ok(outSetup.code.includes('(globalThis.__ccIsInteractive=!0,h.startPreviewBrowserDiscovery())'));
  assert.ok(outSetup.code.includes('(globalThis.__ccIsInteractive&&globalThis.__ccPreloadRepl?.(),await import("./chunk-g6swey1c.js"))'));
  assert.doesNotThrow(() => acorn.parse(outSetup.code, { ecmaVersion: 'latest', sourceType: 'module' }));

  const sampleOnboarding = 'async function Zi(){let{createRoot:ko}=await import("./chunk-c71b3689.js");t("showSetupScreens");return ko}';
  const outOnboarding = rewriteParallelReplImports(sampleOnboarding);
  assert.equal(outOnboarding.rewritten, 1);
  assert.ok(outOnboarding.code.includes('(globalThis.__ccPreloadRepl?.(),await import("./chunk-c71b3689.js"))'));
  assert.doesNotThrow(() => acorn.parse(outOnboarding.code, { ecmaVersion: 'latest', sourceType: 'module' }));
});

test('rewriteNoopSlowOpUsing strips no-op tagged template using declarations', () => {
  const sample = 'function _(e,n,r){using i=Wh`JSON.stringify(${Ae(e)})`;return JSON.stringify(e,n,r)}';
  const { code, rewritten } = rewriteNoopSlowOpUsing(sample);
  assert.equal(rewritten, 1);
  assert.equal(code, 'function _(e,n,r){return JSON.stringify(e,n,r)}');
  assert.doesNotThrow(() => acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' }));
});

test('rewriteSystemCaCertCache uses __ccGetCertValidTo cache and preserves expired cert filtering', async () => {
  const sample = [
    'export function Ln(e,Ue){',
    'let{X509Certificate:n}=Ue("crypto"),r=Date.now(),o=0,s=e.filter((i)=>{try{let c=new n(i),u=new Date(c.validTo).getTime();if(Number.isNaN(u)||u>r)return!0;return o++,!1}catch{return!0}});',
    'return{s,o}}',
  ].join('');
  const { code, rewritten } = rewriteSystemCaCertCache(sample);
  assert.equal(rewritten, 1);
  assert.ok(code.includes('globalThis.__ccGetCertValidTo(i,n)'));
  assert.doesNotThrow(() => acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' }));

  const mod = await import(`data:text/javascript,${encodeURIComponent(code)}`);
  let ctorCalls = 0;
  class FakeX509 {
    constructor(pem) {
      ctorCalls++;
      this.validTo = pem.includes('EXPIRED') ? '2020-01-01T00:00:00Z' : '2099-01-01T00:00:00Z';
    }
  }
  const nonce = `${Date.now()}_${Math.random()}`;
  const certs = [
    `-----BEGIN CERTIFICATE-----\nVALID_TEST_CERT_${nonce}\n-----END CERTIFICATE-----`,
    `-----BEGIN CERTIFICATE-----\nEXPIRED_TEST_CERT_${nonce}\n-----END CERTIFICATE-----`,
  ];
  const first = mod.Ln(certs, () => ({ X509Certificate: FakeX509 }));
  assert.equal(first.s.length, 1);
  assert.equal(first.o, 1);
  assert.equal(ctorCalls, 2);

  // Second invocation hits the cache without constructing FakeX509 again
  const second = mod.Ln(certs, () => ({ X509Certificate: FakeX509 }));
  assert.equal(second.s.length, 1);
  assert.equal(second.o, 1);
  assert.equal(ctorCalls, 2);
});

test('pruneRedundantBareImports removes transitive and empty-chunk bare imports while preserving exact DFS post-order', () => {
  const fileMap = new Map([
    ['./chunk-empty.js', '// @bun @bytecode\n// comment only\n'],
    ['./chunk-leaf.js', 'export const x = 1;\n'],
    ['./chunk-mid.js', 'import { x } from "./chunk-leaf.js";\nexport const y = x + 1;\n'],
    ['./chunk-top.js', 'import "./chunk-empty.js";\nimport { y } from "./chunk-mid.js";\nimport "./chunk-leaf.js";\nimport "./chunk-leaf.js";\nexport { y };\n'],
  ]);
  const { prunedImports, touchedFiles } = pruneRedundantBareImports(fileMap);
  assert.equal(prunedImports, 3);
  assert.equal(touchedFiles, 1);
  assert.equal(fileMap.get('./chunk-top.js'), 'import { y } from "./chunk-mid.js";\nexport { y };\n');
});

test('P5 and P8 use Bun.which when available', () => {
  const p5Src = 'function DP(){if(!isEnvTruthy("true"))return!1;return process.env.CLAUDE_CODE_ENTRYPOINT}';
  const p5Out = astPatch(p5Src, 'module');
  assert.equal(p5Out.stats.p5, true);
  assert.ok(p5Out.code.includes('globalThis.Bun.which("bfs")'));

  const p8Src = 'function AF_(e,t){let M="/path/claude";return["ARGV0=bfs","_cc_bin","command"]}';
  const p8Out = astPatch(p8Src, 'module');
  assert.equal(p8Out.stats.p8, true);
  assert.ok(p8Out.code.includes('globalThis.Bun.which(t)'));
});
