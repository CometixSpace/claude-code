import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { extractBunSEA } from './bun-sea-extract.mjs';

// Extraction runs in its own process. lief parses a 300MB+ binary into a
// native object graph the JS heap cannot reclaim — after a full extraction
// the JS side drops to 5MB while RSS stays near 1GB — so the only reliable
// way to give it back before the next platform is to exit. Doing it here
// also keeps a native crash from taking the whole build down.
//
// Usage: node extract-worker.mjs <binary> <outDir>
// Prints the extracted module count on success.

const [binaryPath, extractDir] = process.argv.slice(2);
if (!binaryPath || !extractDir) {
  console.error('Usage: node extract-worker.mjs <binary> <outDir>');
  process.exit(1);
}

// Bun's `encoding` field names how it holds the string internally, not how
// the bytes are laid out: text modules tagged "utf8" are stored UTF-16LE,
// while the ones tagged "latin1" are already UTF-8 on the wire. Writing the
// former verbatim yields a file with a NUL after every character — v2.1.246
// ships 76 skill assets that way, half of the total.
function decodeText(mod) {
  return mod.encoding === 'utf8'
    ? Buffer.from(mod.contents.toString('utf16le'), 'utf8')
    : mod.contents;
}

const result = await extractBunSEA(binaryPath);
await mkdir(extractDir, { recursive: true });

let written = 0;
for (let idx = 0; idx < result.modules.length; idx++) {
  const mod = result.modules[idx];
  let name = mod.name;
  if (name.startsWith(result.basePath)) name = name.slice(result.basePath.length);
  if (name.startsWith('root/')) name = name.slice(5);
  // The entry point keeps the loader's extension rather than its own.
  if (idx === result.entryPointId) name = name.replace(/\.[^.]+$/, '') + '.' + mod.loader;

  if (mod.contents?.length > 0) {
    const outPath = join(extractDir, name);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, mod.loader === 'text' ? decodeText(mod) : mod.contents);
    written++;
  }
  // Release each slice as it lands; every one is a view into the same
  // section buffer, which stays alive while any of them is reachable.
  mod.contents = null;
  mod.sourcemap = null;
}

console.log(written);
