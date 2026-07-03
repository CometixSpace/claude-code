// Bun API polyfill for Node.js runtime
// Injected at the top of cli.js when Bun is not available
// Provides compatible implementations of Bun-specific APIs

if (typeof globalThis.Bun === "undefined") {
  const crypto = require("crypto");
  const cp = require("child_process");
  const { Readable } = require("stream");

  // Bun.spawn polyfill
  // Returns an object mimicking Bun.Subprocess interface:
  //   .pid, .unref(), .kill(), .exited (Promise<number>), .stdout.text() (Promise<string>)
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

    const nodeOpts = {
      cwd: opts.cwd,
      env: opts.env,
      stdio: opts.stdio || [
        opts.stdin || "ignore",
        opts.stdout === "pipe" ? "pipe" : "inherit",
        opts.stderr === "ignore" ? "ignore" : (opts.stderr === "pipe" ? "pipe" : "inherit"),
      ],
      detached: opts.detached || false,
      windowsHide: opts.windowsHide ?? true,
    };

    // argv0 support
    if (opts.argv0) {
      nodeOpts.argv0 = opts.argv0;
    }

    const child = cp.spawn(cmd, spawnArgs, nodeOpts);

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

    // exited promise
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

  // Bun.hash polyfill using wyhash-compatible behavior
  // Returns number (not bigint) for compatibility
  function bunHash(data, seed) {
    const str = typeof data === "string" ? data : String(data);
    const h = crypto.createHash("sha256").update(str);
    if (seed !== undefined) h.update(String(seed));
    const buf = h.digest();
    // Return a numeric hash (first 8 bytes as number, matching Bun.hash range)
    return Number(buf.readBigUInt64LE(0) & 0xFFFFFFFFn);
  }
  bunHash.toString = () => "function hash() { [native code] }";

  // Load Anthropic-compatible ink implementations (bundled from source)
  let _inkCompat = null;
  try { _inkCompat = require("./bun-ink-compat.cjs"); } catch {}

  // ANSI escape regex (fallback if compat module unavailable)
  const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

  globalThis.Bun = {
    version: "polyfill",

    hash: function hash(data, seed) {
      if (arguments.length === 1) return bunHash(data);
      return bunHash(data, seed);
    },

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

    semver: {
      order: (a, b) => {
        try { return require("semver").compare(a, b); }
        catch {
          const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
          for (let i = 0; i < 3; i++) {
            if ((pa[i] || 0) > (pb[i] || 0)) return 1;
            if ((pa[i] || 0) < (pb[i] || 0)) return -1;
          }
          return 0;
        }
      },
      satisfies: (version, range) => {
        try { return require("semver").satisfies(version, range); }
        catch { return true; }
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
            const fs = require("fs");
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

    listen: () => { throw new Error("Bun.listen unavailable (running under Node.js polyfill)"); },

    gc: (full) => {
      if (typeof global.gc === "function") global.gc(full ? { type: "major" } : undefined);
    },

    generateHeapSnapshot: () => {
      try {
        const v8 = require("v8");
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
