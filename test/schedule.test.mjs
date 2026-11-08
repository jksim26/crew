import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWhen, jobName, launchdPlist, windowsScript, planJob, jobPath, installJob } from "../lib/schedule.mjs";
import { normalize } from "../lib/config.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const config = normalize({ repo: "jk/My_Proj", owner_login: "jk" });

test("parseWhen validates times, weekdays and intervals", () => {
  assert.deepEqual(parseWhen({ at: "18:30" }), { times: [{ hour: 18, minute: 30 }] });
  assert.deepEqual(parseWhen({ at: "7:05", weekday: "0" }), { times: [{ hour: 7, minute: 5 }], weekday: 0 });
  assert.deepEqual(parseWhen({ at: "13:00, 16:30,21:00" }).times.map((x) => x.hour), [13, 16, 21]);
  assert.throws(() => parseWhen({ at: "13:00,13:00" }), /duplicate/);
  assert.throws(() => parseWhen({ at: "13:00,25:00" }), /25:00/);
  assert.deepEqual(parseWhen({ every: "60" }), { every: 60 });
  assert.throws(() => parseWhen({}), /say when/);
  assert.throws(() => parseWhen({ at: "25:00" }), /HH:MM/);
  assert.throws(() => parseWhen({ at: "10:00", weekday: 7 }), /weekday/);
  assert.throws(() => parseWhen({ every: 1 }), /5 to 1440/);
  assert.throws(() => parseWhen({ every: 30, at: "10:00" }), /alone/);
});

test("jobName is filesystem- and label-safe", () => {
  assert.equal(jobName(config, "brief-weekly"), "my-proj-brief-weekly");
});

test("launchd plist: absolute node + crew, calendar or interval, no secrets", () => {
  const p = launchdPlist({ label: "dev.crew.x-brief", root: "/r", args: ["brief", "--weekly"], when: { times: [{ hour: 18, minute: 0 }], weekday: 0 },
    envPath: "/opt/homebrew/bin:/usr/bin", logFile: "/r/.crew/logs/brief.log", node: "/usr/local/bin/node", bin: "/c/bin/crew" });
  assert.match(p, /<string>\/usr\/local\/bin\/node<\/string>\n    <string>\/c\/bin\/crew<\/string>\n    <string>brief<\/string>\n    <string>--weekly<\/string>/);
  assert.match(p, /<key>Weekday<\/key><integer>0<\/integer>/);
  assert.match(p, /<key>RunAtLoad<\/key>\n  <false\/>/);
  assert.doesNotMatch(p, /TOKEN|API_KEY/);
  const i = launchdPlist({ label: "l", root: "/r", args: ["dispatch"], when: { every: 30 }, envPath: "/bin", logFile: "/l", node: "n", bin: "b", runAtLoad: true });
  assert.match(i, /<key>StartInterval<\/key>\n  <integer>1800<\/integer>/);
  assert.match(i, /<true\/>/);
  assert.match(launchdPlist({ label: "a&b", root: "/r<x>", args: [], when: { every: 5 }, envPath: "", logFile: "", node: "n", bin: "b" }), /a&amp;b[\s\S]*\/r&lt;x&gt;/);
});

test("several --at times: launchd array of dicts, Task Scheduler trigger array", () => {
  const when = { times: [{ hour: 13, minute: 0 }, { hour: 21, minute: 30 }] };
  const p = launchdPlist({ label: "l", root: "/r", args: ["dispatch"], when, envPath: "/bin", logFile: "/l", node: "n", bin: "b" });
  assert.match(p, /<key>StartCalendarInterval<\/key>\n  <array>\n    <dict>[\s\S]*<integer>13<\/integer>[\s\S]*<integer>21<\/integer>[\s\S]*<\/array>/);
  const s = windowsScript({ taskName: "t", root: "C:\\r", args: ["dispatch"], when, logFile: "l", limitMin: 55, node: "n", bin: "b" });
  assert.match(s, /\$trigger   = @\(\(New-ScheduledTaskTrigger -Daily -At '13:00'\), \(New-ScheduledTaskTrigger -Daily -At '21:30'\)\)/);
});

