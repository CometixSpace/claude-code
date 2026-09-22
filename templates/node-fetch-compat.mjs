// node-fetch, backed by the global fetch.
//
// Bun resolves `node-fetch` to a built-in; Node has no such package, so the
// import throws ERR_MODULE_NOT_FOUND. The one importer is gaxios — Google
// Auth's HTTP layer — which picks its fetch implementation like this:
//
//   return this.#o ||= (typeof window < "u" && !!window)
//     ? window.fetch
//     : (await import("node-fetch")).default;
//
// There is no catch around it, so on Node every Vertex AI request dies before
// it is sent.
//
// Forwarding to the global fetch rather than depending on the real node-fetch
// is what matches Bun, and gaxios reads as WHATWG code throughout: it sets
// `duplex: "half"` (undici's requirement, meaningless to node-fetch), and
// branches on `err instanceof DOMException` for aborts. Bun's built-in and the
// global fetch both raise DOMException there; node-fetch@3 raises its own
// AbortError, which fails that check — the real package would take gaxios
// down a path it does not take under Bun.
//
// The one thing node-fetch@3 has that this does not is the `agent` option.
// Bun's built-in ignores it too (verified), so nothing regresses relative to
// the runtime being replaced. Translating it to an undici dispatcher would
// make gaxios honour HTTPS_PROXY where Bun does not, but that is an
// enhancement rather than a compatibility fix, and belongs in its own change.

import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

// Bound through globalThis rather than re-exported directly: `export { fetch }`
// only names module-local bindings, not globals.
export const fetch = globalThis.fetch;
export default fetch;

// Re-exported so `new Headers()` and friends resolve to the same classes the
// global fetch produces — gaxios does `e instanceof Headers ? e : new Headers(e)`
// when merging, and two parallel class hierarchies would silently take the
// copying branch on every call.
export const Headers = globalThis.Headers;
export const Request = globalThis.Request;
export const Response = globalThis.Response;
export const FormData = globalThis.FormData;
export const Blob = globalThis.Blob;
export const File = globalThis.File;

// node-fetch's error hierarchy. Nothing in the bundle constructs these, but
// `instanceof` checks against them are cheap to keep working, and a module
// missing an export it is documented to have fails at link time, not at use.
export class FetchBaseError extends Error {
  constructor(message, type) {
    super(message);
    this.type = type;
    this.name = this.constructor.name;
  }
}

export class FetchError extends FetchBaseError {
  constructor(message, type, systemError) {
    super(message, type);
    if (systemError) {
      this.code = this.errno = systemError.code;
      this.erroredSysCall = systemError.syscall;
    }
  }
}

// Aborts surface as DOMException here, as they do under the global fetch and
// under Bun. This class exists for `instanceof` sites; it is never thrown.
export class AbortError extends FetchBaseError {
  constructor(message, type = 'aborted') {
    super(message, type);
  }
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
export const isRedirect = (code) => REDIRECT_STATUS.has(code);

export async function blobFrom(path, type) {
  const { size } = await stat(path);
  return new Blob([await streamToBuffer(createReadStream(path))], { type, size });
}

export function blobFromSync(path, type) {
  return new Blob([readFileSync(path)], { type });
}

export async function fileFrom(path, type) {
  return new File([await streamToBuffer(createReadStream(path))], basename(path), { type });
}

export function fileFromSync(path, type) {
  return new File([readFileSync(path)], basename(path), { type });
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
