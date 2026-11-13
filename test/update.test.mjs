import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  updateHome, runnerDir, readUpdateState, writeUpdateState, autoUpdateOn, setAutoUpdate,
  markUpdating, clearUpdating, updatingNow,
} from "../lib/update.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "crew-upd-"));
const envFor = (dir = tmp()) => ({ XDG_DATA_HOME: dir, LOCALAPPDATA: dir, XDG_CONFIG_HOME: path.join(dir, "cfg"), APPDATA: path.join(dir, "cfg") });

test("updateHome: per platform", () => {
  const dir = tmp();
  assert.equal(updateHome({ XDG_DATA_HOME: dir }, "darwin"), path.join(dir, "crew"));
  assert.equal(updateHome({ LOCALAPPDATA: "C:\\L" }, "win32"), path.join("C:\\L", "crew"));
  assert.ok(updateHome({}, "darwin").endsWith(path.join(".local", "share", "crew")));
  assert.equal(runnerDir({ XDG_DATA_HOME: dir }, "darwin"), path.join(dir, "crew", "runtime"));
});

test("update state: defaults, then round-trip", () => {
  const env = envFor();
  assert.deepEqual(readUpdateState(env, "darwin"), { current: null, previous: null, bad: [], last_check: null, last_result: null, temp_failures: 0, plugin_pending: false });
  const s = { current: "b", previous: "a", bad: ["x"], last_check: "2026-11-14T00:00:00.000Z", last_result: "updated", temp_failures: 1, plugin_pending: true };
  writeUpdateState(s, env, "darwin");
  assert.deepEqual(readUpdateState(env, "darwin"), s);
});

test("auto-update: on by default, off and on again", () => {
  const env = envFor();
  assert.equal(autoUpdateOn(env, "darwin"), true);
  setAutoUpdate(false, { env, platform: "darwin" });
  assert.equal(autoUpdateOn(env, "darwin"), false);
  setAutoUpdate(true, { env, platform: "darwin" });
  assert.equal(autoUpdateOn(env, "darwin"), true);
});

test("updating marker: honoured for 5 minutes", () => {
  const env = envFor();
  const t0 = new Date("2026-11-14T10:00:00Z");
  assert.equal(updatingNow(env, "darwin", t0.getTime()), false);
  markUpdating(env, "darwin", t0);
  assert.equal(updatingNow(env, "darwin", t0.getTime() + 4 * 60_000), true);
  assert.equal(updatingNow(env, "darwin", t0.getTime() + 6 * 60_000), false);
  clearUpdating(env, "darwin");
  assert.equal(updatingNow(env, "darwin", t0.getTime() + 60_000), false);
});

// ---- the update run ---------------------------------------------------------------------------
import { runUpdate, syncPlugin, rollbackUpdate } from "../lib/update.mjs";

const NODE = process.execPath;
const OLD = "a".repeat(40), NEW = "b".repeat(40);

