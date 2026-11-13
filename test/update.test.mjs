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

// ---- setup, status, exit codes, doctor checks --------------------------------------------------
import { setupUpdate, updateStatus, updateExit, updateChecks } from "../lib/update.mjs";
import { launchdPlist } from "../lib/schedule.mjs";

function setupWorld() {
  const dir = tmp();
  const env = envFor(dir);
  const home = path.join(dir, "home");
  const la = path.join(home, "Library", "LaunchAgents");
  fs.mkdirSync(la, { recursive: true });
  fs.writeFileSync(path.join(la, "dev.crew.proj-watch.plist"), launchdPlist({ label: "dev.crew.proj-watch", root: path.join(dir, "proj"), args: ["watch"], when: { every: 10 }, envPath: "/bin", logFile: "/l", node: "/n/node", bin: "/old/crew/bin/crew" }));
  const rt = runnerDir(env, "darwin");
  const s = { marketplace: "/Users/x/code/crew", dirty: false, branch: "main" };
  const calls = [];
  const ok = (stdout = "") => ({ ok: true, code: 0, stdout, stderr: "" });
  const run = (cmd, args) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    if (cmd === "git" && args[0] === "clone") { fs.mkdirSync(path.join(args[2], "bin"), { recursive: true }); fs.writeFileSync(path.join(args[2], "bin", "crew"), ""); return ok(); }
    if (cmd === "git" && args[0] === "symbolic-ref") return ok(`${s.branch}\n`);
    if (cmd === "git" && args[0] === "status") return ok(s.dirty ? " M x\n" : "");
    if (cmd === "git" && args[0] === "rev-parse") return ok("c".repeat(40) + "\n");
    if (cmd === "claude" && args.join(" ") === "plugin marketplace list --json") return ok(JSON.stringify([{ name: "crew", source: "directory", path: s.marketplace }]));
    if (cmd === "claude" && args[1] === "marketplace" && args[2] === "add") { s.marketplace = args[3]; return ok(); }
    if (cmd === "id") return ok("501\n");
    return ok();
  };
  const go = () => setupUpdate({ env, platform: "darwin", run, origin: "git@github.com:jk/crew.git", home });
  return { dir, env, home, la, rt, s, calls, run, go };
}

test("setupUpdate: fresh machine", () => {
  const w = setupWorld();
  const r = w.go();
  assert.deepEqual(r.steps.map((x) => x.done), ["made", "made", "made", "made", "made"]);
  assert.ok(w.calls.includes(`git clone git@github.com:jk/crew.git ${w.rt}`));
  const mk = ["claude plugin marketplace remove crew", `claude plugin marketplace add ${w.rt}`, "claude plugin install crew@crew"].map((c) => w.calls.indexOf(c));
  assert.ok(mk.every((i) => i >= 0) && mk[0] < mk[1] && mk[1] < mk[2], w.calls.join("\n"));
  assert.ok(fs.readFileSync(path.join(w.la, "dev.crew.proj-watch.plist"), "utf8").includes(`<string>${path.join(w.rt, "bin", "crew")}</string>`));
  assert.ok(fs.existsSync(path.join(w.la, "dev.crew.update.plist")));
  assert.equal(readUpdateState(w.env, "darwin").current, "c".repeat(40));
});

test("setupUpdate: re-run is safe", () => {
  const w = setupWorld();
  w.go();
  const n = w.calls.length;
  assert.deepEqual(w.go().steps.map((x) => x.done), ["already", "already", "already", "already", "already"]);
  assert.ok(!w.calls.slice(n).some((c) => c.startsWith("git clone") || c.includes("marketplace add") || c.startsWith("launchctl bootstrap")));
});

test("setupUpdate: refuses a dirty runner", () => {
  const w = setupWorld();
  w.go();
  w.s.dirty = true;
  assert.throws(() => w.go(), /runner .* has local changes/);
});

test("updateExit: failures the scheduler should show exit 1", () => {
  for (const o of ["failed", "rolled-back", "dirty"]) assert.equal(updateExit(o), 1, o);
  for (const o of ["updated", "current", "waiting", "busy", "off", "bad", "temporary"]) assert.equal(updateExit(o), 0, o);
});

test("updateStatus: auto-update off and on", () => {
  const w = setupWorld();
  setAutoUpdate(false, { env: w.env, platform: "darwin" });
  assert.match(updateStatus({ env: w.env, platform: "darwin", run: w.run }), /auto-update off/);
  setAutoUpdate(true, { env: w.env, platform: "darwin" });
  const s = updateStatus({ env: w.env, platform: "darwin", run: w.run });
  assert.match(s, /auto-update on/);
  assert.match(s, /runner\s+not set up \(run: crew update setup\)/);
});

