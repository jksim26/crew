// `crew update`: keep this machine's crew current. Scheduled jobs and the Claude plugin both run from a
// runner-only clone (never a folder people work in) that an hourly job moves forward to origin/main:
// at a safe moment, after the new version passed its own tests, with rollback and one Slack line per
// change. See docs/superpowers/specs/2026-11-14-auto-update-design.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJson, writeJson, liveWorkers } from "./state.mjs";
import { run as realRun } from "./exec.mjs";
import { loadConfig } from "./config.mjs";
import { postNews } from "./slack.mjs";
import { thisMachine } from "./machine.mjs";
import { crewJobs } from "./schedule.mjs";
import { readLocal, saveLocal } from "./secrets.mjs";

export const AUTO_UPDATE_KEY = "CREW_AUTO_UPDATE";
const MARKER_MS = 5 * 60_000;

/** Machine-local home for the runner clone and its state: local app data, never roaming or synced. */
export function updateHome(env = process.env, platform = process.platform) {
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "crew");
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "crew");
}
export const runnerDir = (env = process.env, platform = process.platform) => path.join(updateHome(env, platform), "runtime");
const stateFile = (env, platform) => path.join(updateHome(env, platform), "update.json");
const markerFile = (env, platform) => path.join(updateHome(env, platform), "updating");

const DEFAULT_STATE = Object.freeze({ current: null, previous: null, bad: [], last_check: null, last_result: null, temp_failures: 0, plugin_pending: false });

export function readUpdateState(env = process.env, platform = process.platform) {
  const s = readJson(stateFile(env, platform), {});
  return { ...DEFAULT_STATE, ...s, bad: Array.isArray(s.bad) ? s.bad : [] };
}
export function writeUpdateState(state, env = process.env, platform = process.platform) {
  writeJson(stateFile(env, platform), { ...DEFAULT_STATE, ...state });
}

/** On unless this machine said `crew update off`. */
export const autoUpdateOn = (env = process.env, platform = process.platform) => readLocal(AUTO_UPDATE_KEY, env, platform) !== "off";
export function setAutoUpdate(on, { env = process.env, platform = process.platform } = {}) {
  saveLocal(AUTO_UPDATE_KEY, on ? "on" : "off", { env, platform });
}

/** While the runner clone is being switched, watch and dispatch skip their tick (at most 5 minutes). */
export function markUpdating(env = process.env, platform = process.platform, now = new Date()) {
  fs.mkdirSync(updateHome(env, platform), { recursive: true });
  fs.writeFileSync(markerFile(env, platform), now.toISOString(), "utf8");
}
export function clearUpdating(env = process.env, platform = process.platform) {
  fs.rmSync(markerFile(env, platform), { force: true });
}
export function updatingNow(env = process.env, platform = process.platform, now = Date.now()) {
  try {
    const at = Date.parse(fs.readFileSync(markerFile(env, platform), "utf8").trim());
    return now - at < MARKER_MS && now >= at - MARKER_MS;
  } catch {
    return false;
  }
}

// ---- the update run -----------------------------------------------------------------------------
const pluginVersion = (dir) => readJson(path.join(dir, ".claude-plugin", "plugin.json"), {}).version ?? null;
const first = (s) => String(s ?? "").trim().split(/\r?\n/).find(Boolean) ?? "";
const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

/** Bring the installed plugin to `version`: update, and reinstall when update will not go down a version. */
export function syncPlugin({ version, run = realRun }) {
  const claude = (...args) => run("claude", args, { timeoutMs: 120_000 });
  const installed = () => {
    const r = claude("plugin", "list", "--json");
    try { return JSON.parse(r.stdout).find((p) => p.id === "crew@crew")?.version ?? null; } catch { return null; }
  };
  const m = claude("plugin", "marketplace", "update", "crew");
  if (!m.ok) return { ok: false, detail: m.missing ? "claude not found on PATH" : `marketplace update failed: ${first(m.stderr || m.stdout)}` };
  claude("plugin", "update", "crew@crew");
  if (installed() === version) return { ok: true, detail: `plugin ${version}` };
  claude("plugin", "uninstall", "crew@crew");
  claude("plugin", "install", "crew@crew");
  const got = installed();
  return got === version ? { ok: true, detail: `plugin ${version} (reinstalled)` } : { ok: false, detail: `plugin is ${got ?? "missing"}, wanted ${version}` };
}

