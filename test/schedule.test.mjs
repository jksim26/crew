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
  for (const needle of ["-LogonType S4U", "-RunLevel Limited", "-MultipleInstances IgnoreNew", "-ExecutionTimeLimit (New-TimeSpan -Minutes 55)", "-RepetitionInterval (New-TimeSpan -Minutes 30)", "-TaskPath '\\crew\\'", "dispatch --log-file \"C:\\code\\proj\\.crew\\logs\\dispatch.log\""])
    assert.ok(s.includes(needle), needle);
  assert.ok(!s.includes(">>"), "no shell redirect: it would lock the log against overlapping ticks");
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
  assert.match(win.text, /New-TimeSpan -Minutes 85/); // agent wall 40 + crew tests 30 + 15: a tick outlives its workers
  const watch = planJob({ root: "C:\\r", config, job: "watch", when: { every: 10 }, platform: "win32", run: fake });
  assert.match(watch.text, /New-TimeSpan -Minutes 85/);
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

test("windows: the cmd line survives cmd's quote stripping and hands crew its own log file", async () => {
  const { windowsScript } = await import("../lib/schedule.mjs");
  const t = windowsScript({ taskName: "p-watch", root: "X:\\Claude\\Claude Trading", args: ["watch"], when: { every: 10 },
    logFile: "X:\\Claude\\Claude Trading\\.crew\\logs\\watch.log", limitMin: 55, node: "C:\\Program Files\\nodejs\\node.exe", bin: "C:\\p\\bin\\crew" });
  const arg = /-Argument '([^']*)'/.exec(t)[1];
  assert.equal(arg, '/d /s /c ""C:\\Program Files\\nodejs\\node.exe" "C:\\p\\bin\\crew" watch --log-file "X:\\Claude\\Claude Trading\\.crew\\logs\\watch.log""');
});

