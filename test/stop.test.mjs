import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stopBatch } from "../lib/stop.mjs";
import { normalize } from "../lib/config.mjs";
import { leaseHeld } from "../lib/state.mjs";

const config = normalize({ repo: "jk/proj", owner_login: "jk" });
function root(lock) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "crew-stop-"));
  fs.mkdirSync(path.join(r, ".crew"));
  if (lock) fs.writeFileSync(path.join(r, ".crew", "dispatch.lock"), JSON.stringify(lock));
  return r;
}
function fake({ killOk = true, denied = false } = {}) {
  const calls = [];
  const run = (cmd, args) => {
    const l = `${cmd} ${args.join(" ")}`;
    calls.push(l);
    if (cmd === "taskkill" || cmd === "kill") return killOk ? { ok: true, stdout: "" } : { ok: false, stderr: denied ? "ERROR: Access is denied." : "nope" };
    if (l.startsWith("git worktree list")) return { ok: true, stdout: "worktree /r\nHEAD a\n\nworktree /tmp/crew-dev-abc/wt\nHEAD b\n\nworktree /tmp/other\n" };
    if (l.startsWith("git branch --list")) return { ok: true, stdout: "crew-work/7-1\n" };
    if (l.startsWith("gh issue list")) return { ok: true, stdout: JSON.stringify([{ number: 7 }]) };
    if (l.startsWith("gh issue view")) return { ok: true, stdout: JSON.stringify({ labels: [{ name: "doing" }] }) };
    return { ok: true, stdout: "" };
  };
  return { run, calls };
}

test("stop: kills the batch tree by the lock pid, cleans worktrees, doing -> blocked, optional hold", () => {
  const r = root({ pid: 4242, host: os.hostname(), at: new Date().toISOString() });
  const f = fake();
  const out = stopBatch({ root: r, config, run: f.run, platform: "win32", hold: true, isAlive: () => true });
  assert.deepEqual([out.stopped, out.pid, out.worktrees, out.blocked], [true, 4242, 1, [7]]);
  assert.ok(f.calls.includes("taskkill /PID 4242 /T /F"));
  assert.ok(f.calls.includes("git worktree remove --force /tmp/crew-dev-abc/wt"));
  assert.ok(!f.calls.some((c) => c.includes("remove --force /tmp/other")));
  assert.ok(f.calls.includes("git branch -D crew-work/7-1"));
  assert.ok(f.calls.some((c) => c.startsWith("gh issue edit 7 --repo jk/proj --add-label blocked")));
  assert.ok(!f.calls.some((c) => c.includes("--add-label ready")));
  assert.equal(fs.existsSync(path.join(r, ".crew", "dispatch.lock")), false);
  assert.equal(leaseHeld(r), true);
});

test("stop: access denied says to use an elevated terminal and keeps the lock", () => {
  const r = root({ pid: 4242, host: os.hostname() });
  const out = stopBatch({ root: r, config, run: fake({ killOk: false, denied: true }).run, platform: "win32", isAlive: () => true });
  assert.match(out.why, /elevated/);
  assert.equal(fs.existsSync(path.join(r, ".crew", "dispatch.lock")), true);
});

test("stop: another host's lock is not ours; no lock is just cleanup", () => {
  assert.match(stopBatch({ root: root({ pid: 1, host: "elsewhere" }), config, run: fake().run }).why, /elsewhere/);
  const out = stopBatch({ root: root(null), config, run: fake().run, platform: "darwin", isAlive: () => false });
  assert.equal(out.stopped, false);
  assert.equal(out.worktrees, 1);
});