/** One line to each distinct Slack channel among this machine's crew projects that post news. */
export async function notify(text, { jobs = crewJobs, post = postNews, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const seen = new Set();
  for (const root of [...new Set(jobs().map((j) => j.root))]) {
    let config;
    try { config = loadConfig(root); } catch { continue; } // folder or config gone
    const ch = config.slack?.news ? config.slack.channel : null;
    if (!ch || seen.has(ch)) continue;
    seen.add(ch);
    await post({ config, text, env, fetchImpl });
  }
}

/** Move the runner clone back to the previous good commit, the plugin with it; the failed commit is marked bad. */
export function rollbackUpdate({ env = process.env, platform = process.platform, run = realRun, reason = "" } = {}) {
  const st = readUpdateState(env, platform);
  if (!st.previous) return { ok: false, to: null };
  const rt = runnerDir(env, platform);
  const failed = st.current;
  const r = run("git", ["reset", "--hard", st.previous], { cwd: rt });
  if (!r.ok) return { ok: false, to: null };
  const p = syncPlugin({ version: pluginVersion(rt), run });
  writeUpdateState({ ...st, current: st.previous, previous: failed, bad: failed && !st.bad.includes(failed) ? [...st.bad, failed] : st.bad,
    plugin_pending: !p.ok, last_result: `rolled back${reason ? `: ${reason}` : ""}` }, env, platform);
  return { ok: true, to: st.previous };
}

/** Is anything running on this machine that the switch would pull the code from under? */
function busyWith(jobs) {
  for (const root of [...new Set(jobs().map((j) => j.root))]) {
    if (!fs.existsSync(root)) continue;
    const w = liveWorkers(root).find((x) => x.host === os.hostname());
    if (w) return `${path.basename(root)} #${w.issue}`;
    const lock = readJson(path.join(root, ".crew", "dispatch.lock"), null);
    if (lock?.pid && lock.host === os.hostname() && isAlive(lock.pid)) return `${path.basename(root)} dispatch`;
  }
  return null;
}

/**
 * One hourly update: fetch, wait for a safe moment, test the candidate in its own worktree, switch,
 * check, sync the plugin, report. Only a failing test or a wrong --version marks a commit bad.
 */
export async function runUpdate({ env = process.env, platform = process.platform, run = realRun, now = new Date(), post = postNews, fetchImpl = globalThis.fetch,
  jobs = () => crewJobs({ platform, run }), machine = thisMachine(env), node = process.execPath } = {}) {
  if (!autoUpdateOn(env, platform)) return { outcome: "off" };
  const home = updateHome(env, platform);
  const rt = runnerDir(env, platform);
  const who = machine ?? os.hostname();
  const say = (text) => notify(text, { jobs, post, env, fetchImpl });
  const git = (args, cwd = rt, timeoutMs = 120_000) => run("git", args, { cwd, timeoutMs });

  // One run at a time: a slow test run must not overlap the next hourly start.
  const lockDir = path.join(home, "update.lock.d");
  fs.mkdirSync(home, { recursive: true });
  try { fs.mkdirSync(lockDir); } catch (e) {
    if (e.code !== "EEXIST") throw e;
    let age = 0;
    try { age = Date.now() - fs.statSync(lockDir).mtimeMs; } catch { /* gone */ }
    if (age < 30 * 60_000) return { outcome: "busy" };
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.mkdirSync(lockDir);
  }
  let st = readUpdateState(env, platform);
  const save = (patch) => { st = { ...st, ...patch, last_check: now.toISOString() }; writeUpdateState(st, env, platform); };
  const temporary = async (detail) => {
    const n = st.temp_failures + 1;
    save({ temp_failures: n, last_result: `temporary: ${detail}` });
    if (n === 3) await say(`crew update on ${who} keeps failing: ${detail}`);
    return { outcome: "temporary", detail };
  };
  try {
    // The runner must be ours: clean and on main. Crew never resets or stashes someone's edits here.
    const branch = git(["symbolic-ref", "--short", "-q", "HEAD"]);
    const dirty = git(["status", "--porcelain"]);
    if (!branch.ok || branch.stdout.trim() !== "main" || !dirty.ok || dirty.stdout.trim()) {
      if (st.last_result !== "dirty") await say(`crew runner on ${who} has local changes; not updating (see crew update status)`);
      save({ last_result: "dirty" });
      return { outcome: "dirty", detail: branch.ok && branch.stdout.trim() !== "main" ? `runner is on ${branch.stdout.trim() || "a detached HEAD"}` : "runner has local changes" };
    }
    const f = git(["fetch", "--quiet", "origin", "main"]);
    if (!f.ok) return await temporary(`git fetch failed: ${first(f.stderr)}`);
    if (st.temp_failures >= 3) await say(`crew update on ${who} is working again`);
    if (st.temp_failures) save({ temp_failures: 0 });
    const head = git(["rev-parse", "HEAD"]).stdout.trim();
    const target = git(["rev-parse", "origin/main"]).stdout.trim();
    const from = pluginVersion(rt);

    if (target === head) {
      if (st.plugin_pending) {
        const p = syncPlugin({ version: from, run });
        save({ plugin_pending: !p.ok, current: head });
      } else save({ current: head, last_result: "current" });
      return { outcome: "current", detail: from };
    }
    if (st.bad.includes(target)) { save({ last_result: "bad" }); return { outcome: "bad", detail: target.slice(0, 7) }; }

    const busy = busyWith(jobs);
    if (busy) { save({ last_result: `waiting for ${busy}` }); return { outcome: "waiting", detail: busy }; }

    // Test the candidate in its own worktree before anything switches.
    const cand = fs.mkdtempSync(path.join(home, "candidate-"));
    fs.rmSync(cand, { recursive: true, force: true });
    const add = git(["worktree", "add", "--detach", cand, target]);
    if (!add.ok) return await temporary(`git worktree add failed: ${first(add.stderr)}`);
    let to;
    let failure = null;
    try {
      to = pluginVersion(cand);
      const v = run(node, [path.join(cand, "bin", "crew"), "--version"], { cwd: cand, timeoutMs: 60_000 });
      if (!v.ok || !String(v.stdout).includes(`crew ${to}`)) failure = `--version printed "${first(v.stdout || v.stderr)}", wanted crew ${to}`;
      else {
        const t = run(node, ["--test"], { cwd: cand, timeoutMs: 600_000 });
        if (t.timedOut) return await temporary("tests timed out after 10 minutes");
        if (!t.ok) failure = first(String(t.stdout).split(/\r?\n/).find((l) => /^not ok/.test(l)) ?? t.stderr) || "tests failed";
      }
    } finally {
      git(["worktree", "remove", "--force", cand]);
      fs.rmSync(cand, { recursive: true, force: true });
    }
    if (failure) {
      save({ bad: [...st.bad, target], last_result: `failed: ${failure}` });
      await say(`crew ${to} failed its check on ${who}: ${failure}; staying on ${from}`);
      return { outcome: "failed", detail: failure };
    }

    // Switch: watch and dispatch skip their tick while the marker is up.
    markUpdating(env, platform, now);
    let m;
    try { m = git(["merge", "--ff-only", target]); } finally { clearUpdating(env, platform); }
    if (!m.ok) return await temporary(`fast-forward failed: ${first(m.stderr)}`);
    save({ previous: head, current: target });
    const after = run(node, [path.join(rt, "bin", "crew"), "--version"], { cwd: rt, timeoutMs: 60_000 });
    if (!after.ok || !String(after.stdout).includes(`crew ${to}`)) {
      const reason = `--version printed "${first(after.stdout || after.stderr)}" after the switch`;
      rollbackUpdate({ env, platform, run, reason });
      st = readUpdateState(env, platform);
      await say(`crew ${to} rolled back on ${who}: ${reason}; back on ${from}`);
      return { outcome: "rolled-back", detail: reason };
    }
    const p = syncPlugin({ version: to, run });
    save({ plugin_pending: !p.ok, last_result: `updated ${from} -> ${to}` });
    await say(`crew ${from} → ${to} on ${who}`);
    if (!p.ok) await say(`crew ${to} on ${who}: plugin update pending (${p.detail})`);
    return { outcome: "updated", from, to };
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}