test("windows script: S4U, Limited, IgnoreNew, explicit limit, logs appended", () => {
  const s = windowsScript({ taskName: "proj-dispatch", root: "C:\\code\\proj", args: ["dispatch"], when: { every: 30 }, logFile: "C:\\code\\proj\\.crew\\logs\\dispatch.log", limitMin: 55, node: "C:\\node\\node.exe", bin: "C:\\crew\\bin\\crew" });
  for (const needle of ["-LogonType S4U", "-RunLevel Limited", "-MultipleInstances IgnoreNew", "-ExecutionTimeLimit (New-TimeSpan -Minutes 55)", "-RepetitionInterval (New-TimeSpan -Minutes 30)", "-TaskPath '\\crew\\'", ">> \"C:\\code\\proj\\.crew\\logs\\dispatch.log\" 2>&1"])
    assert.ok(s.includes(needle), needle);
  assert.match(windowsScript({ taskName: "t", root: "C:\\r", args: ["brief", "--weekly"], when: { times: [{ hour: 18, minute: 0 }], weekday: 0 }, logFile: "l", limitMin: 30, node: "n", bin: "b" }), /-Weekly -DaysOfWeek Sunday -At '18:00'/);
  assert.match(windowsScript({ taskName: "t", root: "C:\\it's", args: ["brief"], when: { times: [{ hour: 6, minute: 5 }] }, logFile: "l", limitMin: 30, node: "n", bin: "b" }), /-Daily -At '06:05'[\s\S]*/);
  assert.match(windowsScript({ taskName: "t", root: "C:\\it's", args: ["brief"], when: { times: [{ hour: 6, minute: 5 }] }, logFile: "l", limitMin: 30, node: "n", bin: "b" }), /'C:\\it''s'/);
});

test("planJob: per platform, dispatch limit follows the wall cap", () => {
  const fake = (cmd, args) => ({ ok: true, stdout: `/opt/tools/${args[0]}\n` });
  const mac = planJob({ root: "/r", config, job: "brief", when: { times: [{ hour: 18, minute: 0 }] }, platform: "darwin", run: fake });
  assert.equal(mac.name, "dev.crew.my-proj-brief");
  assert.match(mac.file, /LaunchAgents[\\/]dev\.crew\.my-proj-brief\.plist$/);
  assert.match(mac.text, /\/opt\/tools/);
  const win = planJob({ root: "C:\\r", config, job: "dispatch", when: { every: 30 }, platform: "win32", run: fake });
  assert.match(win.text, /New-TimeSpan -Minutes 55/); // wall 40 + 15
  assert.throws(() => planJob({ root: "/r", config, job: "nope", when: { every: 30 } }), /unknown job/);
});

test("jobPath includes the tool directories and system dirs", () => {
  const p = jobPath((cmd, args) => ({ ok: true, stdout: `/x/${args[0]}/bin/${args[0]}\n` }), "darwin");
  assert.ok(p.includes("/x/gh/bin") && p.includes("/x/claude/bin") && p.includes("/usr/bin"));
});

test("installJob on macOS writes the plist and boots it out then in", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-sched-"));
  const calls = [];
  const plan = { platform: "darwin", name: "dev.crew.t", file: path.join(dir, "la", "t.plist"), logFile: path.join(dir, "logs", "t.log"), text: "<plist/>" };
  installJob(plan, (cmd, args) => { calls.push(`${cmd} ${args.join(" ")}`); return { ok: true, stdout: "501\n" }; });
  assert.equal(fs.readFileSync(plan.file, "utf8"), "<plist/>");
  assert.ok(calls.some((c) => c.startsWith("launchctl bootout gui/")));
  assert.ok(calls.some((c) => c.startsWith("launchctl bootstrap gui/") && c.endsWith(plan.file)));
});
