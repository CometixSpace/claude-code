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

  globalThis.Bun = {
    version: "polyfill",
    revision: "polyfill",
    // SEA extraction always runs as Node package — never standalone executable
    isStandaloneExecutable: false,

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