test("shared log: many writers append to one file, even while another process has it open", async () => {
  const { sharedLogWriter } = await import("../lib/cli.mjs");
  const { spawnSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crew log ")), "logs", "watch.log");
  const w = sharedLogWriter(file);
  w.write("tick 1\n");
  const held = fs.openSync(file, "a"); // a long-running crew tick's handle
  const mod = new URL("../lib/cli.mjs", import.meta.url).href;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const { sharedLogWriter } = await import(${JSON.stringify(mod)}); sharedLogWriter(${JSON.stringify(file)}).write("tick 2\\n");`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  w.write("tick 3\n");
  fs.closeSync(held);
  assert.equal(fs.readFileSync(file, "utf8"), "tick 1\ntick 2\ntick 3\n");
});

test("windows: the generated cmd line really runs node from a path with spaces", { skip: process.platform !== "win32" }, async () => {
  const { windowsScript } = await import("../lib/schedule.mjs");
  const { spawnSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crew win ")), "my project");
  fs.mkdirSync(dir);
  const script = path.join(dir, "hello script.js");
  // Stands in for crew: it writes to the file named by --log-file, as crew's sharedLogWriter does.
  fs.writeFileSync(script, "const fs = require('fs'), p = require('path'); const f = process.argv[process.argv.indexOf('--log-file') + 1]; fs.mkdirSync(p.dirname(f), { recursive: true }); fs.appendFileSync(f, 'hello ' + process.argv[2]);");
  const logFile = path.join(dir, ".crew", "logs", "x.log");
  const t = windowsScript({ taskName: "t", root: dir, args: ["watch"], when: { every: 10 }, logFile, limitMin: 5, node: process.execPath, bin: script });
  const arg = /-Argument '([^']*)'/.exec(t)[1].replace(/''/g, "'");
  const r = spawnSync("cmd.exe", [arg], { cwd: dir, windowsVerbatimArguments: true, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(logFile, "utf8"), /hello watch/);
});

test("windows: --every anchors at 00:00 so a reinstall keeps the start time", async () => {
  const { windowsScript } = await import("../lib/schedule.mjs");
  const t = windowsScript({ taskName: "p-watch", root: "C:\\r", args: ["watch"], when: { every: 10 }, logFile: "C:\\r\\w.log", limitMin: 55, node: "n", bin: "b" });
  assert.match(t, /-Once -At \(\[datetime\]::Today\) -RepetitionInterval \(New-TimeSpan -Minutes 10\)/);
  assert.doesNotMatch(t, /AddMinutes/);
});

test("windows: the watch task runs ticks in parallel (dispatch has its own lock); others ignore new", () => {
  const args = { taskName: "t", root: "C:\\r", args: ["watch"], when: { every: 10 }, logFile: "C:\\r\\w.log", limitMin: 5, node: "n", bin: "b" };
  assert.match(windowsScript(args), /-MultipleInstances IgnoreNew/);
  assert.match(windowsScript({ ...args, instances: "Parallel" }), /-MultipleInstances Parallel/);
});

// ---- auto-update: finding, re-pointing and planning crew jobs ---------------------------------
import { crewJobs, repointJob, planUpdateJob, effectiveBin, CREW_BIN } from "../lib/schedule.mjs";
const okRun = (calls = []) => (cmd, args) => (calls.push(`${cmd} ${args.join(" ")}`), { ok: true, stdout: cmd === "id" ? "501\n" : "", stderr: "" });
const plistFor = (label, root, bin = "/old/crew/bin/crew") => launchdPlist({ label, root, args: ["watch"], when: { every: 10 }, envPath: "/bin", logFile: "/l", node: "/n/node", bin });

test("crewJobs: finds launchd jobs and their folders", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "crew-home-"));
  const dir = path.join(home, "Library", "LaunchAgents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "dev.crew.proj-watch.plist"), plistFor("dev.crew.proj-watch", "/r/proj"));
  fs.writeFileSync(path.join(dir, "dev.crew.update.plist"), plistFor("dev.crew.update", "/u"));
  fs.writeFileSync(path.join(dir, "com.other.plist"), plistFor("com.other", "/x"));
  assert.deepEqual(crewJobs({ platform: "darwin", run: okRun(), home }), [{ name: "dev.crew.proj-watch", root: "/r/proj", file: path.join(dir, "dev.crew.proj-watch.plist") }]);
});

test("crewJobs: finds Windows tasks from schtasks CSV", () => {
  const head = '"HostName","TaskName","Next Run Time","Status","Task To Run","Start In"';
  const csv = [head, '"PC","\\crew\\proj-watch","N/A","Ready","cmd.exe","C:\\r\\proj"', head, '"PC","\\Microsoft\\other","N/A","Ready","x","C:\\x"', '"PC","\\crew\\update","N/A","Ready","cmd.exe","C:\\u"'].join("\r\n");
  const run = (cmd) => (cmd === "schtasks" ? { ok: true, stdout: csv } : { ok: false, stdout: "" });
  assert.deepEqual(crewJobs({ platform: "win32", run }), [{ name: "proj-watch", root: "C:\\r\\proj", file: path.join("C:\\r\\proj", ".crew", "schedule", "proj-watch.ps1") }]);
});

test("repointJob: macOS swaps only the crew path and reloads", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-la-"));
  const file = path.join(dir, "dev.crew.proj-watch.plist");
  const before = plistFor("dev.crew.proj-watch", "/r/proj");
  fs.writeFileSync(file, before);
  const calls = [];
  const job = { name: "dev.crew.proj-watch", root: "/r/proj", file };
  assert.deepEqual(repointJob(job, "/rt/bin/crew", { platform: "darwin", run: okRun(calls) }), { changed: true });
  const after = fs.readFileSync(file, "utf8");
  assert.equal(after, before.replace("<string>/old/crew/bin/crew</string>", "<string>/rt/bin/crew</string>"));
  assert.ok(calls.some((c) => c.startsWith("launchctl bootstrap")));
  assert.deepEqual(repointJob(job, "/rt/bin/crew", { platform: "darwin", run: okRun() }), { changed: false });
});

test("repointJob: Windows keeps quoting with spaces", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-ps-"));
  const file = path.join(dir, "proj-watch.ps1");
  fs.writeFileSync(file, windowsScript({ taskName: "proj-watch", root: "C:\\r\\proj", args: ["watch"], when: { every: 10 }, logFile: "C:\\r\\proj\\.crew\\logs\\watch.log", limitMin: 70, node: "C:\\node\\node.exe", bin: "C:\\old\\bin\\crew" }));
  const calls = [];
  const bin = "C:\\Users\\J K\\AppData\\Local\\crew\\runtime\\bin\\crew";
  assert.deepEqual(repointJob({ name: "proj-watch", root: "C:\\r\\proj", file }, bin, { platform: "win32", run: okRun(calls) }), { changed: true });
  const s = fs.readFileSync(file, "utf8");
  assert.ok(s.includes(`"C:\\node\\node.exe" "${bin}" watch --log-file`), s);
  assert.ok(!s.includes("C:\\old\\bin\\crew"));
  assert.ok(calls.includes(`powershell -NoProfile -ExecutionPolicy Bypass -File ${file}`));
});

test("planUpdateJob: hourly, machine-level", () => {
  const env = { XDG_DATA_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "crew-upd-")) };
  const p = planUpdateJob({ env, platform: "darwin", run: okRun() });
  assert.equal(p.name, "dev.crew.update");
  assert.ok(p.text.includes("<integer>3600</integer>") && p.text.includes("<string>update</string>"), p.text);
  assert.ok(p.logFile.endsWith(path.join("logs", "update.log")));
  assert.ok(p.text.includes(`<string>${path.join(env.XDG_DATA_HOME, "crew")}</string>`));
});

test("effectiveBin: prefers the runner clone", () => {
  const env = { XDG_DATA_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "crew-upd-")) };
  assert.equal(effectiveBin(env, "darwin"), CREW_BIN);
  const bin = path.join(env.XDG_DATA_HOME, "crew", "runtime", "bin", "crew");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, "");
  assert.equal(effectiveBin(env, "darwin"), bin);
  assert.ok(planJob({ root: "/r", config, job: "watch", when: { every: 10 }, platform: "darwin", run: okRun(), env }).text.includes(`<string>${bin}</string>`));
});

test("repointJob: a failed reload restores the old job (macOS)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-la-"));
  const file = path.join(dir, "dev.crew.proj-watch.plist");
  const before = plistFor("dev.crew.proj-watch", "/r/proj");
  fs.writeFileSync(file, before);
  const calls = [];
  let boots = 0;
  const run = (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "id") return { ok: true, stdout: "501\n" };
    if (cmd === "launchctl" && args[0] === "bootstrap") return ++boots === 1 ? { ok: false, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" } : { ok: true, stdout: "" };
    return { ok: true, stdout: "" };
  };
  assert.throws(() => repointJob({ name: "dev.crew.proj-watch", root: "/r/proj", file }, "/rt/bin/crew", { platform: "darwin", run }), /reloading dev\.crew\.proj-watch failed/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(boots, 2, "the old job is loaded again");
});

test("repointJob: a failed re-register restores the old script (Windows)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-ps-"));
  const file = path.join(dir, "proj-watch.ps1");
  const before = windowsScript({ taskName: "proj-watch", root: "C:\\r", args: ["watch"], when: { every: 10 }, logFile: "l", limitMin: 70, node: "C:\\n.exe", bin: "C:\\old\\crew" });
  fs.writeFileSync(file, before);
  const run = () => ({ ok: false, stdout: "", stderr: "Access is denied." });
  assert.throws(() => repointJob({ name: "proj-watch", root: "C:\\r", file }, "C:\\rt\\bin\\crew", { platform: "win32", run }), /Access is denied/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});
