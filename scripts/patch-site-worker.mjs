import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { findSites } from './node-compat-patch.mjs';

// Worker half of the parallel site scan (see patch-sites.mjs). Stays alive and
// takes one file per message, so the ~7MB chunks do not each pay worker
// startup and the module graph is parsed once per thread rather than per file.

const { extractDir, sourceType } = workerData;

parentPort.on('message', (rel) => {
  let hits = null;
  try {
    hits = findSites(readFileSync(join(extractDir, rel), 'utf8'), sourceType);
  } catch {
    // Unparseable files cannot hold a patch site; report nothing found.
  }
  parentPort.postMessage({ rel, hits });
});
