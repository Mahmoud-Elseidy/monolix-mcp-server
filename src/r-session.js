/**
 * r-session.js
 * Persistent R process manager using readline IPC.
 * One background R REPL process per software target (monolix/simulx/pkanalix).
 *
 * NOTE: we run the R interpreter as a stdin-driven REPL (Rterm/R, NOT
 * `Rscript -e`). `Rscript -e` executes once and exits, which is incompatible
 * with a long-lived session that receives commands over stdin.
 */

import { spawn } from "child_process";
import { createInterface } from "readline";
import { EventEmitter } from "events";
import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

const SENTINEL = "__MCP_DONE__";
const ERROR_SENTINEL = "__MCP_ERROR__";
const TIMEOUT_MS = 600_000; // 10 min for long SAEM runs

const usable = (exe) => {
  try {
    return existsSync(exe) && statSync(exe).size > 0;
  } catch {
    return false;
  }
};

/**
 * Resolve the R REPL binary used to drive a persistent session.
 * Priority: RSCRIPT_PATH / R_BINARY env → newest Windows install (preferring
 * the arch-specific Rterm.exe/R.exe, skipping 0-byte launcher stubs) → "R".
 *
 * On Windows the console REPL is Rterm.exe; the top-level bin\Rscript.exe is
 * often a 0-byte stub (causing spawn EFTYPE / "This app can't run on your PC").
 */
export function resolveRBinary() {
  const override = process.env.R_BINARY || process.env.RSCRIPT_PATH;
  if (override) {
    // If pointed at Rscript, prefer the REPL (Rterm/R) sibling next to it.
    const term = override.replace(/Rscript(\.exe)?$/i, "Rterm$1");
    if (usable(term)) return term;
    if (usable(override)) return override;
    return override; // let spawn surface the error
  }

  if (process.platform === "win32") {
    for (const rRoot of ["C:/Program Files/R", "C:/Program Files/Microsoft/R Open"]) {
      if (!existsSync(rRoot)) continue;
      const versions = readdirSync(rRoot)
        .filter((d) => /^R-?\d/.test(d))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const v of versions) {
        for (const sub of ["bin/x64", "bin/i386", "bin"]) {
          for (const exe of ["Rterm.exe", "R.exe"]) {
            const p = join(rRoot, v, sub, exe);
            if (usable(p)) return p;
          }
        }
      }
    }
  }

  // POSIX: the `R` REPL reads commands from stdin.
  return "R";
}

// Backwards-compatible alias (older name used elsewhere/tests).
export const resolveRscript = resolveRBinary;

const R_BINARY = resolveRBinary();

export class RSession extends EventEmitter {
  constructor(software, lixoftHome) {
    super();
    this.software = software;
    this.lixoftHome = lixoftHome;
    this.ready = false;
    this.busy = false;
    this._queue = [];
    this._resolve = null;
    this._reject = null;
    this._buffer = [];
    this._proc = null;
  }

  async start() {
    // Persistent REPL: --vanilla (no save/restore/site/init), --quiet (no
    // banner), --no-echo (don't echo stdin). Commands are sent over stdin.
    this._proc = spawn(R_BINARY, ["--vanilla", "--quiet", "--no-echo"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LIXOFT_HOME: this.lixoftHome },
    });

    // Keep the most recent stderr so init failures can report the real cause.
    this._stderrTail = "";

    // Initialization is sent as the first command over stdin. Wrapped in
    // tryCatch so a failure emits ERROR_SENTINEL (the REPL stays alive on
    // error, so we must signal failure explicitly rather than rely on exit).
    const initScript = `
tryCatch({
  options(warn = 1)
  suppressMessages(library(lixoftConnectors))
  initializeLixoftConnectors(
    software  = "${this.software}",
    path      = "${this.lixoftHome}",
    force     = TRUE
  )
  cat("\\n${SENTINEL}\\n")
}, error = function(e) {
  cat("\\nINIT ERROR:", conditionMessage(e), "\\n")
  cat("${ERROR_SENTINEL}\\n")
})
`.trim();

