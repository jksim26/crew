import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordSessionEvent, liveSessions, clearSessions, sessionsDir, findCrewRoot } from "../lib/sessions.mjs";
import { claudeEnv } from "../lib/pm.mjs";

const NOW = new Date("2026-11-13T12:00:00Z");
const later = (min) => new Date(NOW.getTime() + min * 60_000);

function repo() {
  const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "crew-sess-")));
  fs.mkdirSync(path.join(r, ".git"));
  fs.mkdirSync(path.join(r, ".claude"));
  fs.writeFileSync(path.join(r, ".claude", "crew.json"), JSON.stringify({ repo: "jk/proj", owner_login: "jk" }));
  return r;
}
/** git rev-parse --show-toplevel answers with the cwd it is asked in. */
const run = (cmd, args, o = {}) => (cmd === "git" && args.includes("--show-toplevel") ? { ok: true, stdout: `${o.cwd}\n` } : { ok: false, stdout: "" });
const env = {};
const rec = (event, input, now = NOW) => recordSessionEvent({ event, input, env, now, run });
const file = (root, id) => path.join(sessionsDir(root), `${id}.json`);
const read = (root, id) => JSON.parse(fs.readFileSync(file(root, id), "utf8"));

test("recordSessionEvent: skips non-crew folders", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crew-plain-"));
  const r = rec("SessionStart", { session_id: "a", cwd });
  assert.equal(r.action, "skip");
  assert.equal(fs.existsSync(path.join(cwd, ".crew")), false);
});

test("recordSessionEvent: skips crew's own runs", () => {
  const root = repo();
  const r = recordSessionEvent({ event: "SessionStart", input: { session_id: "a", cwd: root }, env: { CREW_AGENT: "1" }, now: NOW, run });
  assert.equal(r.action, "skip");
  assert.equal(fs.existsSync(sessionsDir(root)), false);
});

test("recordSessionEvent: start, edit, resume, end", () => {
  const root = repo();
  assert.equal(rec("SessionStart", { session_id: "a", cwd: root, source: "startup" }).action, "written");
  const s0 = read(root, "a");
  assert.deepEqual([s0.id, s0.host, s0.cwd, s0.worktree, s0.files], ["a", os.hostname(), root, null, []]);
  const edit = { session_id: "a", cwd: root, tool_name: "Edit", tool_input: { file_path: path.join(root, "lib", "a.mjs") } };
  rec("PostToolUse", edit, later(1));
  rec("PostToolUse", edit, later(2));
  assert.deepEqual(read(root, "a").files, ["lib/a.mjs"]);
  rec("SessionStart", { session_id: "a", cwd: root, source: "resume" }, later(5));
  const s1 = read(root, "a");
  assert.equal(s1.started, s0.started);
  assert.deepEqual(s1.files, ["lib/a.mjs"]);
  assert.equal(s1.updated, later(5).toISOString());
  const end = rec("SessionEnd", { session_id: "a", cwd: root });
  assert.equal(end.action, "deleted");
  assert.equal(fs.existsSync(file(root, "a")), false);
});

test("recordSessionEvent: a notebook edit counts", () => {
  const root = repo();
  rec("PostToolUse", { session_id: "n", cwd: root, tool_name: "NotebookEdit", tool_input: { notebook_path: path.join(root, "nb", "x.ipynb") } });
  assert.deepEqual(read(root, "n").files, ["nb/x.ipynb"]);
});

test("recordSessionEvent: an edit outside the repo refreshes but adds nothing", () => {
  const root = repo();
  rec("SessionStart", { session_id: "a", cwd: root });
  rec("PostToolUse", { session_id: "a", cwd: root, tool_name: "Write", tool_input: { file_path: path.join(os.tmpdir(), "x") } }, later(3));
  const s = read(root, "a");
  assert.deepEqual(s.files, []);
  assert.equal(s.updated, later(3).toISOString());
});

test("recordSessionEvent: two sessions in one folder stay apart", () => {
  const root = repo();
  rec("PostToolUse", { session_id: "a", cwd: root, tool_name: "Edit", tool_input: { file_path: path.join(root, "a.txt") } });
  rec("PostToolUse", { session_id: "b", cwd: root, tool_name: "Edit", tool_input: { file_path: path.join(root, "b.txt") } });
  assert.deepEqual(read(root, "a").files, ["a.txt"]);
  assert.deepEqual(read(root, "b").files, ["b.txt"]);
});

