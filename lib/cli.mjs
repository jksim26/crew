// Entry point for the `crew` command.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { doctor, formatChecks } from "./doctor.mjs";
import { init } from "./init.mjs";
import { ConfigError, findRepoRoot, loadConfig, roleList } from "./config.mjs";
import { collect } from "./collect.mjs";
import { runBrief, readState } from "./brief.mjs";
import { ensureLabels, nextIssue, setState, newIssue, importChecklist } from "./queue.mjs";
import { runDispatch } from "./dispatch.mjs";
import { takeLease, releaseLease, leaseHeld } from "./state.mjs";
import { JOBS, parseWhen, planJob, installJob, removeJob, statusJobs } from "./schedule.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const HELP = `crew - the crew command

Usage:
  crew init [--repo owner/name] [--owner login] [--default-branch main]
            [--roles a,b] [--protected <glob>]... [--test-cmd "<cmd>"]
            [--wip-cap N] [--yes] [--force] [--print]
      Write .claude/crew.json for this repo. Values are detected from git and gh;
      flags override; asks interactively unless --yes. --print previews only.

  crew doctor [--json] [--config <file>]
      Read-only checks: node, claude, gh login, billing env, token for scheduled
      runs, config, repo access. Exit 1 if any check fails. --config tests a
      config kept outside the repo (trial before adopting).

  crew collect [--weekly] [--config <file>]
      Print what the PM would read (PRs, issues by crew label, commits, reviews,
      log tails) as JSON. No model call.

  crew brief [--weekly] [--dry-run --out <dir>] [--force] [--config <file>]
      Write docs/briefs/<date>.md and STATUS.md. Skips the model when nothing
      changed since the last daily brief (--force overrides). --dry-run writes
      only into --out and records no state.

  crew queue labels                      Create/refresh the crew state labels
  crew queue next [--json]               Show the issue the dev worker would take next
  crew queue set <n> <state> [--reason "<text>"]
                                         Move issue n to ready|doing|in-review|blocked|needs-jk
  crew queue new --title "<t>" [--body-file <f>|-]
                                         File a proposal issue (labelled needs-jk, never ready)
  crew queue import <file.md> [--section "<heading>"] [--label needs-jk] [--dry-run]
                                         Turn unchecked "- [ ]" items into issues

  crew dispatch [--dry-run] [--json]
      One unit of work: a Codex fix round on an agent PR, or the next ready issue.
      Plain checks first (lock, lease, budget, WIP cap, queue); the model runs only
      when there is work. --dry-run says what it would do and changes nothing.

  crew schedule install <job> (--at HH:MM [--weekday 0-6] | --every MIN) [--now] [--print]
  crew schedule remove <job> | status
      Jobs: brief, brief-weekly, dispatch, doctor. macOS: launchd user agent;
      Windows: Task Scheduler (S4U, IgnoreNew, execution limit). Logs go to
      .crew/logs/<job>.log. --print shows the file without installing.

  crew roles                             List the project's roles and their memory files

  crew lease on|off|status [--note "<why>"]
      An interactive session asks the dispatcher to stay away (expires after 2h).

  crew --version | crew help
