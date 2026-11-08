import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalize, validate } from "../lib/config.mjs";
import { installJob, windowsScript } from "../lib/schedule.mjs";
import { addProject, parseKeyValues } from "../lib/project.mjs";
import { parseCommand, runCommands } from "../lib/commands.mjs";
import { readState } from "../lib/brief.mjs";

const base = { repo: "jk/proj", owner_login: "jk" };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---- no-admin scheduling ---------------------------------------------------------------------
test("windows: S4U by default, Interactive when asked", () => {
  const args = { taskName: "t", root: "C:\\r", args: ["watch"], when: { every: 10 }, logFile: "C:\\r\\w.log", limitMin: 5, node: "n", bin: "b" };
  assert.match(windowsScript(args), /-LogonType S4U/);
  assert.match(windowsScript({ ...args, logon: "interactive" }), /-LogonType Interactive/);
});

test("installJob auto: falls back to an Interactive task when S4U is refused for want of admin", () => {
  const dir = tmp("crew-sched-");
  const texts = [];
  const plan = { platform: "win32", name: "t", logFile: path.join(dir, "l", "x.log"), file: path.join(dir, "s", "t.ps1"),
    text: "S4U", textFor: (k) => (k === "interactive" ? "INTERACTIVE" : "S4U") };
  const run = (cmd, args) => {
    texts.push(fs.readFileSync(plan.file, "utf8"));
    return texts.length === 1 ? { ok: false, stderr: "Register-ScheduledTask : Access is denied. (0x80070005)" } : { ok: true, stdout: "registered" };
  };
  assert.deepEqual(installJob(plan, run), { logon: "interactive" });
  assert.deepEqual(texts, ["S4U", "INTERACTIVE"]);
  // explicit s4u never falls back, and says how to register without admin
  let n = 0;
  assert.throws(() => installJob(plan, () => (n++, { ok: false, stderr: "Access is denied" }), { logon: "s4u" }), /--logon interactive/);
  assert.equal(n, 1);
});

// ---- project add -----------------------------------------------------------------------------
function fakeWorld() {
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    if (line.startsWith("gh repo clone")) {
      fs.mkdirSync(path.join(args[3], ".git"), { recursive: true });
      return { ok: true, stdout: "" };
    }
    if (line.startsWith("git remote get-url")) return { ok: true, stdout: `git@github.com:${opts.cwd?.endsWith("other") ? "jk/other" : "jk/newproj"}.git\n` };
    if (line.startsWith("git symbolic-ref --short refs/remotes/origin/HEAD")) return { ok: true, stdout: "origin/main\n" };
    if (line.startsWith("git symbolic-ref --short -q HEAD")) return { ok: true, stdout: "main\n" };
    if (line.startsWith("git rev-list --count")) return { ok: true, stdout: "0\n" };
    if (line.startsWith("gh api user")) return { ok: true, stdout: "jk\n" };
    if (line.startsWith("git diff --cached --quiet")) return { ok: false, code: 1, stdout: "" }; // something staged
    return { ok: true, stdout: "" };
  };
  return { run, calls };
}

test("project add: clone, config copied from the current project, setup commit, labels, doctor, four jobs", async () => {
  const parent = tmp("crew-proj-");
  const dir = path.join(parent, "newproj");
  const like = normalize({ ...base, machines: { main: "pc", helpers: ["mac"] }, slack: { channel: "C0OLD1234", news: false }, caps: { daily_budget_usd: 30 } });
  const w = fakeWorld();
  const installed = [];
  const r = await addProject({ repo: "jk/newproj", dir, like, slackChannel: null, flags: { roles: "ops" }, run: w.run,
    install: (plan) => (installed.push(plan.name), { logon: "interactive" }), doctorFn: () => ({ checks: [{ name: "node", status: "ok" }] }) });
  assert.equal(r.failed, false);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "crew.json"), "utf8"));
  assert.equal(cfg.repo, "jk/newproj");
  assert.deepEqual(cfg.machines, { main: "pc", helpers: ["mac"] });
  assert.equal(cfg.caps.daily_budget_usd, 30);
  assert.equal(cfg.slack, undefined); // no channel given: no Slack, never the old project's channel
  assert.deepEqual(cfg.roles, ["ops"]);
  assert.match(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), /^\.crew\/$/m);
  assert.ok(w.calls.some((c) => c.startsWith("git push --quiet origin HEAD:refs/heads/main")));
  assert.ok(w.calls.some((c) => c.startsWith("gh label create ready")));
  assert.deepEqual(installed, ["newproj-sync", "newproj-watch", "newproj-brief", "newproj-brief-weekly"].map((n) => (process.platform === "win32" ? n : `dev.crew.${n}`)));
  assert.match(r.steps.find((s) => s.step === "job watch").outcome, /logged in/);

  // second run: everything already there
  const again = await addProject({ repo: "jk/newproj", dir, like, run: w.run, schedule: false, doctorFn: () => ({ checks: [] }) });
  assert.match(again.steps.find((s) => s.step === "clone").outcome, /reused .*sync: up-to-date/);
  assert.match(again.steps.find((s) => s.step === "config").outcome, /already/);
});