/** A machine: runner clone at OLD (0.8.22), origin/main at NEW (0.8.23), one crew project with Slack. */
function machine(o = {}) {
  const dir = tmp();
  const env = envFor(dir);
  const rt = runnerDir(env, "darwin");
  const writeVersion = (where, v) => {
    fs.mkdirSync(path.join(where, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(where, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "crew", version: v }));
    fs.mkdirSync(path.join(where, "bin"), { recursive: true });
    fs.writeFileSync(path.join(where, "bin", "crew"), "");
  };
  writeVersion(rt, "0.8.22");
  const project = path.join(dir, "proj");
  fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(project, ".claude", "crew.json"), JSON.stringify({ repo: "jk/proj", owner_login: "jk", slack: { channel: "C0123ABCD" } }));
  const s = { head: OLD, origin: o.origin ?? NEW, dirty: !!o.dirty, plugin: o.plugin ?? "0.8.22", fetchFails: o.fetchFails ?? 0, testsFail: !!o.testsFail,
    runnerVersion: o.runnerVersion ?? null, claudeMissing: !!o.claudeMissing, noDowngrade: !!o.noDowngrade, onMerge: o.onMerge ?? null };
  const calls = [];
  const ok = (stdout = "") => ({ ok: true, code: 0, stdout, stderr: "" });
  const run = (cmd, args, opt = {}) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    if (cmd === "git") {
      if (args[0] === "symbolic-ref") return ok("main\n");
      if (args[0] === "status") return ok(s.dirty ? " M lib/x.mjs\n" : "");
      if (args[0] === "fetch") return s.fetchFails-- > 0 ? { ok: false, code: 1, stdout: "", stderr: "fatal: unable to access" } : ok();
      if (args[0] === "rev-parse") return ok(`${args[1] === "origin/main" ? s.origin : s.head}\n`);
      if (args[0] === "worktree" && args[1] === "add") { writeVersion(args[3], "0.8.23"); return ok(); }
      if (args[0] === "merge") { s.onMerge?.(); s.head = args[2]; writeVersion(rt, "0.8.23"); return ok(); }
      if (args[0] === "reset") { s.head = args[2]; writeVersion(rt, "0.8.22"); return ok(); }
      return ok();
    }
    if (cmd === NODE && args[1] === "--version") {
      const v = args[0].startsWith(rt) ? (s.runnerVersion ?? JSON.parse(fs.readFileSync(path.join(rt, ".claude-plugin", "plugin.json"), "utf8")).version) : "0.8.23";
      return ok(`crew ${v}\n`);
    }
    if (cmd === NODE && args[0] === "--test") return s.testsFail ? { ok: false, code: 1, stdout: "not ok 3 - board: sessions section\n", stderr: "" } : ok("ok\n");
    if (cmd === "claude") {
      if (s.claudeMissing) return { ok: false, missing: true, code: null, stdout: "", stderr: "" };
      if (args.join(" ") === "plugin list --json") return ok(JSON.stringify([{ id: "crew@crew", version: s.plugin }]));
      if (args[1] === "update" && args[2] === "crew@crew") { const want = JSON.parse(fs.readFileSync(path.join(rt, ".claude-plugin", "plugin.json"), "utf8")).version; if (!(s.noDowngrade && want < s.plugin)) s.plugin = want; return ok(); }
      if (args[1] === "install") { s.plugin = JSON.parse(fs.readFileSync(path.join(rt, ".claude-plugin", "plugin.json"), "utf8")).version; return ok(); }
      return ok();
    }
    return { ok: false, code: 1, stdout: "", stderr: `unexpected ${line}` };
  };
  const posts = [];
  const post = async ({ config, text }) => (posts.push(`${config.slack.channel}: ${text}`), { ok: true });
  const jobs = () => [{ name: "dev.crew.proj-watch", root: project, file: "x" }, { name: "dev.crew.proj-brief", root: project, file: "y" }];
  const go = () => runUpdate({ env, platform: "darwin", run, post, jobs, machine: "mac", now: new Date(), node: NODE });
  return { env, rt, project, s, calls, posts, go, run, state: () => readUpdateState(env, "darwin") };
}

test("update: off does nothing", async () => {
  const m = machine();
  setAutoUpdate(false, { env: m.env, platform: "darwin" });
  assert.equal((await m.go()).outcome, "off");
  assert.ok(!m.calls.some((c) => c.startsWith("git")));
});

test("update: current when origin/main is unchanged", async () => {
  const m = machine({ origin: OLD });
  assert.equal((await m.go()).outcome, "current");
  assert.ok(!m.calls.some((c) => c.includes("worktree add")));
  assert.deepEqual(m.posts, []);
});

test("update: a bad sha is not retried", async () => {
  const m = machine();
  writeUpdateState({ bad: [NEW] }, m.env, "darwin");
  assert.equal((await m.go()).outcome, "bad");
  assert.ok(!m.calls.some((c) => c.includes("--test")));
});

test("update: waits while a worker runs", async () => {
  const m = machine();
  fs.mkdirSync(path.join(m.project, ".crew", "workers"), { recursive: true });
  fs.writeFileSync(path.join(m.project, ".crew", "workers", "7.json"), JSON.stringify({ issue: 7, pid: process.pid, host: os.hostname(), started: new Date().toISOString() }));
  const r = await m.go();
  assert.equal(r.outcome, "waiting");
  assert.match(r.detail, /proj #7/);
  assert.ok(!m.calls.some((c) => c.startsWith("git merge")));
  assert.deepEqual(m.posts, []);
});

test("update: a dispatch lock held by a live pid waits", async () => {
  const m = machine();
  fs.mkdirSync(path.join(m.project, ".crew"), { recursive: true });
  fs.writeFileSync(path.join(m.project, ".crew", "dispatch.lock"), JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() }));
  assert.equal((await m.go()).outcome, "waiting");
  assert.ok(!m.calls.some((c) => c.startsWith("git merge")));
});

test("update: tests fail, so the sha is bad and one alert is sent", async () => {
  const m = machine({ testsFail: true });
  assert.equal((await m.go()).outcome, "failed");
  assert.deepEqual(m.state().bad, [NEW]);
  assert.ok(!m.calls.some((c) => c.startsWith("git merge")));
  assert.equal(m.posts.length, 1);
  assert.match(m.posts[0], /^C0123ABCD: crew 0\.8\.23 failed its check on mac: .+; staying on 0\.8\.22$/);
  assert.ok(m.calls.some((c) => c.startsWith("git worktree remove")));
});