`;

/** Tiny flag parser: --k v, --k=v, booleans, and repeatable --protected. */
export function parseArgs(argv) {
  const BOOL = new Set(["yes", "force", "print", "json", "help", "version", "weekly", "dry-run", "now"]);
  const REPEAT = new Set(["protected"]);
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    let [k, v] = a.slice(2).split(/=(.*)/s, 2);
    if (BOOL.has(k) && v === undefined) {
      flags[k] = true;
      continue;
    }
    if (v === undefined) {
      v = argv[++i];
      if (v === undefined) throw new Error(`--${k} needs a value`);
    }
    if (REPEAT.has(k)) (flags[k] ??= []).push(v);
    else flags[k] = v;
  }
  return { cmd: pos[0], pos: pos.slice(1), flags };
}

export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    io.stderr.write(`crew: ${e.message}\n`);
    return 2;
  }
  const { cmd, flags } = parsed;

  if (flags.version || cmd === "version") {
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, "..", ".claude-plugin", "plugin.json"), "utf8"));
    io.stdout.write(`crew ${pkg.version}\n`);
    return 0;
  }
  if (!cmd || cmd === "help" || flags.help) {
    io.stdout.write(HELP);
    return cmd || flags.help ? 0 : 2;
  }

  try {
    if (cmd === "doctor") {
      const { checks } = doctor({ configPath: flags.config ?? null });
      io.stdout.write(flags.json ? JSON.stringify(checks, null, 2) + "\n" : formatChecks(checks) + "\n");
      return checks.some((c) => c.status === "fail") ? 1 : 0;
    }
    if (cmd === "init") {
      const { file } = await init({ flags });
      if (file) io.stdout.write(`wrote ${file}\nnext: crew doctor\n`);
      return 0;
    }
    if (cmd === "collect" || cmd === "brief") {
      const root = findRepoRoot(process.cwd());
      if (!root) throw new Error("not inside a git repository");
      const config = loadConfig(root, flags.config ?? null);
      const mode = flags.weekly ? "weekly" : "daily";
      if (cmd === "collect") {
        const data = collect({ root, config, mode, lastBriefAt: readState(root).lastBrief?.at ?? null });
        io.stdout.write(JSON.stringify(data, null, 2) + "\n");
        return 0;
      }
      const r = runBrief({ root, config, mode, dryRun: !!flags["dry-run"], out: flags.out ?? null, force: !!flags.force });
      if (r.skipped) io.stdout.write(`skipped: ${r.reason}\n`);
      else io.stdout.write(`wrote ${r.briefFile}\nwrote ${r.statusFile}\ncost $${r.cost.toFixed(2)} (${r.attempts} attempt${r.attempts > 1 ? "s" : ""})\n`);
      return 0;
    }
    if (cmd === "queue") return queueCmd(parsed, io);
    if (cmd === "dispatch") {
      const { root, config } = projectContext(flags);
      const r = await runDispatch({ root, config, dryRun: !!flags["dry-run"] });
      io.stdout.write(flags.json ? JSON.stringify(r, null, 2) + "\n" : describeDispatch(r) + "\n");
      return ["failed", "canary-failed"].includes(r.action) ? 1 : 0;
    }
    if (cmd === "schedule") {
      const { root, config } = projectContext(flags);
      const [sub, job] = parsed.pos;
      if (sub === "status") {
        const s = statusJobs({ root, config });
        io.stdout.write(s.length ? s.map((j) => `${j.job}\t${j.name}\tstate=${j.state}\tlast=${j.last_result}${j.runs ? `\truns=${j.runs}` : ""}${j.next ? `\tnext=${j.next}` : ""}\n  log: ${j.log}`).join("\n") + "\n" : "no crew jobs installed for this repo\n");
        return 0;
      }
      if (sub === "remove") {
        if (!job) throw new Error("usage: crew schedule remove <job>");
        const plan = planJob({ root, config, job, when: { every: 60 } });
        removeJob(plan);
        io.stdout.write(`removed ${plan.name}\n`);
        return 0;
      }
      if (sub === "install") {
        if (!job) throw new Error(`usage: crew schedule install <job> --at HH:MM | --every MIN (jobs: ${Object.keys(JOBS).join(", ")})`);
        const when = parseWhen({ at: flags.at, weekday: flags.weekday, every: flags.every });
        const plan = planJob({ root, config, job, when, runAtLoad: !!flags.now });
        if (flags.print) {
          io.stdout.write(`# ${plan.file}\n${plan.text}`);
          return 0;
        }
        installJob(plan);
        io.stdout.write(`installed ${plan.name} (${JOBS[job].what})\n  file: ${plan.file}\n  log:  ${plan.logFile}\n`);
        return 0;
      }
      throw new Error("usage: crew schedule install|remove|status");
    }
    if (cmd === "roles") {
      const { config } = projectContext(flags);
      const roles = roleList(config);
      io.stdout.write(roles.length ? roles.map((r) => `${r.name}\t${r.memory}`).join("\n") + "\n" : "no project roles in crew.json\n");
      return 0;
    }
    if (cmd === "lease") {
      const { root } = projectContext(flags);
      const sub = parsed.pos[0] ?? "status";
      if (sub === "on") takeLease(root, flags.note ?? "");
      else if (sub === "off") releaseLease(root);
      else if (sub !== "status") throw new Error("usage: crew lease on|off|status");
      io.stdout.write(`lease: ${leaseHeld(root) ? "held (dispatcher stays away)" : "free"}\n`);
      return 0;
    }
  } catch (e) {
    io.stderr.write(`crew ${cmd}: ${e instanceof ConfigError ? e.message : e.message}\n`);
    return 1;
  }
  io.stderr.write(`crew: unknown command "${cmd}"\n\n${HELP}`);
  return 2;
}

