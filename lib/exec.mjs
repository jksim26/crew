// Run an external command. Never through a shell on macOS/Linux; on Windows a shell is used only
// as a fallback for .cmd shims, with every argument quoted. Returns {ok, code, stdout, stderr, missing, timedOut}.
import { spawn, spawnSync } from "node:child_process";

const WIN = process.platform === "win32";

export function run(cmd, args = [], opts = {}) {
  const base = {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    input: opts.input,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 30_000,
    killSignal: opts.killSignal ?? "SIGTERM",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  };
  let r = spawnSync(cmd, args, { ...base, shell: false });
  if (WIN && r.error && ["ENOENT", "EINVAL"].includes(r.error.code)) {
    // npm-installed tools are .cmd shims, which Node cannot spawn without a shell.
    const line = [`${cmd}.cmd`, ...args].map(winQuote).join(" ");
    r = spawnSync(line, { ...base, shell: true });
  }
  if (r.error) {
    const timedOut = r.error.code === "ETIMEDOUT";
    return { ok: false, code: null, stdout: r.stdout ?? "", stderr: r.error.message, missing: r.error.code === "ENOENT", timedOut };
  }
  const missing = WIN && (r.status === 9009 || /is not recognized as an internal or external command/i.test(r.stderr ?? ""));
  const timedOut = r.signal !== null && r.status === null;
  return { ok: r.status === 0, code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", missing, timedOut };
}

/** Quote one argument for cmd.exe. */
export function winQuote(a) {
  const s = String(a);
  if (/^[A-Za-z0-9_\-.\/:=@,]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '""').replace(/%/g, "%%")}"`;
}

/**
 * Run a long command with a wall-clock limit and an idle limit (no stdout for idleMs).
 * On a limit: SIGINT, then SIGTERM after graceMs, then SIGKILL. Resolves, never rejects.
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string, timedOut:"wall"|"idle"|null, missing:boolean}>}
 */
export function runStreaming(cmd, args = [], { cwd, env, input, wallMs, idleMs, graceMs = 30_000, onLine } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    } catch (e) {
      resolve({ code: null, signal: null, stdout: "", stderr: e.message, timedOut: null, missing: e.code === "ENOENT" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let buf = "";
    let timedOut = null;
    let done = false;
    const timers = [];
    const stop = (why) => {
      if (timedOut || done) return;
      timedOut = why;
      child.kill("SIGINT");
      timers.push(setTimeout(() => { if (!done) child.kill("SIGTERM"); }, graceMs));
      timers.push(setTimeout(() => { if (!done) child.kill("SIGKILL"); }, graceMs + 10_000));
    };
    let idleTimer = null;
    const bump = () => {
      if (!idleMs) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop("idle"), idleMs);
    };
    if (wallMs) timers.push(setTimeout(() => stop("wall"), wallMs));
    bump();
    child.stdout.on("data", (d) => {
      const s = d.toString("utf8");
      stdout += s;
      bump();
      if (onLine) {
        buf += s;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim()) onLine(line);
        }
      }
    });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    child.on("error", (e) => {
      done = true;
      timers.forEach(clearTimeout);
      clearTimeout(idleTimer);
      resolve({ code: null, signal: null, stdout, stderr: stderr + e.message, timedOut, missing: e.code === "ENOENT" });
    });
    child.on("close", (code, signal) => {
      done = true;
      timers.forEach(clearTimeout);
      clearTimeout(idleTimer);
      resolve({ code, signal, stdout, stderr, timedOut, missing: false });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
