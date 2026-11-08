// `crew schedule`: run crew jobs unattended. macOS: a launchd user agent. Windows: a Task Scheduler
// task (S4U, Limited, IgnoreNew, explicit execution limit). Secrets are never written into either;
// jobs read the token from the machine-local secrets file at run time.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run as realRun } from "./exec.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CREW_BIN = path.resolve(HERE, "..", "bin", "crew");

export const JOBS = {
  brief: { args: ["brief"], what: "daily brief" },
  "brief-weekly": { args: ["brief", "--weekly"], what: "Sunday week in review" },
  dispatch: { args: ["dispatch"], what: "dev dispatcher" },
  watch: { args: ["watch"], what: "every-few-minutes check: dispatch if there is work, refresh the Slack board (no AI unless there is work)" },
  sync: { args: ["sync"], what: "fast-forward the checkout to origin before runners use it" },
  doctor: { args: ["doctor"], what: "health check (for testing the schedule)" },
};
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Validate and normalize when a job runs. */
export function parseWhen({ at, weekday, every }) {
  if (every !== undefined) {
    const m = Number(every);
    if (!Number.isInteger(m) || m < 5 || m > 1440) throw new Error("--every must be whole minutes from 5 to 1440");
    if (at !== undefined || weekday !== undefined) throw new Error("use --every alone, or --at [--weekday]");
    return { every: m };
  }
  if (at === undefined) throw new Error("say when: --at HH:MM[,HH:MM...] [--weekday 0-6] or --every <minutes>");
  const times = String(at).split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const t = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
    if (!t) throw new Error(`--at must be HH:MM (24h), comma-separated for several: got "${s}"`);
    return { hour: Number(t[1]), minute: Number(t[2]) };
  });
  if (!times.length) throw new Error("--at needs at least one HH:MM");
  if (new Set(times.map((x) => x.hour * 60 + x.minute)).size !== times.length) throw new Error("--at has a duplicate time");
  const when = { times };
  if (weekday !== undefined) {
    const d = Number(weekday);
    if (!Number.isInteger(d) || d < 0 || d > 6) throw new Error("--weekday must be 0 (Sunday) to 6");
    when.weekday = d;
  }
  return when;
}

export function jobName(config, job) {
  return `${config.repo.split("/")[1].toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${job}`;
}

/** PATH for unattended jobs: where node, gh, claude and git live on this machine, plus system dirs. */
export function jobPath(run = realRun, platform = process.platform) {
  const dirs = new Set([path.dirname(process.execPath)]);
  const finder = platform === "win32" ? "where" : "which";
  for (const tool of ["gh", "claude", "git"]) {
    const r = run(finder, [tool]);
    const first = r.ok ? r.stdout.split(/\r?\n/).find(Boolean) : null;
    if (first) dirs.add(path.dirname(first.trim()));
  }
  const sys = platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...dirs, ...sys].join(platform === "win32" ? ";" : ":");
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function launchdPlist({ label, root, args, when, envPath, logFile, runAtLoad = false, node = process.execPath, bin = CREW_BIN }) {
  const prog = [node, bin, ...args].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  let sched;
  if (when.every) sched = `  <key>StartInterval</key>\n  <integer>${when.every * 60}</integer>`;
  else {
    const dicts = when.times.map((t) => {
      const parts = [`    <key>Hour</key><integer>${t.hour}</integer>`, `    <key>Minute</key><integer>${t.minute}</integer>`];
      if (when.weekday !== undefined) parts.push(`    <key>Weekday</key><integer>${when.weekday}</integer>`);
      return `  <dict>\n${parts.join("\n")}\n  </dict>`;
    });
    sched = dicts.length === 1
      ? `  <key>StartCalendarInterval</key>\n${dicts[0]}`
      : `  <key>StartCalendarInterval</key>\n  <array>\n${dicts.map((d) => d.replace(/^/gm, "  ")).join("\n")}\n  </array>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${prog}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(envPath)}</string>
    <key>HOME</key>
    <string>${xml(os.homedir())}</string>
  </dict>
${sched}
  <key>RunAtLoad</key>
  <${runAtLoad ? "true" : "false"}/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;

export function windowsScript({ taskName, root, args, when, logFile, limitMin, node = process.execPath, bin = CREW_BIN }) {
  const inner = `"${node}" "${bin}" ${args.join(" ")} >> "${logFile}" 2>&1`;
  let trigger;
  if (when.every) trigger = `New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes ${when.every})`;
  else {
    const one = (t) => when.weekday !== undefined
      ? `(New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${DAYS[when.weekday]} -At ${ps(`${pad(t.hour)}:${pad(t.minute)}`)})`
      : `(New-ScheduledTaskTrigger -Daily -At ${ps(`${pad(t.hour)}:${pad(t.minute)}`)})`;
    trigger = when.times.length === 1 ? one(when.times[0]).slice(1, -1) : `@(${when.times.map(one).join(", ")})`;
  }
  return `# Generated by crew. Registers ${taskName} under \\crew\\ in Task Scheduler.
$ErrorActionPreference = 'Stop'
$action    = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ${ps(`/d /c ${inner}`)} -WorkingDirectory ${ps(root)}
$trigger   = ${trigger}
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes ${limitMin}) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName ${ps(taskName)} -TaskPath '\\crew\\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Output "registered \\crew\\${taskName}"
`;
}
const pad = (n) => String(n).padStart(2, "0");

function uid(run) {
  return (typeof process.getuid === "function" ? process.getuid() : Number(run("id", ["-u"]).stdout.trim()));
}

/** Build everything for a job without installing it. */
export function planJob({ root, config, job, when, runAtLoad = false, platform = process.platform, run = realRun }) {
  if (!JOBS[job]) throw new Error(`unknown job "${job}" (one of: ${Object.keys(JOBS).join(", ")})`);
  const name = jobName(config, job);
  const logFile = path.join(root, ".crew", "logs", `${job}.log`);
  if (platform === "win32") {
    const limitMin = job === "dispatch" || job === "watch" ? config.caps.wall_min + 15 : 30;
    return { platform, name, logFile, file: path.join(root, ".crew", "schedule", `${name}.ps1`),
      text: windowsScript({ taskName: name, root, args: JOBS[job].args, when, logFile, limitMin }) };
  }
  const label = `dev.crew.${name}`;
  return { platform, name: label, logFile, file: path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`),
    text: launchdPlist({ label, root, args: JOBS[job].args, when, envPath: jobPath(run, platform), logFile, runAtLoad }) };
}

