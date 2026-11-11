// Checks the built addon against the OS before any package takes it.
// Runs on Windows x64: node native/check.cjs
//
// The bundle publishes windowsProcessCreationTime's value in its session key
// and compares it with what other sessions publish, so it has to be the
// exact FILETIME, as a BigInt — not a near value, and not a Number, which
// the call sites' BigInt arithmetic would throw on. PowerShell derives
// StartTime from the same OS call, and ToFileTimeUtc() turns it back into
// the FILETIME without loss.
const { execFileSync } = require('child_process');
const { join } = require('path');

const addon = require(join(__dirname, 'dist', `cometix-native.win32-${process.arch}.node`));
const created = addon.windowsProcessCreationTime;
if (typeof created !== 'function') {
  console.error('windowsProcessCreationTime is not exported');
  process.exit(1);
}

const viaPowerShell = (pid) => BigInt(execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`]).toString().trim());

let failed = false;
for (const pid of [process.pid, process.ppid]) {
  const got = created(pid);
  const want = viaPowerShell(pid);
  console.log(`pid ${pid}: addon ${got} (${typeof got}), powershell ${want}`);
  if (typeof got !== 'bigint' || got !== want) failed = true;
}
for (const pid of [0, 4294967295]) {
  const got = created(pid);
  console.log(`pid ${pid}: addon ${got}`);
  if (got !== null) failed = true;
}
if (failed) {
  console.error('cometix-native disagrees with the OS');
  process.exit(1);
}
console.log('cometix-native agrees with the OS');
