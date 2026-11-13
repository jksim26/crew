// Worktrees left by crew runs that died (a reboot, a crash, a kill) never reach their own `finally`
// cleanup. Each tick removes them, so a dead run's Rust build cannot hold disk space past the next
// tick. Only this repo's worktrees are looked at (`git worktree list`), never the temp folder itself:
// other repos' crew runs share it.
import fs from "node:fs";
import path from "node:path";
import { liveWorkers } from "./state.mjs";

const CREW_WT = /crew-(dev|review)-/;
const CREW_TMP = /^crew-(dev|review)-/;
const CREW_BRANCHES = ["crew-work/*", "crew-sync/*", "crew-review/*"];
/** A run's temp folder name (crew-dev-XXXXXX, unique per run). Paths are compared by it, because git
 *  and Node spell the same folder differently: /private/var vs /var on macOS, / vs \ and 8.3 short
 *  names on Windows. */
const runDir = (wt) => String(wt).split(/[\\/]+/).filter(Boolean).slice(-2, -1)[0] ?? "";

function parsePorcelain(text) {
  return String(text ?? "").split(/\r?\n\r?\n/).map((block) => {
    const wt = { path: null, branch: null };
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) wt.path = line.slice(9);
      else if (line.startsWith("branch refs/heads/")) wt.branch = line.slice(18);
    }
    return wt;
  }).filter((w) => w.path);
}

/**
 * Remove crew worktrees no live run owns: the worktree, its crew temp folder and its branch, then
 * any crew branch no remaining worktree has checked out.
 * keep: worktree paths to keep (null = the `wt` of every live worker file, any host: a repo on a
 *   shared drive shares .git/worktrees, and another host's live run must survive this host's tick).
 * since: epoch ms; a temp folder modified at or after it is kept (null = no age check).
 * @returns {{worktrees:number, branches:number}}
 */
export function cleanOrphans({ root, run, keep = null, since = null, statMtime = (p) => fs.statSync(p).mtimeMs, rm = (p) => fs.rmSync(p, { recursive: true, force: true }) }) {
  const out = { worktrees: 0, branches: 0 };
  const list = run("git", ["worktree", "list", "--porcelain"], { cwd: root });
  if (!list.ok) return out;
  const kept = new Set([...(keep ?? liveWorkers(root).filter((w) => w.wt).map((w) => w.wt))].map(runDir));
  const isNew = (dir) => {
    if (since == null) return false;
    try { return statMtime(dir) >= since; } catch { return false; }
  };
  const remaining = new Set();
  const deleted = new Set();
  for (const w of parsePorcelain(list.stdout)) {
    const tmp = path.dirname(w.path);
    if (!CREW_WT.test(w.path) || kept.has(runDir(w.path)) || isNew(tmp)) {
      if (w.branch) remaining.add(w.branch);
      continue;
    }
    run("git", ["worktree", "remove", "--force", w.path], { cwd: root });
    // A folder held open (Windows antivirus, the indexer) must not stop the tick: the next one retries.
    if (CREW_TMP.test(path.basename(tmp))) try { rm(tmp); } catch { /* retried next tick */ }
    out.worktrees++;
    if (w.branch) {
      run("git", ["branch", "-D", w.branch], { cwd: root });
      deleted.add(w.branch);
      out.branches++;
    }
  }
  run("git", ["worktree", "prune"], { cwd: root });
  const branches = run("git", ["branch", "--list", ...CREW_BRANCHES, "--format=%(refname:short)"], { cwd: root });
  for (const b of String(branches.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    if (remaining.has(b) || deleted.has(b)) continue;
    run("git", ["branch", "-D", b], { cwd: root });
    out.branches++;
  }
  return out;
}
