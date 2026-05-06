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
    const nodeOpts = {
      cwd: opts.cwd,
      env: opts.env,
      stdio: opts.stdio || [
        opts.stdin || "ignore",
        opts.stdout === "pipe" ? "pipe" : (opts.terminal ? "pipe" : "inherit"),
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
    const exited = new Promise((resolve) => {
      child.on("close", (code) => resolve(code ?? 1));
      child.on("error", () => resolve(1));
    });

    return {
      pid: child.pid,
      unref: () => child.unref(),
      kill: (sig) => child.kill(sig),
      ref: () => child.ref(),
      stdin: child.stdin,
      stdout,
      stderr: child.stderr,
      exited,
      exitCode: null,
    };
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

  // ANSI escape regex
  const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

  globalThis.Bun = {
    version: "polyfill",

    hash: function hash(data, seed) {
      if (arguments.length === 1) return bunHash(data);
      return bunHash(data, seed);
    },

    stripANSI: (str) => typeof str === "string" ? str.replace(ANSI_RE, "") : str,

    stringWidth: (str, opts) => {
      // Simplified: count visible characters (exclude ANSI, handle wide chars)
      if (!str) return 0;
      const stripped = str.replace(ANSI_RE, "");
      let width = 0;
      for (const ch of stripped) {
        const code = ch.codePointAt(0);
        // CJK Unified Ideographs, CJK Compatibility, Fullwidth forms
        if ((code >= 0x1100 && code <= 0x115F) || (code >= 0x2E80 && code <= 0x303E) ||
            (code >= 0x3040 && code <= 0x33BF) || (code >= 0xF900 && code <= 0xFAFF) ||
            (code >= 0xFE30 && code <= 0xFE6F) || (code >= 0xFF01 && code <= 0xFF60) ||
            (code >= 0xFFE0 && code <= 0xFFE6) || (code >= 0x20000 && code <= 0x2FFFD) ||
            (code >= 0x30000 && code <= 0x3FFFD)) {
          width += 2;
        } else if (code >= 0x20) {
          width += 1;
        }
      }
      return width;
    },

    wrapAnsi: (str, cols, opts) => {
      // Simplified line wrapper
      if (!str || cols <= 0) return str;
      const lines = str.split("\n");
      const result = [];
      for (const line of lines) {
        if (line.length <= cols) { result.push(line); continue; }
        let cur = "";
        for (const ch of line) {
          if (cur.length >= cols) { result.push(cur); cur = ""; }
          cur += ch;
        }
        if (cur) result.push(cur);
      }
      return result.join("\n");
    },

    semver: {
      order: (a, b) => {
        const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
        for (let i = 0; i < 3; i++) {
          if ((pa[i] || 0) > (pb[i] || 0)) return 1;
          if ((pa[i] || 0) < (pb[i] || 0)) return -1;
        }
        return 0;
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
      try {
        return cp.execSync(
          process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`,
          { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }
        ).trim().split("\n")[0] || null;
      } catch { return null; }
    },

    spawn: bunSpawn,

    Terminal: class BunTerminalPolyfill {
      constructor() { throw new Error("Bun.Terminal unavailable (running under Node.js polyfill)"); }
    },

    Transpiler: class BunTranspilerPolyfill {
      constructor() { throw new Error("Bun.Transpiler unavailable (running under Node.js polyfill)"); }
      transformSync() { return ""; }
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
}
