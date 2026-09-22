// Bun API polyfill for Node.js runtime
// Injected at the top of cli.js when Bun is not available
// Provides compatible implementations of Bun-specific APIs used by Claude Code 2.1.200+

if (typeof globalThis.Bun === "undefined") {
  const crypto = require("crypto");
  const cp = require("child_process");
  const fs = require("fs");
  const net = require("net");
  const http = require("http");
  const https = require("https");
  const { Readable } = require("stream");
  const util = require("util");

  const BUN_FILE = Symbol.for("bun.polyfill.file");

  // ──────────────────────────────────────────────
  // Bun.zstdDecompress / zstdDecompressSync
  //
  // Since 2.1.251 the embedded text assets ship zstd-framed — 101 of them on
  // darwin — and the loader sniffs the magic rather than the file extension,
  // so this is on the path for skill prompts and the artifact runtimes alike.
  // Node's zstd is callback-style and lands in 22.15; Bun's async form
  // resolves a promise, hence the wrapper.
  // ──────────────────────────────────────────────
  const zlib = require("zlib");

  function zstdDecompressSync(data) {
    if (typeof zlib.zstdDecompressSync !== "function") {
      throw new Error("zstd requires Node.js >= 22.15");
    }
    return zlib.zstdDecompressSync(data);
  }

  function zstdDecompress(data) {
    return new Promise((resolve, reject) => {
      if (typeof zlib.zstdDecompress !== "function") {
        reject(new Error("zstd requires Node.js >= 22.15"));
        return;
      }
      zlib.zstdDecompress(data, (err, out) => (err ? reject(err) : resolve(out)));
    });
  }

  // ──────────────────────────────────────────────
  // Bun.TOML — reads ~/.codex/config.toml when importing Codex settings
  //
  // Parsing has to match TOML 1.0.0 rather than approximate it: the result
  // becomes the user's imported mcpServers, hooks and permission mode, and a
  // misparse there is silent. smol-toml is the spec-complete implementation;
  // if it is missing, say so instead of returning a half-parsed object.
  // ──────────────────────────────────────────────
  function tomlParse(text) {
    let parser;
    try {
      parser = require("smol-toml");
    } catch {
      throw new Error("Bun.TOML.parse requires the 'smol-toml' package");
    }
    return parser.parse(text);
  }

  // ──────────────────────────────────────────────
  // Bun.file — used as stdio target (bg-pty-host breadcrumb)
  // ──────────────────────────────────────────────
  function bunFile(path, opts = {}) {
    const p = typeof path === "string" ? path : String(path ?? "");
    return {
      [BUN_FILE]: true,
      path: p,
      name: p,
      // Node child_process accepts path strings for stdio file targets
      toString: () => p,
      valueOf: () => p,
      // Minimal Blob-like surface if something probes it
      size: 0,
      type: opts.type || "",
      async text() {
        return fs.promises.readFile(p, "utf8");
      },
      async arrayBuffer() {
        const buf = await fs.promises.readFile(p);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
      stream() {
        return fs.createReadStream(p);
      },
    };
  }

  function isBunFile(v) {
    return !!(v && typeof v === "object" && v[BUN_FILE]);
  }

  // Node child_process does NOT accept filesystem path strings for async
  // spawn stdio (only pipe/ignore/inherit/stream/fd). Bun.file(path) must be
  // opened to an fd, matching pre-2.1.200 openSync(...err) behavior.
  function normalizeStdioEntry(entry, openedFds) {
    if (entry == null) return "ignore";
    if (isBunFile(entry)) {
      const fd = fs.openSync(entry.path, "w");
      openedFds.push(fd);
      return fd;
    }
    if (typeof entry === "object" && typeof entry.fd === "number") return entry.fd;
    return entry;
  }

  function buildNodeStdio(opts = {}, openedFds) {
    if (Array.isArray(opts.stdio)) {
      return opts.stdio.map((e) => normalizeStdioEntry(e, openedFds));
    }
    // Bun allows top-level stdin/stdout/stderr (including Bun.file)
    const stdin = opts.stdin !== undefined ? opts.stdin : "ignore";
    const stdout = opts.stdout === "pipe" ? "pipe"
      : (opts.stdout !== undefined ? opts.stdout : "inherit");
    const stderr = opts.stderr === "ignore" ? "ignore"
      : (opts.stderr === "pipe" ? "pipe"
        : (opts.stderr !== undefined ? opts.stderr : "inherit"));
    return [
      normalizeStdioEntry(stdin, openedFds),
      normalizeStdioEntry(stdout, openedFds),
      normalizeStdioEntry(stderr, openedFds),
    ];
  }

  // ──────────────────────────────────────────────
  // Bun.spawn polyfill
  // Returns an object mimicking Bun.Subprocess interface:
  //   .pid, .unref(), .kill(), .exited (Promise<number>), .stdout.text()
  // ──────────────────────────────────────────────
  function bunSpawn(args, opts = {}) {
    const cmd = args[0];
    const spawnArgs = args.slice(1);

    // PTY mode: when opts.terminal is a BunTerminalPolyfill instance,
    // delegate to node-pty via the terminal's _bind method
    if (opts.terminal && typeof opts.terminal._bind === "function") {
      const terminal = opts.terminal;
      const ptyProc = terminal._bind(cmd, spawnArgs, {
        cwd: opts.cwd, env: opts.env,
      });
      const result = {
        pid: ptyProc.pid,
        unref: () => {},
        kill: (sig) => { try { ptyProc.kill(sig); } catch {} },
        ref: () => {},
        stdin: {
          write: (d) => ptyProc.write(typeof d === "string" ? d : d.toString()),
          destroyed: false,
        },
        stdout: null, stderr: null,
        exited: null, exitCode: null, signalCode: null,
      };
      result.exited = new Promise((resolve) => {
        ptyProc.onExit(({ exitCode, signal }) => {
          result.exitCode = exitCode ?? null;
          result.signalCode = signal > 0 ? signal : null;
          resolve(exitCode ?? 1);
        });
      });
      return result;
    }

    const openedFds = [];
    let child;
    try {
      const nodeOpts = {
        cwd: opts.cwd,
        env: opts.env,
        stdio: buildNodeStdio(opts, openedFds),
        detached: opts.detached || false,
        windowsHide: opts.windowsHide ?? true,
      };

      if (opts.argv0) {
        nodeOpts.argv0 = opts.argv0;
      }

      child = cp.spawn(cmd, spawnArgs, nodeOpts);
    } finally {
      // Parent can close its copies; the child inherits dup'd fds.
      for (const fd of openedFds) {
        try { fs.closeSync(fd); } catch {}
      }
    }

    // Build stdout with .text() method (mimics Bun ReadableStream)
    let stdout = null;
    if (child.stdout) {
      const chunks = [];
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      stdout = {
        text: () => new Promise((resolve) => {
          child.stdout.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        }),
        [Symbol.asyncIterator]: async function* () {
          for await (const chunk of child.stdout) yield chunk;
        },
      };
    }

    const result = {
      pid: child.pid,
      unref: () => child.unref(),
      kill: (sig) => child.kill(sig),
      ref: () => child.ref(),
      stdin: child.stdin,
      stdout,
      stderr: child.stderr,
      exited: null,
      exitCode: null,
      signalCode: null,
    };
    result.exited = new Promise((resolve) => {
      child.on("close", (code, signal) => {
        result.exitCode = code ?? null;
        result.signalCode = signal ?? null;
        resolve(code ?? 1);
      });
      child.on("error", () => resolve(1));
    });
    return result;
  }

  // ──────────────────────────────────────────────
  // Bun.hash
  // ──────────────────────────────────────────────
  function bunHash(data, seed) {
    const str = typeof data === "string" ? data : String(data);
    const h = crypto.createHash("sha256").update(str);
    if (seed !== undefined) h.update(String(seed));
    const buf = h.digest();
    return Number(buf.readBigUInt64LE(0) & 0xFFFFFFFFn);
  }
  // Bun.hash.xxHash64 — callers format it as a fixed-width 64-bit hex digest
  // (`.toString(16).padStart(16,"0")`), so this has to return a BigInt rather
  // than the 32-bit Number bunHash() yields. Only stability matters here: it
  // keys a local cache, and nothing compares it against a real xxHash.
  bunHash.xxHash64 = function xxHash64(data, seed) {
    const str = typeof data === "string" ? data : String(data);
    const h = crypto.createHash("sha256").update(str);
    if (seed !== undefined) h.update(String(seed));
    return h.digest().readBigUInt64LE(0);
  };
  bunHash.toString = () => "function hash() { [native code] }";

  // Load Anthropic-compatible ink implementations (bundled from source)
  let _inkCompat = null;
  try { _inkCompat = require("./bun-ink-compat.cjs"); } catch {}

  const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

  // ──────────────────────────────────────────────
  // Bun.deepEquals
  // ──────────────────────────────────────────────
  function deepEquals(a, b) {
    if (a === b) return true;
    try {
      return util.isDeepStrictEqual(a, b);
    } catch {
      return false;
    }
  }

  // ──────────────────────────────────────────────
  // Bun socket wrapper — shared by Bun.listen and Bun.connect
  //
  // Bun hands its handlers a socket object rather than emitting events, so
  // wrap the Node socket to match. Used on both sides: the two APIs differ
  // only in who opens the connection.
  // ──────────────────────────────────────────────
  function wrapSocket(sock) {
    return {
      data: undefined,
      write(data) {
        const buf = typeof data === "string" ? Buffer.from(data, "utf8")
          : Buffer.isBuffer(data) ? data
          : Buffer.from(data);
        if (sock.destroyed) return 0;
        // Node already buffers when write() returns false; always report full
        // acceptance to avoid caller-side double-buffer + re-write on drain.
        sock.write(buf);
        return buf.length;
      },
      end() {
        try { sock.end(); } catch {}
      },
      terminate() {
        try { sock.destroy(); } catch {}
      },
      get readyState() {
        if (sock.destroyed) return 3;
        if (sock.connecting) return 0;
        return 1;
      },
      get remoteAddress() { return sock.remoteAddress; },
      get remotePort() { return sock.remotePort; },
      get localAddress() { return sock.localAddress; },
      get localPort() { return sock.localPort; },
    };
  }

  function attachSocketHandlers(sock, wrapper, handlers) {
    sock.on("data", (chunk) => {
      try { handlers.data?.(wrapper, chunk); } catch {}
    });
    sock.on("drain", () => {
      try { handlers.drain?.(wrapper); } catch {}
    });
    sock.on("close", () => {
      try { handlers.close?.(wrapper); } catch {}
    });
    sock.on("error", (err) => {
      try { handlers.error?.(wrapper, err); } catch {}
    });
  }

  // ──────────────────────────────────────────────
  // Bun.connect — TCP client, resolves once connected
  //
  // The agent proxy dials upstream with this when the sandbox lets a host
  // through, and reads socket.remoteAddress to reject blocked ranges — that
  // call site has no guard, so an absent Bun.connect throws mid-relay.
  // ──────────────────────────────────────────────
  function bunConnect(opts = {}) {
    return new Promise((resolve, reject) => {
      const handlers = opts.socket || {};
      const sock = net.connect({
        host: opts.hostname || opts.host || "127.0.0.1",
        port: opts.port,
      });
      const wrapper = wrapSocket(sock);
      let settled = false;

      sock.once("connect", () => {
        settled = true;
        // Bun invokes open() before handing the socket back to the caller.
        try { handlers.open?.(wrapper); } catch {}
        resolve(wrapper);
      });
      // Only a pre-connect failure rejects; later errors go to the handler,
      // which attachSocketHandlers wires up below.
      sock.once("error", (err) => {
        if (!settled) { settled = true; reject(err); }
      });

      attachSocketHandlers(sock, wrapper, handlers);
    });
  }

  // ──────────────────────────────────────────────
  // Bun.listen — TCP server with Bun-like socket handlers
  // ──────────────────────────────────────────────
  function bunListen(opts = {}) {
    const handlers = opts.socket || {};
    const server = net.createServer((sock) => {
      const wrapper = wrapSocket(sock);
      try { handlers.open?.(wrapper); } catch {}
      attachSocketHandlers(sock, wrapper, handlers);
    });

    const host = opts.hostname || opts.host || "127.0.0.1";
    const port = opts.port ?? 0;
    // Track bound address; Bun.listen returns a usable port synchronously.
    let bound = { address: host, port };
    server.listen(port, host);
    try {
      const addr = server.address();
      if (addr && typeof addr === "object") bound = addr;
    } catch {}
    server.on("listening", () => {
      try {
        const addr = server.address();
        if (addr && typeof addr === "object") bound = addr;
      } catch {}
    });

    const api = {
      get port() {
        const addr = server.address();
        if (addr && typeof addr === "object") return addr.port;
        return bound.port;
      },
      get hostname() {
        const addr = server.address();
        if (addr && typeof addr === "object") return addr.address;
        return bound.address;
      },
      stop(closeActive) {
        if (closeActive) {
          try { server.closeAllConnections?.(); } catch {}
        }
        try { server.close(); } catch {}
      },
      ref() { try { server.ref(); } catch {} },
      unref() { try { server.unref(); } catch {} },
    };
    return api;
  }

  // ──────────────────────────────────────────────
  // Bun.serve — HTTP(S) server with fetch handler
  // ──────────────────────────────────────────────
  function bunServe(opts = {}) {
    const host = opts.hostname || opts.host || "0.0.0.0";
    const port = opts.port ?? 3000;
    const fetchHandler = opts.fetch;
    const errorHandler = opts.error;

    async function nodeReqToFetchRequest(req) {
      const hostHeader = req.headers.host || `${host}:${port}`;
      const proto = opts.tls ? "https" : "http";
      const url = `${proto}://${hostHeader}${req.url || "/"}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v == null) continue;
        if (Array.isArray(v)) v.forEach((item) => headers.append(k, item));
        else headers.set(k, v);
      }
      const method = req.method || "GET";
      let body = null;
      if (method !== "GET" && method !== "HEAD") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = Buffer.concat(chunks);
      }
      return new Request(url, { method, headers, body });
    }

    async function writeFetchResponse(res, response) {
      if (!response) {
        res.statusCode = 500;
        res.end("internal error");
        return;
      }
      res.statusCode = response.status || 200;
      response.headers?.forEach?.((value, key) => {
        // set-cookie must not be joined
        if (String(key).toLowerCase() === "set-cookie") {
          const prev = res.getHeader("set-cookie");
          if (!prev) res.setHeader("set-cookie", value);
          else res.setHeader("set-cookie", [].concat(prev, value));
        } else {
          res.setHeader(key, value);
        }
      });
      if (response.body) {
        const buf = Buffer.from(await response.arrayBuffer());
        res.end(buf);
      } else {
        res.end();
      }
    }

    const handler = async (req, res) => {
      try {
        const request = await nodeReqToFetchRequest(req);
        const serverShim = {
          requestIP(requestObj) {
            const addr = req.socket?.remoteAddress;
            return addr ? { address: addr, family: req.socket.remoteFamily, port: req.socket.remotePort } : null;
          },
        };
        let response = await fetchHandler(request, serverShim);
        await writeFetchResponse(res, response);
      } catch (err) {
        try {
          if (errorHandler) {
            const response = await errorHandler(err);
            await writeFetchResponse(res, response);
            return;
          }
        } catch {}
        res.statusCode = 500;
        res.end("internal server error");
      }
    };

    let server;
    if (opts.tls) {
      server = https.createServer(opts.tls, handler);
    } else {
      server = http.createServer(handler);
    }
    server.listen(port, host);

    return {
      get port() {
        const addr = server.address();
        return typeof addr === "object" && addr ? addr.port : port;
      },
      get hostname() {
        const addr = server.address();
        return typeof addr === "object" && addr ? addr.address : host;
      },
      stop(closeActive) {
        if (closeActive) {
          try { server.closeAllConnections?.(); } catch {}
        }
        try { server.close(); } catch {}
      },
      ref() { try { server.ref(); } catch {} },
      unref() { try { server.unref(); } catch {} },
    };
  }

  // ──────────────────────────────────────────────
  // Bun.SQL — not implemented; clear error (gateway expects native)
  // ──────────────────────────────────────────────
  class BunSQLPolyfill {
    constructor() {
      throw new Error("claude gateway requires the native binary");
    }
  }

  // Bun.JSONL.parseChunk is intentionally null.
  // The business code (pYe → r0m) checks `Bun.JSONL?.parseChunk` and falls
  // back to a pure-JS line-by-line JSON.parse loop (i0m/o0m) when it's null.
  // A polyfill that returns { values, error } without `.read` / `.done` causes
  // the n0m consumer to infinite-loop because `read` is undefined.

  // ──────────────────────────────────────────────
  // Bun.stdin
  // ──────────────────────────────────────────────
  const bunStdin = {
    stream() {
      return Readable.toWeb ? Readable.toWeb(process.stdin) : process.stdin;
    },
    async text() {
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      return Buffer.concat(chunks).toString("utf8");
    },
  };

  // ──────────────────────────────────────────────
  // Bun.WebView — guarded no-op surface
  // ──────────────────────────────────────────────
  const BunWebView = {
    closeAll() { return true; },
  };

  // ──────────────────────────────────────────────
  // Bun.ant.CellSegmenter — JS renderer fallback
  // Ported from the pre-native Ink ANSI/grapheme, bidi-js and screen code.
  // Adapt its results to the paired Int32 buffers consumed by native Ink.
  // ──────────────────────────────────────────────
  // The old renderer sanitizes terminal sequences before parsing SGR/OSC 8.
  // Keep its scanner, including incomplete sequences and C0 cancellation.
  function normalizeCellAnsi(text) {
    if (!/\x1b(?!\[[0-9;]*m|\]8;;[^\x07\x18\x1a\x1b]*\x07)|\x9b/.test(text)) return text;
    const WK = { ESC: 27, DEL: 127, BS: 8, BEL: 7, CAN: 24, SUB: 26 };
    const Zj = { CSI: 91, OSC: 93, DCS: 80, APC: 95, PM: 94, SOS: 88, ST: 92 };
    const b = (c) => c >= 32 && c <= 47;
    const E = (c) => c >= 48 && c <= 126;
    const R = (c) => c >= 64 && c <= 126;
    const I = (c) => c >= 48 && c <= 63;
    const L = /^\[M[\x60-\x7f][\x20-\uffff]?$/;
    const U = /^(?:\[(?:\d{1,2}(?:;\d{1,2})?[~^$@]|(?:1;\d{1,2})?[A-DFHa-d])|O[A-DFHa-d])/;
    function D(e, t, r, n, s, o, u) {
      let m = [],
        f = {
          state: t,
          buffer: ""
        },
        c = r + e,
        i = 0,
        d = 0,
        l = 0,
        p = () => {
          if (i > d) {
            let a = c.slice(d, i);
            if (a) m.push({
              type: "text",
              value: a
            })
          }
          d = i
        },
        g = (a) => {
          if (a) m.push({
            type: "sequence",
            value: a
          });
          f.state = "ground", d = i
        };
      while (i < c.length) {
        let a = c.charCodeAt(i);
        switch (f.state) {
          case "ground":
            if (a === WK.ESC) p(), l = i, f.state = "escape", i++;
            else if (a === WK.DEL)
              if (L.test(c.slice(d, i))) i++;
              else p(), i++, m.push({
                type: "text",
                value: "\x7F"
              }), d = i;
            else if (!o && a < 32 && (c.length < 64 || a === WK.BS)) {
              if (p(), i++, a === 13 && c.charCodeAt(i) === 10) i++;
              m.push({
                type: "text",
                value: String.fromCharCode(a)
              }), d = i
            } else i++;
            break;
          case "escape":
            if (a === Zj.CSI) f.state = "csi", i++;
            else if (a === Zj.OSC) f.state = "osc", i++;
            else if (a === Zj.DCS) f.state = "dcs", i++;
            else if (!s && a === Zj.APC) f.state = "apc", i++;
            else if (!s && a === Zj.PM) f.state = "pm", i++;
            else if (!s && (a === Zj.SOS || a === 107)) f.state = "sos", i++;
            else if (a === 79) f.state = "ss3", i++;
            else if (s && (a === 32 || a === 13 || a === 10 || a === 9)) i++, m.push({
              type: "text",
              value: c.slice(l, i)
            }), f.state = "ground", d = i;
            else if (s && b(a)) m.push({
              type: "text",
              value: c.slice(l, i)
            }), f.state = "ground", d = i;
            else if (b(a)) f.state = "escapeIntermediate", i++;
            else if (a === WK.DEL) i++, m.push({
              type: "text",
              value: c.slice(l, i)
            }), f.state = "ground", d = i;
            else if (E(a)) i++, g(c.slice(l, i));
            else if (a === WK.ESC && u && i === l + 1 && U.test(c.slice(i + 1, i + 1 + 8))) i++;
            else if (a === WK.ESC) g(c.slice(l, i)), l = i, f.state = "escape", i++;
            else if (a < 32) i++, m.push({
              type: "text",
              value: c.slice(l, i)
            }), f.state = "ground", d = i;
            else f.state = "ground", d = l;
            break;
          case "escapeIntermediate":
            if (b(a)) i++;
            else if (E(a)) i++, g(c.slice(l, i));
            else f.state = "ground", d = l;
            break;
          case "csi":
            if (s && a === 77 && i - l === 2 && (i + 1 >= c.length || c.charCodeAt(i + 1) >= 32) && (i + 2 >= c.length || c.charCodeAt(i + 2) >= 32) && (i + 3 >= c.length || c.charCodeAt(i + 3) >= 32)) {
              if (i + 4 <= c.length) i += 4, g(c.slice(l, i));
              else i = c.length;
              break
            }
            if (R(a)) i++, g(c.slice(l, i));
            else if (I(a) || b(a)) i++;
            else f.state = "ground", d = l;
            break;
          case "ss3":
            if (a >= 64 && a <= 126) i++, g(c.slice(l, i));
            else f.state = "ground", d = l;
            break;
          case "osc":
          case "dcs":
          case "apc":
          case "pm":
          case "sos":
            if (a === WK.BEL && f.state !== "pm" && f.state !== "sos") i++, g(c.slice(l, i));
            else if (a === WK.ESC && i + 1 < c.length)
              if (c.charCodeAt(i + 1) === Zj.ST) i += 2, g(c.slice(l, i));
              else g(c.slice(l, i)), l = i, f.state = "escape", i++;
            else if (a === WK.CAN || a === WK.SUB) i++, g(c.slice(l, i));
            else i++;
            break
        }
      }
      if (f.state === "ground") p();
      else if (n) {
        let a = c.slice(l);
        if (a) m.push({
          type: "sequence",
          value: a
        });
        f.state = "ground"
      } else f.buffer = c.slice(l);
      return {
        tokens: m,
        state: f
      }
    }
    let result = "";
    // One complete string is equivalent to the old feed(text) + flush().
    for (const token of D(text, "ground", "", true, false, false, false).tokens) {
      if (token.type === "text") {
        result += token.value.replace(/[\x1b\x9b]/g, "\x18");
        continue;
      }
      const code = token.value;
      if (/^\x1b\[[0-9;]*m$/.test(code)) result += code;
      else if (code.startsWith("\x1b]8;") && (code.endsWith("\x07") || code.endsWith("\x1b\\"))) {
        const payload = code.slice(4, code.endsWith("\x1b\\") ? -2 : -1);
        result += `\x1b]8;;${payload.slice(payload.indexOf(";") + 1)}\x07`;
      }
    }
    return result;
  }

  const cellSgrEnds = new Map([
    [0, 0], [1, 22], [2, 22], [3, 23], [4, 24], [53, 55], [7, 27], [8, 28], [9, 29],
    ...Array.from({ length: 8 }, (_, i) => [30 + i, 39]),
    ...Array.from({ length: 8 }, (_, i) => [90 + i, 39]),
    ...Array.from({ length: 8 }, (_, i) => [40 + i, 49]),
    ...Array.from({ length: 8 }, (_, i) => [100 + i, 49]),
  ]);
  const cellSgrCloses = new Set([...cellSgrEnds.values()].map((n) => `\x1b[${n}m`));

  function cellAnsiEnd(code) {
    if (cellSgrCloses.has(code)) return code;
    if (code.startsWith("\x1b]8;;")) return "\x1b]8;;\x07";
    const params = code.slice(2);
    if (params.startsWith("38")) return "\x1b[39m";
    if (params.startsWith("48")) return "\x1b[49m";
    return `\x1b[${cellSgrEnds.get(parseInt(params, 10)) ?? 0}m`;
  }

  function sameCellStyles(a, b) {
    let i = 0, j = 0;
    for (;;) {
      while (i < a.length && a[i].code === a[i].endCode) i++;
      while (j < b.length && b[j].code === b[j].endCode) j++;
      if (i === a.length || j === b.length) return i === a.length && j === b.length;
      if (a[i++].code !== b[j++].code) return false;
    }
  }

  // Port of the old sanitize -> tokenize -> style-run grouping pipeline.
  // Merge equal styles BEFORE grapheme segmentation (combining marks / ZWJ).
  function cellTextRuns(text) {
    text = normalizeCellAnsi(text);
    const runs = [];
    let styles = [], pendingStyles = [], pending = "";
    for (let i = 0; i < text.length;) {
      const rest = text.slice(i);
      const ansi = /^(?:\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07)/.exec(rest)?.[0];
      if (ansi) {
        let codes = [ansi];
        if (ansi.startsWith("\x1b[") && ansi.includes(";")) {
          const params = ansi.slice(2, -1).split(";");
          codes = [];
          for (let j = 0; j < params.length; j++) {
            let count = 1;
            if (params[j] === "38" || params[j] === "48") {
              if (j + 2 < params.length && params[j + 1] === "5") count = 3;
              else if (j + 4 < params.length && params[j + 1] === "2") count = 5;
            }
            codes.push(`\x1b[${params.slice(j, j + count).join(";")}m`);
            j += count - 1;
          }
        }
        for (const code of codes) {
          const endCode = cellAnsiEnd(code);
          if (code === "\x1b[0m") styles = [];
          else if (cellSgrCloses.has(code)) styles = styles.filter((s) => s.endCode !== code);
          else if (code === "\x1b[1m" || code === "\x1b[2m") {
            if (!styles.some((s) => s.code === code && s.endCode === endCode)) styles = [...styles, { code, endCode }];
          } else styles = [...styles.filter((s) => s.endCode !== endCode), { code, endCode }];
        }
        i += ansi.length;
        continue;
      }
      if (pending && !sameCellStyles(styles, pendingStyles)) {
        runs.push({ text: pending, styles: pendingStyles });
        pending = "";
      }
      const char = String.fromCodePoint(text.codePointAt(i));
      pending += char;
      pendingStyles = styles;
      i += char.length;
    }
    if (pending) runs.push({ text: pending, styles: pendingStyles });
    return runs;
  }

  // Upstream bidi-js embedding-level implementation and Unicode tables.
  // Retain the algorithm/data; unused mirroring/reordering APIs are omitted.
  function createCellBidi() {
    var n = (function(s) {
      var c = { R: "13k,1a,2,3,3,2+1j,ch+16,a+1,5+2,2+n,5,a,4,6+16,4+3,h+1b,4mo,179q,2+9,2+11,2i9+7y,2+68,4,3+4,5+13,4+3,2+4k,3+29,8+cf,1t+7z,w+17,3+3m,1t+3z,16o1+5r,8+30,8+mc,29+1r,29+4v,75+73", EN: "1c+9,3d+1,6,187+9,513,4+5,7+9,sf+j,175h+9,qw+q,161f+1d,4xt+a,25i+9", ES: "17,2,6dp+1,f+1,av,16vr,mx+1,4o,2", ET: "z+2,3h+3,b+1,ym,3e+1,2o,p4+1,8,6u,7c,g6,1wc,1n9+4,30+1b,2n,6d,qhx+1,h0m,a+1,49+2,63+1,4+1,6bb+3,12jj", AN: "16o+5,2j+9,2+1,35,ed,1ff2+9,87+u", CS: "18,2+1,b,2u,12k,55v,l,17v0,2,3,53,2+1,b", B: "a,3,f+2,2v,690", S: "9,2,k", WS: "c,k,4f4,1vk+a,u,1j,335", ON: "x+1,4+4,h+5,r+5,r+3,z,5+3,2+1,2+1,5,2+2,3+4,o,w,ci+1,8+d,3+d,6+8,2+g,39+1,9,6+1,2,33,b8,3+1,3c+1,7+1,5r,b,7h+3,sa+5,2,3i+6,jg+3,ur+9,2v,ij+1,9g+9,7+a,8m,4+1,49+x,14u,2+2,c+2,e+2,e+2,e+1,i+n,e+e,2+p,u+2,e+2,36+1,2+3,2+1,b,2+2,6+5,2,2,2,h+1,5+4,6+3,3+f,16+2,5+3l,3+81,1y+p,2+40,q+a,m+13,2r+ch,2+9e,75+hf,3+v,2+2w,6e+5,f+6,75+2a,1a+p,2+2g,d+5x,r+b,6+3,4+o,g,6+1,6+2,2k+1,4,2j,5h+z,1m+1,1e+f,t+2,1f+e,d+3,4o+3,2s+1,w,535+1r,h3l+1i,93+2,2s,b+1,3l+x,2v,4g+3,21+3,kz+1,g5v+1,5a,j+9,n+v,2,3,2+8,2+1,3+2,2,3,46+1,4+4,h+5,r+5,r+a,3h+2,4+6,b+4,78,1r+24,4+c,4,1hb,ey+6,103+j,16j+c,1ux+7,5+g,fsh,jdq+1t,4,57+2e,p1,1m,1m,1m,1m,4kt+1,7j+17,5+2r,d+e,3+e,2+e,2+10,m+4,w,1n+5,1q,4z+5,4b+rb,9+c,4+c,4+37,d+2g,8+b,l+b,5+1j,9+9,7+13,9+t,3+1,27+3c,2+29,2+3q,d+d,3+4,4+2,6+6,a+o,8+6,a+2,e+6,16+42,2+1i", BN: "0+8,6+d,2s+5,2+p,e,4m9,1kt+2,2b+5,5+5,17q9+v,7k,6p+8,6+1,119d+3,440+7,96s+1,1ekf+1,1ekf+1,1ekf+1,1ekf+1,1ekf+1,1ekf+1,1ekf+1,1ekf+1,1ekf+1,1ekf+1,1ekf+1,1ekf+75,6p+2rz,1ben+1,1ekf+1,1ekf+1", NSM: "lc+33,7o+6,7c+18,2,2+1,2+1,2,21+a,1d+k,h,2u+6,3+5,3+1,2+3,10,v+q,2k+a,1n+8,a,p+3,2+8,2+2,2+4,18+2,3c+e,2+v,1k,2,5+7,5,4+6,b+1,u,1n,5+3,9,l+1,r,3+1,1m,5+1,5+1,3+2,4,v+1,4,c+1,1m,5+4,2+1,5,l+1,n+5,2,1n,3,2+3,9,8+1,c+1,v,1q,d,1f,4,1m+2,6+2,2+3,8+1,c+1,u,1n,g+1,l+1,t+1,1m+1,5+3,9,l+1,u,21,8+2,2,2j,3+6,d+7,2r,3+8,c+5,23+1,s,2,2,1k+d,2+4,2+1,6+a,2+z,a,2v+3,2+5,2+1,3+1,q+1,5+2,h+3,e,3+1,7,g,jk+2,qb+2,u+2,u+1,v+1,1t+1,2+6,9,3+a,a,1a+2,3c+1,z,3b+2,5+1,a,7+2,64+1,3,1n,2+6,2,2,3+7,7+9,3,1d+g,1s+3,1d,2+4,2,6,15+8,d+1,x+3,3+1,2+2,1l,2+1,4,2+2,1n+7,3+1,49+2,2+c,2+6,5,7,4+1,5j+1l,2+4,k1+w,2db+2,3y,2p+v,ff+3,30+1,n9x+3,2+9,x+1,29+1,7l,4,5,q+1,6,48+1,r+h,e,13+7,q+a,1b+2,1d,3+3,3+1,14,1w+5,3+1,3+1,d,9,1c,1g,2+2,3+1,6+1,2,17+1,9,6n,3,5,fn5,ki+f,h+f,r2,6b,46+4,1af+2,2+1,6+3,15+2,5,4m+1,fy+3,as+1,4a+a,4x,1j+e,1l+2,1e+3,3+1,1y+2,11+4,2+7,1r,d+1,1h+8,b+3,3,2o+2,3,2+1,7,4h,4+7,m+1,1m+1,4,12+6,4+4,5g+7,3+2,2,o,2d+5,2,5+1,2+1,6n+3,7+1,2+1,s+1,2e+7,3,2+1,2z,2,3+5,2,2u+2,3+3,2+4,78+8,2+1,75+1,2,5,41+3,3+1,5,x+5,3+1,15+5,3+3,9,a+5,3+2,1b+c,2+1,bb+6,2+5,2d+l,3+6,2+1,2+1,3f+5,4,2+1,2+6,2,21+1,4,2,9o+1,f0c+4,1o+6,t5,1s+3,2a,f5l+1,43t+2,i+7,3+6,v+3,45+2,1j0+1i,5+1d,9,f,n+4,2+e,11t+6,2+g,3+6,2+1,2+4,7a+6,c6+3,15t+6,32+6,gzhy+6n", AL: "16w,3,2,e+1b,z+2,2+2s,g+1,8+1,b+m,2+t,s+2i,c+e,4h+f,1d+1e,1bwe+dp,3+3z,x+c,2+1,35+3y,2rm+z,5+7,b+5,dt+l,c+u,17nl+27,1t+27,4x+6n,3+d", LRO: "6ct", RLO: "6cu", LRE: "6cq", RLE: "6cr", PDF: "6cs", LRI: "6ee", RLI: "6ef", FSI: "6eg", PDI: "6eh" }, f = {};
      f.L = 1, Object.keys(c).forEach(function(Ee, We) {
        f[Ee] = 1 << We + 1;
      }), Object.freeze(f);
      var p = f.LRI | f.RLI | f.FSI, b = f.L | f.R | f.AL, E = f.B | f.S | f.WS | f.ON | f.FSI | f.LRI | f.RLI | f.PDI, x = f.BN | f.RLE | f.LRE | f.RLO | f.LRO | f.PDF, C = f.S | f.WS | f.B | p | f.PDI | x, R = null;
      function _() {
        if (!R) {
          R = /* @__PURE__ */ new Map();
          var Ee = function(ze) {
            if (c.hasOwnProperty(ze)) {
              var he = 0;
              c[ze].split(",").forEach(function(Me) {
                var Ce = Me.split("+"), Ae = Ce[0], Te = Ce[1];
                Ae = parseInt(Ae, 36), Te = Te ? parseInt(Te, 36) : 0, R.set(he += Ae, f[ze]);
                for (var Xe = 0; Xe < Te; Xe++) R.set(++he, f[ze]);
              });
            }
          };
          for (var We in c) Ee(We);
        }
      }
      function A(Ee) {
        return _(), R.get(Ee.codePointAt(0)) || f.L;
      }
      var D = { pairs: "14>1,1e>2,u>2,2wt>1,1>1,1ge>1,1wp>1,1j>1,f>1,hm>1,1>1,u>1,u6>1,1>1,+5,28>1,w>1,1>1,+3,b8>1,1>1,+3,1>3,-1>-1,3>1,1>1,+2,1s>1,1>1,x>1,th>1,1>1,+2,db>1,1>1,+3,3>1,1>1,+2,14qm>1,1>1,+1,4q>1,1e>2,u>2,2>1,+1", canonical: "6f1>-6dx,6dy>-6dx,6ec>-6ed,6ee>-6ed,6ww>2jj,-2ji>2jj,14r4>-1e7l,1e7m>-1e7l,1e7m>-1e5c,1e5d>-1e5b,1e5c>-14qx,14qy>-14qx,14vn>-1ecg,1ech>-1ecg,1edu>-1ecg,1eci>-1ecg,1eda>-1ecg,1eci>-1ecg,1eci>-168q,168r>-168q,168s>-14ye,14yf>-14ye" };
      function L(Ee, We) {
        var ze = 36, he = 0, Me = /* @__PURE__ */ new Map(), Ce = We && /* @__PURE__ */ new Map(), Ae;
        return Ee.split(",").forEach(function Te(Xe) {
          if (Xe.indexOf("+") !== -1) for (var lt = +Xe; lt--; ) Te(Ae);
          else {
            Ae = Xe;
            var we = Xe.split(">"), ot = we[0], Bt = we[1];
            ot = String.fromCodePoint(he += parseInt(ot, ze)), Bt = String.fromCodePoint(he += parseInt(Bt, ze)), Me.set(ot, Bt), We && Ce.set(Bt, ot);
          }
        }), { map: Me, reverseMap: Ce };
      }
      var U, K, G;
      function X() {
        if (!U) {
          var Ee = L(D.pairs, !0), { map: We, reverseMap: ze } = Ee;
          U = We, K = ze, G = L(D.canonical, !1).map;
        }
      }
      function P(Ee) {
        return X(), U.get(Ee) || null;
      }
      function Y(Ee) {
        return X(), K.get(Ee) || null;
      }
      function J(Ee) {
        return X(), G.get(Ee) || null;
      }
      var { L: Z, R: ie, EN: q, ES: re, ET: ne, AN: le, CS: se, B: ae, S: ye, ON: de, BN: fe, NSM: ve, AL: Se, LRO: He, RLO: Ge, LRE: it, RLE: vt, PDF: bt, LRI: Rt, RLI: qt, FSI: Gt, PDI: ct } = f;
      function jn(Ee, We) {
        for (var ze = 125, he = new Uint32Array(Ee.length), Me = 0; Me < Ee.length; Me++) he[Me] = A(Ee[Me]);
        var Ce = /* @__PURE__ */ new Map();
        function Ae(cn, Ln) {
          var Qt = he[cn];
          he[cn] = Ln, Ce.set(Qt, Ce.get(Qt) - 1), Qt & E && Ce.set(E, Ce.get(E) - 1), Ce.set(Ln, (Ce.get(Ln) || 0) + 1), Ln & E && Ce.set(E, (Ce.get(E) || 0) + 1);
        }
        for (var Te = new Uint8Array(Ee.length), Xe = /* @__PURE__ */ new Map(), lt = [], we = null, ot = 0; ot < Ee.length; ot++)
          we || lt.push(we = { start: ot, end: Ee.length - 1, level: We === "rtl" ? 1 : We === "ltr" ? 0 : na(ot, !1) }), he[ot] & ae && (we.end = ot, we = null);
        for (var Bt = vt | it | Ge | He | p | ct | bt | ae, ke = function(cn) {
          return cn + (cn & 1 ? 1 : 2);
        }, mt = function(cn) {
          return cn + (cn & 1 ? 2 : 1);
        }, qe = 0; qe < lt.length; qe++) {
          we = lt[qe];
          var Pe = [{ _level: we.level, _override: 0, _isolate: 0 }], Fe = void 0, Tt = 0, yn = 0, ui = 0;
          Ce.clear();
          for (var Ot = we.start; Ot <= we.end; Ot++) {
            var St = he[Ot];
            if (Fe = Pe[Pe.length - 1], Ce.set(St, (Ce.get(St) || 0) + 1), St & E && Ce.set(E, (Ce.get(E) || 0) + 1), St & Bt)
              if (St & (vt | it)) {
                Te[Ot] = Fe._level;
                var ci = (St === vt ? mt : ke)(Fe._level);
                ci <= ze && !Tt && !yn ? Pe.push({ _level: ci, _override: 0, _isolate: 0 }) : Tt || yn++;
              } else if (St & (Ge | He)) {
                Te[Ot] = Fe._level;
                var fi = (St === Ge ? mt : ke)(Fe._level);
                fi <= ze && !Tt && !yn ? Pe.push({ _level: fi, _override: St & Ge ? ie : Z, _isolate: 0 }) : Tt || yn++;
              } else if (St & p) {
                St & Gt && (St = na(Ot + 1, !0) === 1 ? qt : Rt), Te[Ot] = Fe._level, Fe._override && Ae(Ot, Fe._override);
                var Sn = (St === qt ? mt : ke)(Fe._level);
                Sn <= ze && Tt === 0 && yn === 0 ? (ui++, Pe.push({ _level: Sn, _override: 0, _isolate: 1, _isolInitIndex: Ot })) : Tt++;
              } else if (St & ct) {
                if (Tt > 0) Tt--;
                else if (ui > 0) {
                  for (yn = 0; !Pe[Pe.length - 1]._isolate; ) Pe.pop();
                  var Ki = Pe[Pe.length - 1]._isolInitIndex;
                  Ki != null && (Xe.set(Ki, Ot), Xe.set(Ot, Ki)), Pe.pop(), ui--;
                }
                Fe = Pe[Pe.length - 1], Te[Ot] = Fe._level, Fe._override && Ae(Ot, Fe._override);
              } else St & bt ? (Tt === 0 && (yn > 0 ? yn-- : !Fe._isolate && Pe.length > 1 && (Pe.pop(), Fe = Pe[Pe.length - 1])), Te[Ot] = Fe._level) : St & ae && (Te[Ot] = we.level);
            else Te[Ot] = Fe._level, Fe._override && St !== fe && Ae(Ot, Fe._override);
          }
          for (var di = [], Qe = null, Et = we.start; Et <= we.end; Et++) {
            var Yt = he[Et];
            if (!(Yt & x)) {
              var Wn = Te[Et], hi = Yt & p, ji = Yt === ct;
              Qe && Wn === Qe._level ? (Qe._end = Et, Qe._endsWithIsolInit = hi) : di.push(Qe = { _start: Et, _end: Et, _level: Wn, _startsWithPDI: ji, _endsWithIsolInit: hi });
            }
          }
          for (var Xn = [], On = 0; On < di.length; On++) {
            var wn = di[On];
            if (!wn._startsWithPDI || wn._startsWithPDI && !Xe.has(wn._start)) {
              for (var qn = [Qe = wn], Hn = void 0; Qe && Qe._endsWithIsolInit && (Hn = Xe.get(Qe._end)) != null; ) for (var pi = On + 1; pi < di.length; pi++) if (di[pi]._start === Hn) {
                qn.push(Qe = di[pi]);
                break;
              }
              for (var Kt = [], yi = 0; yi < qn.length; yi++)
                for (var vn = qn[yi], rn = vn._start; rn <= vn._end; rn++) Kt.push(rn);
              for (var En = Te[Kt[0]], vi = we.level, yl = Kt[0] - 1; yl >= 0; yl--) if (!(he[yl] & x)) {
                vi = Te[yl];
                break;
              }
              var Vi = Kt[Kt.length - 1], Jl = Te[Vi], Yr = we.level;
              if (!(he[Vi] & p)) {
                for (var $l = Vi + 1; $l <= we.end; $l++) if (!(he[$l] & x)) {
                  Yr = Te[$l];
                  break;
                }
              }
              Xn.push({ _seqIndices: Kt, _sosType: Math.max(vi, En) % 2 ? ie : Z, _eosType: Math.max(Yr, Jl) % 2 ? ie : Z });
            }
          }
          for (var Uo = 0; Uo < Xn.length; Uo++) {
            var eo = Xn[Uo], { _seqIndices: Ne, _sosType: xn, _eosType: Kr } = eo, Wi = Te[Ne[0]] & 1 ? ie : Z;
            if (Ce.get(ve)) for (var Bn = 0; Bn < Ne.length; Bn++) {
              var sn = Ne[Bn];
              if (he[sn] & ve) {
                for (var vl = xn, ft = Bn - 1; ft >= 0; ft--) if (!(he[Ne[ft]] & x)) {
                  vl = he[Ne[ft]];
                  break;
                }
                Ae(sn, vl & (p | ct) ? de : vl);
              }
            }
            if (Ce.get(q)) for (var bl = 0; bl < Ne.length; bl++) {
              var Po = Ne[bl];
              if (he[Po] & q) for (var to = bl - 1; to >= -1; to--) {
                var jr = to === -1 ? xn : he[Ne[to]];
                if (jr & b) {
                  jr === Se && Ae(Po, le);
                  break;
                }
              }
            }
            if (Ce.get(Se)) for (var Wr = 0; Wr < Ne.length; Wr++) {
              var Fo = Ne[Wr];
              he[Fo] & Se && Ae(Fo, ie);
            }
            if (Ce.get(re) || Ce.get(se)) for (var Xi = 1; Xi < Ne.length - 1; Xi++) {
              var no = Ne[Xi];
              if (he[no] & (re | se)) {
                for (var Nt = 0, pt = 0, gl = Xi - 1; gl >= 0 && (Nt = he[Ne[gl]], !!(Nt & x)); gl--) ;
                for (var qi = Xi + 1; qi < Ne.length && (pt = he[Ne[qi]], !!(pt & x)); qi++) ;
                Nt === pt && (he[no] === re ? Nt === q : Nt & (q | le)) && Ae(no, Nt);
              }
            }
            if (Ce.get(q)) for (var bn = 0; bn < Ne.length; bn++) {
              var Xr = Ne[bn];
              if (he[Xr] & q) {
                for (var Cn = bn - 1; Cn >= 0 && he[Ne[Cn]] & (ne | x); Cn--) Ae(Ne[Cn], q);
                for (bn++; bn < Ne.length && he[Ne[bn]] & (ne | x | q); bn++) he[Ne[bn]] !== q && Ae(Ne[bn], q);
              }
            }
            if (Ce.get(ne) || Ce.get(re) || Ce.get(se)) for (var Di = 0; Di < Ne.length; Di++) {
              var ko = Ne[Di];
              if (he[ko] & (ne | re | se)) {
                Ae(ko, de);
                for (var Sl = Di - 1; Sl >= 0 && he[Ne[Sl]] & x; Sl--) Ae(Ne[Sl], de);
                for (var io = Di + 1; io < Ne.length && he[Ne[io]] & x; io++) Ae(Ne[io], de);
              }
            }
            if (Ce.get(q)) for (var Go = 0, qr = xn; Go < Ne.length; Go++) {
              var Qr = Ne[Go], Yo = he[Qr];
              Yo & q ? qr === Z && Ae(Qr, Z) : Yo & b && (qr = Yo);
            }
            if (Ce.get(E)) {
              var El = ie | q | le, Ko = El | Z, lo = [];
              {
                for (var xl = [], Qi = 0; Qi < Ne.length; Qi++) if (he[Ne[Qi]] & E) {
                  var Cl = Ee[Ne[Qi]], Ir = void 0;
                  if (P(Cl) !== null) if (xl.length < 63) xl.push({ char: Cl, seqIndex: Qi });
                  else break;
                  else if ((Ir = Y(Cl)) !== null) for (var Ii = xl.length - 1; Ii >= 0; Ii--) {
                    var jo = xl[Ii].char;
                    if (jo === Ir || jo === Y(J(Cl)) || P(J(jo)) === Cl) {
                      lo.push([xl[Ii].seqIndex, Qi]), xl.length = Ii;
                      break;
                    }
                  }
                }
                lo.sort(function(cn, Ln) {
                  return cn[0] - Ln[0];
                });
              }
              for (var Vo = 0; Vo < lo.length; Vo++) {
                for (var Zr = lo[Vo], oo = Zr[0], Wo = Zr[1], as = !1, Mn = 0, Oi = oo + 1; Oi < Wo; Oi++) {
                  var Jr = Ne[Oi];
                  if (he[Jr] & Ko) {
                    as = !0;
                    var ro = he[Jr] & El ? ie : Z;
                    if (ro === Wi) {
                      Mn = ro;
                      break;
                    }
                  }
                }
                if (as && !Mn) {
                  Mn = xn;
                  for (var Ml = oo - 1; Ml >= 0; Ml--) {
                    var $r = Ne[Ml];
                    if (he[$r] & Ko) {
                      var Xo = he[$r] & El ? ie : Z;
                      Xo !== Wi ? Mn = Xo : Mn = Wi;
                      break;
                    }
                  }
                }
                if (Mn) {
                  if (he[Ne[oo]] = he[Ne[Wo]] = Mn, Mn !== Wi) {
                    for (var ao = oo + 1; ao < Ne.length; ao++) if (!(he[Ne[ao]] & x)) {
                      A(Ee[Ne[ao]]) & ve && (he[Ne[ao]] = Mn);
                      break;
                    }
                  }
                  if (Mn !== Wi) {
                    for (var Rl = Wo + 1; Rl < Ne.length; Rl++) if (!(he[Ne[Rl]] & x)) {
                      A(Ee[Ne[Rl]]) & ve && (he[Ne[Rl]] = Mn);
                      break;
                    }
                  }
                }
              }
              for (var bi = 0; bi < Ne.length; bi++) if (he[Ne[bi]] & E) {
                for (var ea = bi, qo = bi, Qo = xn, Zi = bi - 1; Zi >= 0; Zi--) if (he[Ne[Zi]] & x) ea = Zi;
                else {
                  Qo = he[Ne[Zi]] & El ? ie : Z;
                  break;
                }
                for (var ta = Kr, Tl = bi + 1; Tl < Ne.length; Tl++) if (he[Ne[Tl]] & (E | x)) qo = Tl;
                else {
                  ta = he[Ne[Tl]] & El ? ie : Z;
                  break;
                }
                for (var so = ea; so <= qo; so++) he[Ne[so]] = Qo === ta ? Qo : Wi;
                bi = qo;
              }
            }
          }
          for (var un = we.start; un <= we.end; un++) {
            var ss = Te[un], uo = he[un];
            if (ss & 1 ? uo & (Z | q | le) && Te[un]++ : uo & ie ? Te[un]++ : uo & (le | q) && (Te[un] += 2), uo & x && (Te[un] = un === 0 ? we.level : Te[un - 1]), un === we.end || A(Ee[un]) & (ye | ae)) for (var Nl = un; Nl >= 0 && A(Ee[Nl]) & C; Nl--) Te[Nl] = we.level;
          }
        }
        return { levels: Te, paragraphs: lt };
        function na(cn, Ln) {
          for (var Qt = cn; Qt < Ee.length; Qt++) {
            var Rn = he[Qt];
            if (Rn & (ie | Se)) return 1;
            if (Rn & (ae | Z) || Ln && Rn === ct) return 0;
            if (Rn & p) {
              var Io = us(Qt);
              Qt = Io === -1 ? Ee.length : Io;
            }
          }
          return 0;
        }
        function us(cn) {
          for (var Ln = 1, Qt = cn + 1; Qt < Ee.length; Qt++) {
            var Rn = he[Qt];
            if (Rn & ae) break;
            if (Rn & ct) {
              if (--Ln === 0) return Qt;
            } else Rn & p && Ln++;
          }
          return -1;
        }
      }
      return jn;
    })({});
    return n;
  }

  let cellGraphemeSegmenter;
  let cellBidiLevels;
  const cellRtl = /[\u0590-\u05ff\ufb1d-\ufb4f\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff\u0780-\u07bf\u0700-\u074f]/u;

  class CellSegmenter {
    graphemes = [" ", ""];
    sgrKeys = [""];
    sgrCloseKeys = [""];
    uris = [""];
    charIds = new Map([[" ", 0], ["", 1]]);
    styleIds = new Map([[JSON.stringify(["", ""]), 0]]);
    uriIds = new Map([["", 0]]);

    constructor(options) {
      this.options = options;
    }

    intern(value, table, ids) {
      let id = ids.get(value);
      if (id === undefined) {
        id = table.length;
        table.push(value);
        ids.set(value, id);
      }
      return id;
    }

    segment(text, cells, runs, reorder) {
      cellGraphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
      const segments = [], runPairs = [];
      for (const span of cellTextRuns(text)) {
        let uri = "";
        const sgr = [];
        for (const style of span.styles) {
          if (style.code.startsWith("\x1b]8;;")) uri = style.code.slice(5, -1);
          else {
            // _d accepts only numeric SGR codes with up to three digits.
            // Empty SGR means reset, but missing extended-color values are
            // invalid in the old parser, not black. Omit values outside the
            // consumer's three-digit grammar rather than inventing a color.
            const rawParams = style.code.slice(2, -1).split(";");
            if (rawParams.length > 1 && rawParams.slice(2).some((p) => p === "")) continue;
            const params = rawParams.map((p) => Number(p));
            if (params.every((p) => p <= 999)) sgr.push({ ...style, code: `\x1b[${params.join(";")}m` });
          }
        }
        const key = sgr.map((s) => s.code).join("\0");
        const closeKey = sgr.map((s) => s.endCode).join("\0");
        const styleKey = JSON.stringify([key, closeKey]);
        let styleId = this.styleIds.get(styleKey);
        if (styleId === undefined) {
          styleId = this.sgrKeys.length;
          this.sgrKeys.push(key);
          this.sgrCloseKeys.push(closeKey);
          this.styleIds.set(styleKey, styleId);
        }
        const uriId = this.intern(uri, this.uris, this.uriIds);
        const run = runPairs.length / 2;
        runPairs.push(styleId, uriId);
        for (const { segment } of cellGraphemeSegmenter.segment(span.text)) {
          let value = segment;
          const cp = value.codePointAt(0);
          // Tx replaced these single-code-unit bidi controls before painting.
          if (value.length === 1 && this.options.substitute.some(([lo, hi]) => cp >= lo && cp <= hi)) value = "\ufffd";
          const width = cp === 9 ? 0x100 : Bun.stringWidth(value, { ambiguousIsNarrow: this.options.ambiguousIsNarrow });
          segments.push({ value, width, run });
        }
      }
      if (cells.length < 2 * segments.length || runs.length < runPairs.length) {
        return -Math.max(segments.length, runPairs.length / 2);
      }
      if (reorder && segments.length) {
        const text = segments.map((s) => s.value.replace(/[\u061c\u202a-\u202e\u2066-\u2069]/g, "\ufffd")).join("");
        if (cellRtl.test(text)) {
          cellBidiLevels ??= createCellBidi();
          const { levels } = cellBidiLevels(text, "auto");
          const segmentLevels = [];
          let offset = 0, highest = 0;
          for (const s of segments) {
            const level = levels[offset];
            segmentLevels.push(level);
            highest = Math.max(highest, level);
            offset += s.value.length;
          }
          // Same grapheme-level reversal as the old renderer; no mirroring.
          for (let level = highest; level >= 1; level--) {
            for (let i = 0; i < segments.length;) {
              if (segmentLevels[i] < level) { i++; continue; }
              let end = i + 1;
              while (end < segments.length && segmentLevels[end] >= level) end++;
              for (let a = i, b = end - 1; a < b; a++, b--) {
                [segments[a], segments[b]] = [segments[b], segments[a]];
                [segmentLevels[a], segmentLevels[b]] = [segmentLevels[b], segmentLevels[a]];
              }
              i = end;
            }
          }
        }
      }
      runs.set(runPairs);
      for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        cells[2 * i] = this.intern(s.value, this.graphemes, this.charIds);
        cells[2 * i + 1] = (s.run << 10) | s.width;
      }
      return segments.length;
    }

    setCell(cells, width, x, y, charIndex, word) {
      if (x < 0 || y < 0 || x >= width || 2 * (y * width + x) >= cells.length) return 0;
      const screen = this.options.screen;
      const index = 2 * (y * width + x);
      const previous = cells[index + 1] & screen.widthMask;
      const next = word & screen.widthMask;
      const clear = (i) => { cells[i] = screen.emptyCharIndex; cells[i + 1] = screen.emptyWord; };
      if (previous === screen.wide && next !== screen.wide && x + 1 < width && (cells[index + 3] & screen.widthMask) === screen.spacerTail) clear(index + 2);
      let left = x, right = x + 1;
      if (previous === screen.spacerTail && next !== screen.spacerTail && x > 0 && (cells[index - 1] & screen.widthMask) === screen.wide) {
        clear(index - 2);
        left = x - 1;
      }
      cells[index] = charIndex;
      cells[index + 1] = word;
      if (next === screen.wide && x + 1 < width) {
        if ((cells[index + 3] & screen.widthMask) === screen.wide && x + 2 < width && (cells[index + 5] & screen.widthMask) === screen.spacerTail) clear(index + 4);
        cells[index + 2] = screen.spacerCharIndex;
        cells[index + 3] = (screen.emptyWord & ~screen.widthMask) | screen.spacerTail;
        right = x + 2;
      }
      // Preserve Ho's damage bounds, including its neighbour-clearing behavior.
      return left * 2 ** 20 + right * 2 ** 36;
    }

    paint(cells, width, x, y, segments, count, unused, charIndices, runWords) {
      const screen = this.options.screen;
      let left = width, right = 0;
      const put = (column, charIndex, word) => {
        const damage = this.setCell(cells, width, column, y, charIndex, word);
        const start = Math.floor(damage / 2 ** 20) % 2 ** 16;
        const end = Math.floor(damage / 2 ** 36);
        if (end > start) { left = Math.min(left, start); right = Math.max(right, end); }
      };
      for (let i = 0; i < count; i++) {
        const flags = segments[2 * i + 1];
        const word = runWords[flags >>> 10];
        const value = this.graphemes[segments[2 * i]];
        const cp = value.codePointAt(0);
        if (cp <= 31) {
          if (cp === 9) {
            const spaces = screen.tabWidth - x % screen.tabWidth;
            for (let j = 0; j < spaces && x < width; j++, x++) put(x, screen.emptyCharIndex, screen.emptyWord);
          }
          continue;
        }
        const columns = flags & 255;
        if (columns === 0) continue;
        if (columns >= 2 && x + columns > width) {
          put(x, screen.emptyCharIndex, (screen.emptyWord & ~screen.widthMask) | screen.spacerHead);
          x++;
          continue;
        }
        put(x, charIndices[segments[2 * i]], word | (columns >= 2 ? screen.wide : screen.narrow));
        for (let j = 2; j < columns; j++) put(x + j, screen.spacerCharIndex, word | screen.spacerTail);
        x += columns >= 2 ? columns : 1;
      }
      return x + (right > left ? left * 2 ** 20 + right * 2 ** 36 : 0);
    }
  }

  const sleepCell = new Int32Array(new SharedArrayBuffer(4));

  globalThis.Bun = {
    version: "polyfill",
    revision: "polyfill",
    // SEA extraction always runs as Node package — never standalone executable
    isStandaloneExecutable: false,

    // Ink builds its renderer with this from 2.1.271 on. The check in front
    // of it throws rather than degrading, so an absent CellSegmenter takes
    // startup down: the failure escapes process.exit(0) and forceExit turns
    // it into SIGKILL, surfacing as exit code 137 with no output.
    //
    // The other Bun.ant members stay absent on purpose — getPeerUid/getPeerPid
    // need SO_PEERCRED and memoryPressureLevel is macOS-native, none of which
    // JS can stand in for, and every one of those call sites degrades.
    ant: { CellSegmenter },

    // setJITPolicy is an optional Bun-only tuning hook called off a timer;
    // an empty namespace lets the optional call skip.
    unsafe: {},

    // Terminal teardown polls for a late DA1 response.
    sleepSync: (ms) => { Atomics.wait(sleepCell, 0, 0, ms); },

    file: bunFile,

    // Object.assign carries bunHash's own properties across — Bun.hash is
    // callable *and* namespaces xxHash64, and a bare wrapper would drop it.
    hash: Object.assign(function hash(data, seed) {
      if (arguments.length === 1) return bunHash(data);
      return bunHash(data, seed);
    }, bunHash),

    deepEquals,

    stripANSI: (str) => {
      if (_inkCompat?.stripANSI) return _inkCompat.stripANSI(str);
      return typeof str === "string" ? str.replace(ANSI_RE, "") : str;
    },

    stringWidth: (str, opts) => {
      if (_inkCompat?.stringWidth) return _inkCompat.stringWidth(str);
      if (!str) return 0;
      return str.replace(ANSI_RE, "").length;
    },

    wrapAnsi: (str, cols, opts) => {
      if (_inkCompat?.wrapAnsi) return _inkCompat.wrapAnsi(str, cols, opts);
      if (!str || cols <= 0) return str;
      return str;
    },

    // Layout truncation calls this while rendering; without it the renderer
    // drops the frame and panels sit on stale content — the task output pane
    // showing "Loading output…" indefinitely.
    sliceAnsi: (str, start, end) => {
      if (_inkCompat?.sliceAnsi) return _inkCompat.sliceAnsi(str, start, end);
      return typeof str === "string" ? str.slice(start, end) : str;
    },

    // Callers wrap order() in try/catch and rethrow as "Invalid SemVer", so a
    // parse failure has to propagate. Catching everything here turned a
    // rejected version into a silent 0 — equal — and made satisfies() answer
    // true for input it never parsed. Only fall back when the module itself
    // is unavailable, which is a different failure from bad input.
    semver: {
      order: (a, b) => {
        let semverModule;
        try { semverModule = require("semver"); } catch { semverModule = null; }
        if (semverModule) return semverModule.compare(a, b);
        const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
        for (let i = 0; i < 3; i++) {
          if ((pa[i] || 0) > (pb[i] || 0)) return 1;
          if ((pa[i] || 0) < (pb[i] || 0)) return -1;
        }
        return 0;
      },
      satisfies: (version, range) => {
        let semverModule;
        try { semverModule = require("semver"); } catch { semverModule = null; }
        if (!semverModule) return true;
        return semverModule.satisfies(version, range);
      },
    },

    YAML: {
      parse: (str) => { return require("yaml").parse(str); },
      stringify: (obj, replacer, indent) => { return require("yaml").stringify(obj, replacer, indent); },
    },

    JSONL: { parseChunk: null },

    which: (cmd) => {
      // Vendor directory lookup for bundled binaries.
      // Restores the semantics of USE_BUILTIN_RIPGREP:
      //   unset/1/true (default) → prefer vendor rg, fall back to system PATH
      //   0/false                → skip vendor, system PATH only
      // In Bun SEA mode, builtin rg lived inside the multicall binary via
      // Bun.isStandaloneExecutable. After SEA extraction for Node.js, the
      // embedded branch never fires, so vendor lookup happens here instead.
      if (cmd === "rg" || cmd === "rg.exe") {
        const useBuiltin = process.env.USE_BUILTIN_RIPGREP;
        const disabled = useBuiltin !== undefined &&
          ["0", "false", "no", "off"].includes(String(useBuiltin).toLowerCase().trim());
        if (!disabled) {
          try {
            const path = require("path");
            const archDir = process.arch + "-" + process.platform;
            const bin = process.platform === "win32" ? "rg.exe" : "rg";
            const vendorPath = path.join(__dirname, "vendor", "ripgrep", archDir, bin);
            if (fs.existsSync(vendorPath)) return vendorPath;
          } catch {}
        }
      }
      // System PATH lookup (execFileSync avoids shell injection vs execSync)
      try {
        const whichCmd = process.platform === "win32" ? "where" : "which";
        return cp.execFileSync(whichCmd, [cmd],
          { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 5000 }
        ).trim().split("\n")[0] || null;
      } catch { return null; }
    },

    spawn: bunSpawn,

    Terminal: (() => {
      let _nodePty = null;
      function loadPty() {
        if (_nodePty !== null) return _nodePty;
        try { _nodePty = require("node-pty"); } catch { _nodePty = false; }
        return _nodePty;
      }
      class BunTerminalPolyfill {
        constructor(opts = {}) {
          this._cols = opts.cols || 80;
          this._rows = opts.rows || 24;
          this._dataCallback = opts.data || null;
          this._pty = null;
        }
        _bind(cmd, args, spawnOpts) {
          const pty = loadPty();
          if (!pty) throw new Error("Bun.Terminal polyfill: install @xterm/node-pty");
          this._pty = pty.spawn(cmd, args, {
            name: spawnOpts?.env?.TERM || "xterm-256color",
            cols: this._cols, rows: this._rows,
            cwd: spawnOpts?.cwd || process.cwd(),
            env: spawnOpts?.env || process.env,
          });
          if (this._dataCallback) {
            this._pty.onData((data) => {
              try { this._dataCallback(this, Buffer.from(data)); } catch {}
            });
          }
          return this._pty;
        }
        resize(cols, rows) {
          try { this._pty?.resize(Math.max(1, cols), Math.max(1, rows)); } catch {}
        }
        write(data) {
          try { this._pty?.write(typeof data === "string" ? data : data.toString()); } catch {}
        }
        kill(sig) { try { this._pty?.kill(sig); } catch {} }
        close() { try { this._pty?.kill(); } catch {} this._pty = null; }
        get pid() { return this._pty?.pid; }
      }
      // Expose loadPty for spawn integration
      BunTerminalPolyfill._loadPty = loadPty;
      return BunTerminalPolyfill;
    })(),

    Transpiler: class BunTranspilerPolyfill {
      constructor(opts = {}) { this._loader = opts.loader || "js"; }
      transformSync(code) { return typeof code === "string" ? code : ""; }
      scanImports(code) { return []; }
    },

    listen: bunListen,
    connect: bunConnect,
    serve: bunServe,

    zstdDecompress,
    zstdDecompressSync,

    TOML: { parse: tomlParse },
    SQL: BunSQLPolyfill,
    stdin: bunStdin,
    WebView: BunWebView,

    gc: (full) => {
      if (typeof global.gc === "function") global.gc(full ? { type: "major" } : undefined);
    },

    generateHeapSnapshot: (format, encoding) => {
      try {
        const v8 = require("v8");
        // Bun.generateHeapSnapshot("v8", "arraybuffer") is written via writeFileSync
        if (encoding === "arraybuffer" || format === "v8") {
          const stats = v8.getHeapStatistics();
          const json = JSON.stringify({ polyfill: true, statistics: stats });
          const buf = Buffer.from(json, "utf8");
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        }
        return v8.getHeapStatistics();
      } catch { return {}; }
    },

    embeddedFiles: [],
  };

  // Patch ws.WebSocket: convert Bun-style {proxy: url} to Node-style {agent: HttpsProxyAgent}
  // Bun's ws natively supports a `proxy` option; Node's ws does not.
  // Without this, WebSocket connections (e.g. voice_stream) bypass HTTPS_PROXY.
  //
  // Bundled code uses: UfH = m(require("ws")); new UfH.default(url, opts)
  // UfH.default = require("ws") = the WebSocket class itself.
  // We must replace the class in require.cache so m() picks up the patched version.
  try {
    const _ws = require("ws");
    const _OrigWS = _ws.WebSocket || _ws;

    const _PatchedWS = function(url, protocols, opts) {
      if (typeof protocols === "object" && !Array.isArray(protocols) && protocols !== null) {
        opts = protocols; protocols = undefined;
      }
      if (opts?.proxy && !opts.agent) {
        // __HttpsProxyAgent is exposed by P7 AST patch from bundled cli.js
        const Agent = globalThis.__HttpsProxyAgent;
        if (Agent) opts = { ...opts, agent: new Agent(opts.proxy) };
        delete opts.proxy;
      }
      if (protocols !== undefined) return new _OrigWS(url, protocols, opts);
      return new _OrigWS(url, opts);
    };
    Object.setPrototypeOf(_PatchedWS, _OrigWS);
    Object.setPrototypeOf(_PatchedWS.prototype, _OrigWS.prototype);
    for (const k of ["CONNECTING","OPEN","CLOSING","CLOSED","Server","WebSocketServer","createWebSocketStream","WebSocket"])
      if (_OrigWS[k] !== undefined) _PatchedWS[k] = _OrigWS[k];
    _PatchedWS.WebSocket = _PatchedWS;

    // Replace in require.cache so m(require("ws")).default picks up the patch
    const _wsPath = require.resolve("ws");
    if (require.cache[_wsPath]) {
      require.cache[_wsPath].exports = _PatchedWS;
      require.cache[_wsPath].exports.WebSocket = _PatchedWS;
      require.cache[_wsPath].exports.default = _PatchedWS;
    }
  } catch {}
}