export function describeDispatch(r) {
  const dry = r.dry ? " (dry run)" : "";
  switch (r.action) {
    case "built": return `built #${r.issue}${r.url ? ` -> ${r.url}` : ""}${r.protected?.length ? ` (protected: ${r.protected.join(", ")})` : ""}${r.cost !== undefined ? ` · ${r.cost.toFixed(2)}` : ""}${dry}`;
    case "fixed": return `fix round on #${r.issue} (PR #${r.pr})${r.cost !== undefined ? ` · ${r.cost.toFixed(2)}` : ""}${dry}`;
    case "blocked": return `#${r.issue} blocked: new Codex findings after the fix round${dry}`;
    case "idle": return `idle: no eligible ready issue${(r.skipped ?? []).map((s) => `\n  skipped #${s.number}: ${s.reason}`).join("")}`;
    default: return `${r.action}${r.issue ? ` #${r.issue}` : ""}${r.why ? `: ${r.why}` : ""}`;
  }
}

export function projectContext(flags) {
  const root = findRepoRoot(process.cwd());
  if (!root) throw new Error("not inside a git repository");
  return { root, config: loadConfig(root, flags.config ?? null) };
}

function readBody(flags) {
  if (!flags["body-file"]) return "";
  return flags["body-file"] === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(flags["body-file"], "utf8");
}

function queueCmd({ pos, flags }, io) {
  const { config } = projectContext(flags);
  const sub = pos[0];
  if (sub === "labels") {
    io.stdout.write(`labels ready in ${config.repo}: ${ensureLabels(config).join(", ")}\n`);
    return 0;
  }
  if (sub === "next") {
    const r = nextIssue(config);
    if (flags.json) io.stdout.write(JSON.stringify(r, null, 2) + "\n");
    else {
      io.stdout.write(r.issue ? `next: #${r.issue.number} ${r.issue.title}\n` : "next: nothing eligible\n");
      for (const s of r.skipped) io.stdout.write(`  skipped #${s.number}: ${s.reason}\n`);
    }
    return 0;
  }
  if (sub === "set") {
    const [n, state] = pos.slice(1);
    if (!n || !state) throw new Error("usage: crew queue set <n> <state> [--reason ...]");
    const r = setState(config, Number(n), state, { reason: flags.reason ?? null });
    io.stdout.write(`#${n} -> ${r.state}${r.removed.length ? ` (removed ${r.removed.join(", ")})` : ""}\n`);
    return 0;
  }
  if (sub === "new") {
    if (!flags.title) throw new Error("usage: crew queue new --title <t> [--body-file f|-]");
    io.stdout.write(newIssue(config, { title: flags.title, body: readBody(flags) || "(no description)" }) + "\n");
    return 0;
  }
  if (sub === "import") {
    if (!pos[1]) throw new Error("usage: crew queue import <file.md> [--section h] [--dry-run]");
    const res = importChecklist(config, pos[1], { section: flags.section ?? null, label: flags.label ?? "needs-jk", dryRun: !!flags["dry-run"] });
    for (const r of res) io.stdout.write(`${r.action}: ${r.title}${r.url ? ` ${r.url}` : ""}\n`);
    io.stdout.write(`${res.length} task(s)\n`);
    return 0;
  }
  throw new Error(`unknown queue command "${sub ?? ""}" (labels|next|set|new|import)`);
}