test("project add: a doctor failure stops before scheduling; bad input is refused", async () => {
  const w = fakeWorld();
  const dir = path.join(tmp("crew-proj-"), "p");
  let scheduled = 0;
  const r = await addProject({ repo: "jk/p", dir, run: w.run, install: () => (scheduled++, {}), doctorFn: () => ({ checks: [{ name: "gh auth", status: "fail", detail: "not logged in" }] }) });
  assert.equal(r.failed, true);
  assert.equal(scheduled, 0);
  await assert.rejects(addProject({ repo: "nope", dir }), /owner\/name/);
  await assert.rejects(addProject({ repo: "jk/p" }), /--dir/);
  assert.deepEqual(parseKeyValues(["repo=jk/x", "--dir=X:\\Claude\\X", "junk"]), { repo: "jk/x", dir: "X:\\Claude\\X" });
});

// ---- Slack command bridge --------------------------------------------------------------------
test("parseCommand: fixed argv per command, never a shell, never ready", () => {
  assert.deepEqual(parseCommand("crew brief").argv, ["brief", "--force"]);
  assert.deepEqual(parseCommand("<@U999> *crew* review").argv, ["review"]);
  assert.deepEqual(parseCommand("crew project add repo=jk/x channel=C0ABC1234 dir=X:\\Claude\\X").argv,
    ["project", "add", "--repo", "jk/x", "--slack-channel", "C0ABC1234", "--dir", "X:\\Claude\\X"]);
  assert.match(parseCommand("crew queue set 5 ready").error, /only `crew queue next`/);
  assert.match(parseCommand("crew project add repo=jk/x dir=a;rm").error, /characters/);
  assert.match(parseCommand("crew rm -rf").error, /unknown command/);
  assert.equal(parseCommand("hello team"), null);
  assert.ok(parseCommand("crew help").help);
  assert.ok(validate({ ...base, slack: { channel: "C0123ABCD", commanders: ["jk"] } }).some((p) => /commanders/.test(p)));
});

test("runCommands: first run listens from now; then runs owner commands and replies in thread", async () => {
  const root = tmp("crew-cmd-");
  const config = normalize({ ...base, slack: { channel: "C0123ABCD", commanders: ["U0OWNER01"] } });
  const env = { CREW_SLACK_TOKEN: "xoxb-test" };
  const posted = [];
  const history = [
    { ts: "100.2", user: "U0OWNER01", text: "crew next" },
    { ts: "100.3", user: "U0STRANGER", text: "crew review" },
    { ts: "100.4", user: "U0OWNER01", text: "lunch?" },
    { ts: "100.5", bot_id: "B1", user: "U0OWNER01", text: "crew review" },
    { ts: "100.6", user: "U0OWNER01", text: "crew queue set 1 ready" },
  ];
  const fetchImpl = async (url, o) => {
    const method = url.split("/").pop();
    const body = Object.fromEntries(new URLSearchParams(o.body));
    if (method === "conversations.history") return { json: async () => ({ ok: true, messages: history.filter((m) => Number(m.ts) > Number(body.oldest)) }) };
    posted.push(body);
    return { json: async () => ({ ok: true, ts: "1" }) };
  };
  const runs = [];
  const run = (cmd, args) => (runs.push(args.slice(1)), { ok: true, stdout: "next: #384 door-worst-price" });

  const first = await runCommands({ root, config, env, fetchImpl, run, now: new Date(100_000) });
  assert.match(first.skipped, /first run/);
  assert.equal(runs.length, 0);

  const r = await runCommands({ root, config, env, fetchImpl, run, now: new Date(200_000) });
  assert.equal(r.ran, 2); // "crew next" ran; "queue set ... ready" got an error reply
  assert.deepEqual(runs, [["queue", "next"]]);
  assert.equal(posted[0].thread_ts, "100.2");
  assert.match(posted[0].text, /next: #384/);
  assert.match(posted[1].text, /only `crew queue next`/);
  assert.equal(readState(root).slackCommands.ts, "100.6");

  const quiet = await runCommands({ root, config, env, fetchImpl, run });
  assert.equal(quiet.ran, 0);
  assert.equal((await runCommands({ root, config: normalize({ ...base, slack: { channel: "C0123ABCD" } }), env })).skipped, "no slack.commanders");
});

test("project add: refuses a folder that holds another repo, or a non-empty non-repo folder", async () => {
  const w = fakeWorld();
  const parent = tmp("crew-proj-");
  const other = path.join(parent, "other");
  fs.mkdirSync(path.join(other, ".git"), { recursive: true });
  await assert.rejects(addProject({ repo: "jk/newproj", dir: other, run: w.run }), /already holds jk\/other/);
  const junk = path.join(parent, "junk");
  fs.mkdirSync(junk);
  fs.writeFileSync(path.join(junk, "a.txt"), "x");
  await assert.rejects(addProject({ repo: "jk/newproj", dir: junk, run: w.run }), /not empty but is not a git repo/);
});
