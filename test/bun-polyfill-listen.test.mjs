import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildPolyfillModule } from '../scripts/esm-chunk-patch.mjs';

// Load the shim the way a split build ships it, as bun-polyfill.mjs.
test.before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-polyfill-'));
  const path = join(dir, 'bun-polyfill.mjs');
  const source = readFileSync(new URL('../templates/bun-polyfill.js', import.meta.url), 'utf8');
  await writeFile(path, buildPolyfillModule(source));
  await import(pathToFileURL(path).href);
  await rm(dir, { recursive: true, force: true });
});

// The plugin tool MCP server passes port 0 and reads .port straight back to
// build its URL, so the port has to be real by the time serve() returns.
test('Bun.serve on an IP literal is bound when it returns', async (t) => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('ok'),
  });
  t.after(() => server.stop(true));
  const { port } = server;
  assert.ok(port > 0, `expected a bound port, got ${port}`);
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(await res.text(), 'ok');
});

test('Bun.listen on an IP literal is bound when it returns', async (t) => {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: {} });
  t.after(() => server.stop(true));
  const { port } = server;
  assert.ok(port > 0, `expected a bound port, got ${port}`);
  await new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => { sock.end(); resolve(); });
    sock.on('error', reject);
  });
});

test('a hostname still goes through listen()', async (t) => {
  const server = Bun.serve({
    hostname: 'localhost',
    port: 0,
    fetch: () => new Response('ok'),
  });
  t.after(() => server.stop(true));
  // Bound once the lookup settles, as Node's listen() always was.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(server.port > 0);
});
