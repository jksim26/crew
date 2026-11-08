// Small wrappers around the gh CLI. Errors carry the first line of gh's stderr.
import { run as realRun } from "./exec.mjs";

export function gh(run, args, opts = {}) {
  const r = (run ?? realRun)("gh", args, { timeoutMs: 60_000, ...opts });
  if (!r.ok) {
    const msg = String(r.stderr || r.stdout || "").trim().split("\n")[0];
    const err = new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${msg}`);
    err.stderr = r.stderr;
    throw err;
  }
  return r.stdout;
}

export function ghJson(run, args, opts) {
  const out = gh(run, args, opts);
  return out.trim() ? JSON.parse(out) : null;
}

/** fnmatch-style glob: `*` matches anything (including `/`), `?` one character. Case-sensitive. */
export function globToRegExp(glob) {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`);
}

export function matchesAny(file, globs) {
  return globs.some((g) => globToRegExp(g).test(file));
}