    const rl = createInterface({ input: this._proc.stdout });
    rl.on("line", (line) => this._onLine(line));
    this._proc.stderr.on("data", (d) => {
      const msg = d.toString();
      this._stderrTail = (this._stderrTail + msg).slice(-2000);
      const trimmed = msg.trim();
      if (trimmed) process.stderr.write(`[R/${this.software}] ${trimmed}\n`);
    });
    this._proc.on("error", (err) => {
      this.ready = false;
      const e =
        err.code === "ENOENT"
          ? new Error(
              `R interpreter not found ('${R_BINARY}'). Set RSCRIPT_PATH or R_BINARY to your R/Rscript executable.`
            )
          : err;
      this.emit("initFailed", e);
      if (this._reject) { this._reject(e); this._reject = null; }
    });
    this._proc.on("exit", (code) => {
      this.ready = false;
      // If the process dies before/while initializing, fail fast with the
      // captured R error rather than waiting for the init timeout.
      if (!this.ready && code !== 0) {
        this.emit(
          "initFailed",
          new Error(
            `R session exited during init (code ${code}).` +
              (this._stderrTail ? `\n${this._stderrTail.trim()}` : "")
          )
        );
      }
      if (this._reject) this._reject(new Error(`R session exited (code ${code})`));
    });

    // Send the init script to the REPL over stdin.
    this._proc.stdin.write(initScript + "\n");

    // Wait for init sentinel, an init error, a spawn failure, or early exit.
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("R session init timeout")), 60_000);
      const onErr = (e) => { clearTimeout(t); this.removeListener("ready", onReady); rej(e); };
      const onReady = () => { clearTimeout(t); this.removeListener("initFailed", onErr); res(); };
      this.once("ready", onReady);
      this.once("initFailed", onErr);
    });
    this.ready = true;
    this._buffer = []; // discard any init-phase output
  }

  _onLine(line) {
    // During initialization (before ready), the handshake sentinels signal
    // success/failure of the init script rather than a normal command.
    if (!this.ready) {
      if (line.includes(SENTINEL)) {
        this.emit("ready");
        return;
      }
      if (line.includes(ERROR_SENTINEL)) {
        const msg = this._buffer.join("\n").trim() || this._stderrTail.trim();
        this._buffer = [];
        this.emit("initFailed", new Error(msg || "R initialization failed"));
        return;
      }
      this._buffer.push(line);
      return;
    }
    if (line === SENTINEL) {
      const output = this._buffer.join("\n");
      this._buffer = [];
      this.busy = false;
      if (this._resolve) { this._resolve(output); this._resolve = null; }
      this._drainQueue();
    } else if (line === ERROR_SENTINEL) {
      const output = this._buffer.join("\n");
      this._buffer = [];
      this.busy = false;
      if (this._reject) { this._reject(new Error(output)); this._reject = null; }
      this._drainQueue();
    } else {
      this._buffer.push(line);
    }
  }

  _drainQueue() {
    if (this._queue.length > 0) {
      const { code, resolve, reject } = this._queue.shift();
      this._execute(code, resolve, reject);
    }
  }

  _execute(code, resolve, reject) {
    this.busy = true;
    this._resolve = resolve;
    this._reject = reject;

    // Wrap in tryCatch so errors emit ERROR_SENTINEL
    const wrapped = `
tryCatch({
${code}
cat("\\n${SENTINEL}\\n")
}, error = function(e) {
  cat(conditionMessage(e), "\\n")
  cat("${ERROR_SENTINEL}\\n")
})
`.trim();

    this._proc.stdin.write(wrapped + "\n");

    // Timeout guard
    const t = setTimeout(() => {
      reject(new Error(`R execution timeout after ${TIMEOUT_MS / 1000}s`));
      this.busy = false;
    }, TIMEOUT_MS);
    // Clear timeout when resolved
    const origResolve = this._resolve;
    this._resolve = (v) => { clearTimeout(t); origResolve(v); };
  }

  run(code) {
    return new Promise((resolve, reject) => {
      if (!this.busy) {
        this._execute(code, resolve, reject);
      } else {
        this._queue.push({ code, resolve, reject });
      }
    });
  }

  stop() {
    if (this._proc) this._proc.kill();
  }
}

/**
 * SessionPool: manages one RSession per software target, lazy-initialized.
 */
export class SessionPool {
  constructor(lixoftHome) {
    this.lixoftHome = lixoftHome;
    this._sessions = {};   // software -> ready RSession
    this._pending = {};    // software -> in-flight start() promise
  }

  async get(software) {
    if (this._sessions[software]) return this._sessions[software];

    // Memoize the in-flight creation so concurrent callers share ONE session
    // instead of each racing to spawn their own R process.
    if (!this._pending[software]) {
      this._pending[software] = (async () => {
        const s = new RSession(software, this.lixoftHome);
        await s.start();
        this._sessions[software] = s;
        return s;
      })().finally(() => {
        delete this._pending[software];
      });
    }
    return this._pending[software];
  }

  stopAll() {
    Object.values(this._sessions).forEach((s) => s.stop());
  }
}
