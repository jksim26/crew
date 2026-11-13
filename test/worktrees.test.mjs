import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanOrphans } from "../lib/worktrees.mjs";

const PORCELAIN = [
  "worktree /r", "HEAD a", "branch refs/heads/main", "",
  "worktree /tmp/crew-dev-live/wt", "HEAD b", "branch refs/heads/crew-work/7-1", "",
  "worktree /tmp/crew-dev-dead/wt", "HEAD c", "branch refs/heads/crew-work/8-1", "",
  "worktree /tmp/crew-review-gone/wt", "HEAD d", "branch refs/heads/crew-review/2026-11-13", "prunable gitdir file points to non-existent location", "",
  "worktree /tmp/other/wt", "HEAD e", "branch refs/heads/feature", "",
].join("\n");

function fake({ porcelain = PORCELAIN, listOk = true, branches = "" } = {}) {
  const calls = [];
  const run = (cmd, args) => {
    const l = `${cmd} ${args.join(" ")}`;
    calls.push(l);
    if (l.startsWith("git worktree list")) return listOk ? { ok: true, stdout: porcelain } : { ok: false, stderr: "boom" };
    if (l.startsWith("git branch --list")) return { ok: true, stdout: branches };
    return { ok: true, stdout: "" };
  };
  return { run, calls };
}
const old = () => 0;
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "crew-wtc-"));

test("cleanOrphans: keeps a live worker's worktree", () => {
  const f = fake();
  cleanOrphans({ root: tmpRoot(), run: f.run, keep: new Set(["/tmp/crew-dev-live/wt"]), statMtime: old });
  assert.ok(!f.calls.some((c) => c.includes("remove --force /tmp/crew-dev-live/wt")));
  assert.ok(!f.calls.includes("git branch -D crew-work/7-1"));
});

test("cleanOrphans: removes a dead run's worktree, temp folder and branch", () => {
  const f = fake();
  const out = cleanOrphans({ root: tmpRoot(), run: f.run, keep: new Set(["/tmp/crew-dev-live/wt"]), statMtime: old });
  assert.ok(f.calls.includes("git worktree remove --force /tmp/crew-dev-dead/wt"));
  assert.ok(f.calls.includes("git branch -D crew-work/8-1"));
  assert.ok(f.calls.includes("git worktree prune"));
  assert.equal(out.worktrees, 2);
});

test("cleanOrphans: removes the run's temp folder from disk", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crew-dev-"));
  const wt = path.join(tmp, "wt").split(path.sep).join("/");
  fs.mkdirSync(path.join(tmp, "wt"));
  const f = fake({ porcelain: `worktree /r\nHEAD a\n\nworktree ${wt}\nHEAD b\nbranch refs/heads/crew-work/9-1\n` });
  cleanOrphans({ root: tmpRoot(), run: f.run, keep: new Set(), statMtime: old });
  assert.equal(fs.existsSync(tmp), false);
});

test("cleanOrphans: a prunable worktree still loses its branch", () => {
  const f = fake();
  cleanOrphans({ root: tmpRoot(), run: f.run, keep: new Set(), statMtime: old });
  assert.ok(f.calls.includes("git branch -D crew-review/2026-11-13"));
});

test("cleanOrphans: never touches a non-crew worktree", () => {
  const f = fake();
  cleanOrphans({ root: tmpRoot(), run: f.run, keep: new Set(), statMtime: old });
  assert.ok(!f.calls.some((c) => c.includes("/tmp/other")));
  assert.ok(!f.calls.includes("git branch -D feature"));
});

test("cleanOrphans: keeps a temp folder newer than since", () => {
  const f = fake();
  const out = cleanOrphans({ root: tmpRoot(), run: f.run, keep: new Set(), since: 1000, statMtime: () => 2000 });
  assert.ok(!f.calls.some((c) => c.includes("remove --force")));
  assert.equal(out.worktrees, 0);
});

test("cleanOrphans: a folder that cannot be read counts as old", () => {
  const f = fake();
  const out = cleanOrphans({ root: tmpRoot(), run: f.run, keep: new Set(), since: 1000, statMtime: () => { throw new Error("ENOENT"); } });
  assert.equal(out.worktrees, 3);
});

test("cleanOrphans: git list failure is a no-op", () => {
  const f = fake({ listOk: false });
  const out = cleanOrphans({ root: tmpRoot(), run: f.run, keep: new Set(), statMtime: old });
  assert.deepEqual(out, { worktrees: 0, branches: 0 });
  assert.ok(!f.calls.some((c) => c.includes("remove --force")));
});

test("cleanOrphans: Windows paths", () => {
  const f = fake({ porcelain: "worktree C:/r\nHEAD a\n\nworktree C:/Users/jk/AppData/Local/Temp/crew-dev-x/wt\nHEAD b\nbranch refs/heads/crew-work/3-1\n" });
  const out = cleanOrphans({ root: tmpRoot(), run: f.run, keep: new Set(), statMtime: old });
  assert.ok(f.calls.includes("git worktree remove --force C:/Users/jk/AppData/Local/Temp/crew-dev-x/wt"));
  assert.equal(out.worktrees, 1);
});

test("cleanOrphans: deletes stray crew branches no worktree has checked out", () => {
  const f = fake({ porcelain: "worktree /r\nHEAD a\nbranch refs/heads/main\n", branches: "crew-work/5-1\ncrew-sync/6-1\n" });
  const out = cleanOrphans({ root: tmpRoot(), run: f.run, keep: new Set(), statMtime: old });
  assert.ok(f.calls.includes("git branch -D crew-work/5-1"));
  assert.ok(f.calls.includes("git branch -D crew-sync/6-1"));
  assert.equal(out.branches, 2);
});

test("cleanOrphans: a kept worktree's branch is never deleted as stray", () => {
  const f = fake({ branches: "crew-work/7-1\n" });
  cleanOrphans({ root: tmpRoot(), run: f.run, keep: new Set(["/tmp/crew-dev-live/wt"]), statMtime: old });
  assert.ok(!f.calls.includes("git branch -D crew-work/7-1"));
});

test("cleanOrphans: default keep reads this host's live workers", () => {
  const r = tmpRoot();
  const dir = path.join(r, ".crew", "workers");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "7.json"), JSON.stringify({ issue: 7, host: os.hostname(), pid: process.pid, started: new Date().toISOString(), wt: "/tmp/crew-dev-live/wt" }));
  fs.writeFileSync(path.join(dir, "9.json"), JSON.stringify({ issue: 9, host: "other-host", pid: 1, started: new Date().toISOString(), wt: "/tmp/crew-dev-dead/wt" }));
  const f = fake();
  cleanOrphans({ root: r, run: f.run, statMtime: old });
  assert.ok(!f.calls.some((c) => c.includes("remove --force /tmp/crew-dev-live/wt")));
  assert.ok(f.calls.includes("git worktree remove --force /tmp/crew-dev-dead/wt"));
});