test("update: success switches, syncs the plugin and posts once", async () => {
  const m = machine();
  const r = await m.go();
  assert.equal(r.outcome, "updated");
  assert.ok(m.calls.includes(`git merge --ff-only ${NEW}`));
  assert.deepEqual([m.state().previous, m.state().current, m.state().plugin_pending], [OLD, NEW, false]);
  assert.ok(m.calls.includes("claude plugin marketplace update crew") && m.calls.includes("claude plugin update crew@crew"));
  assert.deepEqual(m.posts, ["C0123ABCD: crew 0.8.22 → 0.8.23 on mac"]);
});

test("update: post-switch --version mismatch rolls back", async () => {
  const m = machine({ runnerVersion: "0.8.22" });
  assert.equal((await m.go()).outcome, "rolled-back");
  assert.ok(m.calls.includes(`git reset --hard ${OLD}`));
  assert.deepEqual(m.state().bad, [NEW]);
  assert.equal(m.state().current, OLD);
  assert.match(m.posts.at(-1), /^C0123ABCD: crew 0\.8\.23 rolled back on mac: .+; back on 0\.8\.22$/);
});

test("update: a dirty runner is never reset", async () => {
  const m = machine({ dirty: true });
  assert.equal((await m.go()).outcome, "dirty");
  assert.ok(!m.calls.some((c) => c.startsWith("git merge") || c.startsWith("git reset")));
  assert.deepEqual(m.posts, ["C0123ABCD: crew runner on mac has local changes; not updating (see crew update status)"]);
  await m.go();
  assert.equal(m.posts.length, 1, "the same alert is not repeated every hour");
});

test("update: temporary failures alert on the third, recovery once", async () => {
  const m = machine({ fetchFails: 3, origin: OLD });
  for (let i = 0; i < 3; i++) assert.equal((await m.go()).outcome, "temporary");
  assert.equal(m.posts.length, 1);
  assert.match(m.posts[0], /^C0123ABCD: crew update on mac keeps failing: /);
  assert.equal((await m.go()).outcome, "current");
  assert.deepEqual(m.posts.slice(1), ["C0123ABCD: crew update on mac is working again"]);
  assert.equal(m.state().temp_failures, 0);
});

test("update: claude missing marks the plugin pending, next run retries", async () => {
  const m = machine({ claudeMissing: true });
  assert.equal((await m.go()).outcome, "updated");
  assert.equal(m.state().plugin_pending, true);
  assert.ok(m.posts.some((p) => /plugin update pending/.test(p)));
  m.s.claudeMissing = false;
  const n = m.calls.length;
  await m.go();
  assert.ok(m.calls.slice(n).includes("claude plugin update crew@crew"));
  assert.equal(m.state().plugin_pending, false);
});

test("update: two runs at once, the second is busy", async () => {
  const m = machine();
  fs.mkdirSync(path.join(updateHome(m.env, "darwin"), "update.lock.d"), { recursive: true });
  assert.equal((await m.go()).outcome, "busy");
});

test("update: a deleted project folder is skipped", async () => {
  const m = machine();
  fs.rmSync(m.project, { recursive: true, force: true });
  assert.equal((await m.go()).outcome, "updated");
});

test("update: the marker exists only during the switch", async () => {
  let during = null;
  const m = machine({ onMerge: () => { during = updatingNow(m.env, "darwin"); } });
  await m.go();
  assert.equal(during, true);
  assert.equal(updatingNow(m.env, "darwin"), false);
});

test("syncPlugin: downgrade falls back to reinstall", () => {
  const m = machine({ plugin: "0.8.23", noDowngrade: true });
  const r = syncPlugin({ version: "0.8.22", run: m.run });
  assert.equal(r.ok, true);
  const i = m.calls.indexOf("claude plugin uninstall crew@crew");
  assert.ok(i > 0 && m.calls[i + 1] === "claude plugin install crew@crew", m.calls.join("\n"));
});

test("rollbackUpdate: back to previous, failed sha marked bad", () => {
  const m = machine();
  writeUpdateState({ current: NEW, previous: OLD }, m.env, "darwin");
  const r = rollbackUpdate({ env: m.env, platform: "darwin", run: m.run, reason: "by hand" });
  assert.deepEqual(r, { ok: true, to: OLD });
  assert.deepEqual([m.state().current, m.state().bad], [OLD, [NEW]]);
});
