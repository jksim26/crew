// `crew sync`: bring the main checkout up to date with origin, safely, before unattended runners use
// it. Fast-forward only: never merges, rebases, resets, stashes or touches untracked files. When it
// cannot fast-forward it says why and exits non-zero, so the scheduler shows a failed last run.
import { run as realRun } from "./exec.mjs";
import { logLine } from "./state.mjs";

function git(run, args, cwd) {
  return run("git", args, { cwd, timeoutMs: 120_000 });
}

/** @returns {{ok:boolean, outcome:string, detail:string}} */
export function syncCheckout({ root, config, run = realRun }) {
  const base = config.default_branch;
  const done = (ok, outcome, detail) => {
    logLine(root, { action: "sync", outcome, detail });
    return { ok, outcome, detail };
  };

  const head = git(run, ["symbolic-ref", "--short", "-q", "HEAD"], root);
  const branch = head.ok ? head.stdout.trim() : "(detached)";
  if (branch !== base) return done(false, "skipped", `checkout is on ${branch}, not ${base}; nothing changed`);

  // Tracked changes block a fast-forward; untracked files are never touched and do not block.
  const st = git(run, ["status", "--porcelain", "--untracked-files=no"], root);
  if (!st.ok) return done(false, "error", `git status failed: ${firstLine(st.stderr)}`);
  if (st.stdout.trim()) return done(false, "skipped", `local changes to tracked files: ${st.stdout.trim().split("\n").length} file(s); nothing changed`);

  const f = git(run, ["fetch", "--quiet", "origin", base], root);
  if (!f.ok) return done(false, "error", `git fetch failed: ${firstLine(f.stderr)}`);

  const behind = Number(git(run, ["rev-list", "--count", `HEAD..origin/${base}`], root).stdout.trim() || 0);
  const ahead = Number(git(run, ["rev-list", "--count", `origin/${base}..HEAD`], root).stdout.trim() || 0);
  if (!behind) return done(true, "up-to-date", ahead ? `already current (${ahead} local commit(s) not pushed)` : "already current");
  if (ahead) return done(false, "diverged", `${ahead} local and ${behind} remote commit(s); fast-forward impossible, nothing changed`);

  const m = git(run, ["merge", "--ff-only", "--quiet", `origin/${base}`], root);
  if (!m.ok) return done(false, "error", `fast-forward failed: ${firstLine(m.stderr)}; nothing changed`);
  return done(true, "fast-forwarded", `${behind} commit(s) from origin/${base}`);
}

function firstLine(s) {
  return String(s ?? "").trim().split(/\r?\n/)[0] ?? "";
}
