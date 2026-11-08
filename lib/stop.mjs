// `crew stop`: end a running dispatch or review batch on this machine, children and all.
// A scheduled task's own "End" stops only its cmd.exe; the node dispatcher and its claude children live
// on (seen on the PC 2026-11-09). This kills the whole tree by the pid in the lock, cleans the
// worktrees, and moves issues left in `doing` to `blocked` (never to `ready`: that is the owner's label).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run as realRun } from "./exec.mjs";
import { readJson, crewDir, takeLease, logLine } from "./state.mjs";
import { ghJson } from "./gh.mjs";
import { setState } from "./queue.mjs";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** @returns {{stopped:boolean, pid?:number, why?:string, worktrees:number, blocked:number[]}} */
export function stopBatch({ root, config, run = realRun, platform = process.platform, hold = false, isAlive = alive }) {
  const lock = path.join(crewDir(root), "dispatch.lock");
  const cur = readJson(lock, null);
  const out = { stopped: false, worktrees: 0, blocked: [] };
  if (cur?.pid) {
    if (cur.host && cur.host !== os.hostname()) return { ...out, why: `the batch runs on ${cur.host}, not here` };
    if (isAlive(cur.pid)) {
      const r = platform === "win32"
        ? run("taskkill", ["/PID", String(cur.pid), "/T", "/F"], { timeoutMs: 60_000 })
        : (run("pkill", ["-TERM", "-P", String(cur.pid)]), run("kill", ["-TERM", String(cur.pid)]));
      if (!r.ok && isAlive(cur.pid)) {
        const denied = /access is denied|operation not permitted/i.test(`${r.stderr}${r.stdout}`);
        return { ...out, pid: cur.pid, why: denied
          ? "access denied: the batch runs as a scheduled task; run crew stop from an elevated (admin) terminal"
          : `could not end pid ${cur.pid}: ${String(r.stderr || r.stdout).trim().split("\n")[0]}` };
      }
      out.stopped = true;
      out.pid = cur.pid;
    }
  }
  fs.rmSync(lock, { force: true });
  if (hold) takeLease(root, "crew stop --hold");

  // Worktrees and branches the batch made.
  const list = run("git", ["worktree", "list", "--porcelain"], { cwd: root });
  for (const line of String(list.stdout ?? "").split(/\r?\n/)) {
    const m = /^worktree (.+)$/.exec(line);
    if (m && /crew-(dev|review)-/.test(m[1])) {
      run("git", ["worktree", "remove", "--force", m[1]], { cwd: root });
      out.worktrees++;
    }
  }
  run("git", ["worktree", "prune"], { cwd: root });
  const branches = run("git", ["branch", "--list", "crew-work/*", "crew-review/*", "--format=%(refname:short)"], { cwd: root });
  for (const b of String(branches.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) run("git", ["branch", "-D", b], { cwd: root });

  // Issues the batch had marked `doing` would otherwise look busy forever.
  const doing = ghJson(run, ["issue", "list", "--repo", config.repo, "--state", "open", "--label", "doing", "--json", "number"]) ?? [];
  for (const i of doing) {
    setState(config, i.number, "blocked", { run, reason: "The dev run was stopped by `crew stop` before it finished. Relabel `ready` to try again." });
    out.blocked.push(i.number);
  }
  logLine(root, { action: "stop", ...out });
  return out;
}