test("updateChecks: warns when jobs run outside the runner", () => {
  const w = setupWorld();
  const checks = updateChecks({ env: w.env, platform: "darwin", run: w.run, home: w.home });
  const runner = checks.find((c) => c.name === "runner");
  assert.equal(runner.status, "warn");
  assert.match(runner.detail, /crew update setup/);
  assert.ok(checks.every((c) => c.status !== "fail"));
  w.go();
  const after = updateChecks({ env: w.env, platform: "darwin", run: w.run, home: w.home });
  assert.equal(after.find((c) => c.name === "runner").status, "ok");
  assert.equal(after.find((c) => c.name === "plugin source").status, "ok");
});

// ---- final-review fixes -------------------------------------------------------------------------
test("fix: a worker that starts during the test run stops the switch", async () => {
  const m = machine();
  const orig = m.run;
  const run = (cmd, args, opt) => {
    if (cmd === NODE && args[0] === "--test") {
      fs.mkdirSync(path.join(m.project, ".crew", "workers"), { recursive: true });
      fs.writeFileSync(path.join(m.project, ".crew", "workers", "9.json"), JSON.stringify({ issue: 9, pid: process.pid, host: os.hostname(), started: new Date().toISOString() }));
    }
    return orig(cmd, args, opt);
  };
  const r = await runUpdate({ env: m.env, platform: "darwin", run, post: async () => ({ ok: true }), jobs: () => [{ name: "w", root: m.project, file: "x" }], machine: "mac", node: NODE });
  assert.equal(r.outcome, "waiting");
  assert.ok(!m.calls.some((c) => c.startsWith("git merge")));
  assert.equal(updatingNow(m.env, "darwin"), false);
});

test("fix: plugin_pending is saved before the plugin sync starts", async () => {
  const m = machine();
  const orig = m.run;
  const run = (cmd, args, opt) => {
    if (cmd === "claude" && args[1] === "marketplace") throw new Error("killed mid-sync");
    return orig(cmd, args, opt);
  };
  await assert.rejects(runUpdate({ env: m.env, platform: "darwin", run, post: async () => ({ ok: true }), jobs: () => [], machine: "mac", node: NODE }), /killed mid-sync/);
  assert.equal(readUpdateState(m.env, "darwin").plugin_pending, true);
});

test("fix: no runner yet is not reported as local changes", async () => {
  const dir = tmp();
  const env = envFor(dir);
  const posts = [];
  const r = await runUpdate({ env, platform: "darwin", run: () => ({ ok: false, stdout: "", stderr: "not a git repository" }), post: async ({ text }) => (posts.push(text), { ok: true }), jobs: () => [], machine: "mac", node: NODE });
  assert.equal(r.outcome, "not-set-up");
  assert.deepEqual(posts, []);
});

test("fix: rollback by hand refuses a dirty runner and never goes back to a bad commit", () => {
  const m = machine();
  writeUpdateState({ current: NEW, previous: OLD }, m.env, "darwin");
  assert.deepEqual(rollbackUpdate({ env: m.env, platform: "darwin", run: m.run, reason: "by hand" }), { ok: true, to: OLD });
  const again = rollbackUpdate({ env: m.env, platform: "darwin", run: m.run, reason: "by hand" });
  assert.equal(again.ok, false);
  assert.match(again.why, /bad/);
  assert.equal(m.calls.filter((c) => c.startsWith("git reset")).length, 1);
  const d = machine({ dirty: true });
  writeUpdateState({ current: NEW, previous: OLD }, d.env, "darwin");
  const r = rollbackUpdate({ env: d.env, platform: "darwin", run: d.run, reason: "by hand" });
  assert.equal(r.ok, false);
  assert.ok(!d.calls.some((c) => c.startsWith("git reset")));
});

test("fix: setup waits while work is running", () => {
  const w = setupWorld();
  const proj = path.join(w.dir, "proj");
  fs.mkdirSync(path.join(proj, ".crew", "workers"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".crew", "workers", "4.json"), JSON.stringify({ issue: 4, pid: process.pid, host: os.hostname(), started: new Date().toISOString() }));
  assert.throws(() => w.go(), /running .*proj #4/);
  assert.ok(!w.calls.some((c) => c.startsWith("launchctl bootout")));
});

test("fix: setup skips a job whose project folder is gone", () => {
  const w = setupWorld();
  const gone = path.join(w.dir, "gone", ".crew", "schedule", "gone-watch.ps1");
  const r = setupUpdate({ env: w.env, platform: "darwin", run: w.run, origin: "o", home: w.home, jobs: () => [{ name: "dev.crew.gone-watch", root: path.join(w.dir, "gone"), file: gone }] });
  assert.equal(r.steps.find((s) => s.step === "jobs use the runner").done, "already");
});