test("recordSessionEvent: a worktree session lands in the main checkout", () => {
  const root = repo();
  const wt = path.join(root, ".claude", "worktrees", "x");
  fs.mkdirSync(path.join(wt, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(wt, ".claude", "crew.json"), "{}");
  fs.mkdirSync(path.join(root, ".git", "worktrees", "x"), { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(root, ".git", "worktrees", "x")}\n`);
  assert.equal(findCrewRoot(path.join(wt)), root);
  rec("PostToolUse", { session_id: "w", cwd: wt, tool_name: "Edit", tool_input: { file_path: path.join(wt, "lib", "z.mjs") } });
  const s = read(root, "w");
  assert.equal(s.worktree, wt);
  assert.deepEqual(s.files, ["lib/z.mjs"]);
});

test("recordSessionEvent: an event with no session id is skipped", () => {
  const root = repo();
  assert.equal(rec("SessionStart", { cwd: root }).action, "skip");
});

test("liveSessions: expires quiet sessions on this host only", () => {
  const root = repo();
  const dir = sessionsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const put = (id, host, minsAgo) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, host, started: NOW.toISOString(), updated: new Date(NOW.getTime() - minsAgo * 60_000).toISOString(), files: [] }));
  put("old", os.hostname(), 180);
  put("fresh", os.hostname(), 5);
  put("remote", "other", 180);
  const live = liveSessions(root, { now: NOW.getTime() });
  assert.deepEqual(live.map((s) => s.id), ["fresh"]);
  assert.equal(fs.existsSync(path.join(dir, "old.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "remote.json")), true);
  assert.deepEqual(liveSessions(root, { now: NOW.getTime(), quietMin: 2 }), []);
});

test("clearSessions: one or all", () => {
  const root = repo();
  rec("SessionStart", { session_id: "a", cwd: root });
  rec("SessionStart", { session_id: "b", cwd: root });
  assert.equal(clearSessions(root, "a"), 1);
  assert.equal(fs.existsSync(file(root, "b")), true);
  assert.equal(clearSessions(root), 1);
  assert.equal(fs.existsSync(file(root, "b")), false);
});

test("claudeEnv sets CREW_AGENT", () => {
  assert.equal(claudeEnv({}).CREW_AGENT, "1");
});

// ---- CLI: crew session-hook / crew sessions ------------------------------------------------
import { main } from "../lib/cli.mjs";
const sink = () => ({ data: "", write(s) { this.data += s; } });
async function cli(argv, stdin = "") {
  const out = sink(), err = sink();
  const code = await main(argv, { stdout: out, stderr: err, readStdin: () => stdin });
  return { code, out: out.data, err: err.data };
}

test("session-hook: prints the id on SessionStart only", async () => {
  const root = repo();
  const start = await cli(["session-hook", "SessionStart"], JSON.stringify({ session_id: "s1", cwd: root, source: "startup" }));
  assert.equal(start.code, 0);
  assert.deepEqual(JSON.parse(start.out), { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "crew session id: s1" } });
  const prompt = await cli(["session-hook", "UserPromptSubmit"], JSON.stringify({ session_id: "s1", cwd: root }));
  assert.deepEqual([prompt.code, prompt.out, prompt.err], [0, "", ""]);
});

test("session-hook: bad stdin exits 0 silently", async () => {
  const r = await cli(["session-hook", "SessionStart"], "not json");
  assert.deepEqual([r.code, r.out, r.err], [0, "", ""]);
});

test("session-hook: an error is logged in the repo, never shown", async () => {
  const root = repo();
  fs.mkdirSync(path.join(root, ".crew", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(root, ".crew", "sessions", "s2.json"), "{}"); // a file with no files list
  fs.chmodSync(path.join(root, ".crew", "sessions"), 0o500); // the write fails
  const r = await cli(["session-hook", "UserPromptSubmit"], JSON.stringify({ session_id: "s2", cwd: root }));
  fs.chmodSync(path.join(root, ".crew", "sessions"), 0o700);
  assert.deepEqual([r.code, r.out, r.err], [0, "", ""]);
  assert.match(fs.readFileSync(path.join(root, ".crew", "logs", "session-hook.log"), "utf8"), /"event":"UserPromptSubmit"/);
});

test("sessions: lists and clears", async () => {
  const root = repo();
  rec("PostToolUse", { session_id: "aaaaaaaa-1", cwd: root, tool_name: "Edit", tool_input: { file_path: path.join(root, "x.txt") } }, new Date());
  rec("SessionStart", { session_id: "bbbbbbbb-2", cwd: root }, new Date());
  const here = process.cwd();
  process.chdir(root);
  try {
    const list = await cli(["sessions"]);
    assert.equal(list.code, 0);
    const lines = list.out.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^aaaaaaaa\t.+\tmain\topen 0m\tactive 0m ago\t1 files$/);
    assert.equal(JSON.parse((await cli(["sessions", "--json"])).out).length, 2);
    assert.equal((await cli(["sessions", "clear"])).code, 1);
    assert.equal((await cli(["sessions", "clear", "--all"])).code, 0);
    assert.equal((await cli(["sessions"])).out, "no sessions open on this machine\n");
    const w = JSON.parse((await cli(["workers", "--json"])).out);
    assert.deepEqual(w, { workers: [], sessions: [] });
  } finally {
    process.chdir(here);
  }
});

test("hooks.json is valid and covers the four events", () => {
  const h = JSON.parse(fs.readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8")).hooks;
  assert.deepEqual(Object.keys(h).sort(), ["PostToolUse", "SessionEnd", "SessionStart", "UserPromptSubmit"]);
  assert.equal(h.PostToolUse[0].matcher, "Edit|Write|MultiEdit|NotebookEdit");
  for (const [event, groups] of Object.entries(h)) for (const g of groups) for (const x of g.hooks) {
    assert.equal(x.type, "command");
    assert.ok(x.command.includes('"${CLAUDE_PLUGIN_ROOT}/bin/crew" session-hook ' + event), x.command);
    assert.equal(x.timeout, 10);
  }
});