export function installJob(plan, run = realRun) {
  fs.mkdirSync(path.dirname(plan.logFile), { recursive: true });
  fs.mkdirSync(path.dirname(plan.file), { recursive: true });
  fs.writeFileSync(plan.file, plan.text, "utf8");
  if (plan.platform === "win32") {
    const r = run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", plan.file], { timeoutMs: 60_000 });
    if (!r.ok) throw new Error(`Register-ScheduledTask failed: ${String(r.stderr || r.stdout).trim().split("\n")[0]}`);
    return;
  }
  if (plan.platform !== "darwin") throw new Error("crew schedule supports macOS (launchd) and Windows (Task Scheduler)");
  const domain = `gui/${uid(run)}`;
  run("launchctl", ["bootout", `${domain}/${plan.name}`]);
  const r = run("launchctl", ["bootstrap", domain, plan.file]);
  if (!r.ok) throw new Error(`launchctl bootstrap failed: ${String(r.stderr).trim().split("\n")[0]}`);
}

export function removeJob(plan, run = realRun) {
  if (plan.platform === "win32") {
    run("powershell", ["-NoProfile", "-Command", `Unregister-ScheduledTask -TaskName ${ps(plan.name)} -TaskPath '\\crew\\' -Confirm:$false`]);
  } else {
    run("launchctl", ["bootout", `gui/${uid(run)}/${plan.name}`]);
  }
  fs.rmSync(plan.file, { force: true });
}

/** Installed crew jobs for this repo with their last result. */
export function statusJobs({ root, config, platform = process.platform, run = realRun }) {
  const out = [];
  for (const job of Object.keys(JOBS)) {
    const name = jobName(config, job);
    if (platform === "win32") {
      const r = run("schtasks", ["/Query", "/TN", `\\crew\\${name}`, "/V", "/FO", "LIST"]);
      if (!r.ok) continue;
      const field = (k) => (r.stdout.match(new RegExp(`^${k}:\\s*(.*)$`, "mi")) ?? [])[1]?.trim() ?? "?";
      out.push({ job, name, state: field("Status"), last_result: field("Last Result"), next: field("Next Run Time") });
    } else {
      const label = `dev.crew.${name}`;
      if (!fs.existsSync(path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`))) continue;
      const r = run("launchctl", ["print", `gui/${uid(run)}/${label}`]);
      const field = (k) => (r.stdout.match(new RegExp(`^\\s*${k} = (.*)$`, "m")) ?? [])[1]?.trim() ?? "?";
      out.push({ job, name: label, state: r.ok ? field("state") : "not loaded", last_result: r.ok ? field("last exit code") : "?", runs: r.ok ? field("runs") : "?" });
    }
    out[out.length - 1].log = path.join(root, ".crew", "logs", `${job}.log`);
  }
  return out;
}
