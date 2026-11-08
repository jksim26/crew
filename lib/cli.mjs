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
import { runDispatch, canary } from "./dispatch.mjs";
import { syncCheckout } from "./sync.mjs";
import { promptToken, saveToken, saveSlackToken } from "./token.mjs";
import { syncBoard, postNews, briefNews, notifyOwner } from "./slack.mjs";
import { runWatch } from "./watch.mjs";
import { runReview } from "./review.mjs";
import { addProject } from "./project.mjs";
import { stopBatch } from "./stop.mjs";
import { thisMachine, setMachine } from "./machine.mjs";
import { claudeEnv } from "./pm.mjs";
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

  crew watch [--dry-run]
      The every-10-minutes job: dispatch if there is work (no AI otherwise),
      refresh the pinned Slack board, post one news line if something happened.

  crew board [--force]                   Post or update the pinned Slack board now
  crew notify "<text>"                   Ping the owner in Slack now (@mention), e.g. before a UAC prompt

  crew project add --repo owner/name [--dir <path>] [--slack-channel C0123]
                   [--roles a,b] [--test-cmd "<cmd>"] [--no-schedule] [--logon auto|interactive] [--dry-run]
      Set up a new project on this machine in one go: clone, crew.json (copies machines,
      caps and Slack settings from the project you run it in), .gitignore, setup commit,
      labels, doctor, the jobs (sync, watch, brief, brief-weekly), Slack board + hello.
      Safe to re-run: finished steps are skipped. Also from Slack: crew project add repo=... channel=...

  crew review [--dry-run]
      Run the project's self-review routine ("review.routine" in crew.json) now, on this
      machine's live files. Opens the plan PR (never self-merging) and files proposals
      as needs-jk issues. Schedule it weekly, or run it whenever you want a fresh plan.

  crew machine set <name> | show         Name this machine (e.g. pc, mac) for routing:
                                         unlabelled issues run on the main machine,
                                         an issue labelled "mac" runs only on mac

  crew schedule install <job> (--at HH:MM [--weekday 0-6] | --every MIN) [--now] [--print]
                        [--logon auto|s4u|interactive]   (Windows; auto falls back to interactive,
                        which needs no admin and runs while you are logged in)
  crew schedule remove <job> | status
      Jobs: brief, brief-weekly, review, watch, dispatch, sync, doctor. macOS: launchd user agent;
      Windows: Task Scheduler (S4U, IgnoreNew, execution limit). Logs go to
      .crew/logs/<job>.log. --print shows the file without installing.

  crew sync                              Fast-forward this checkout to origin's default branch
                                         (never merges, resets or touches untracked files)

  crew token set [--stdin]               Save the subscription token from "claude setup-token"
                                         with hidden input, then test it with one tiny call
  crew token set --slack [--stdin]       Save the Slack bot token (xoxb-...) the same way

  crew roles                             List the project's roles and their memory files

  crew stop [--hold]
      End a running dispatch/review batch on this machine, children and all (a scheduled
      task's End stops only its shell). Cleans its worktrees; issues left in doing go to
      blocked. --hold also takes the lease so the next tick does not start a new batch.
      For a batch started by Task Scheduler, run it from an elevated terminal.

  crew lease on|off|status [--note "<why>"]
      An interactive session asks the dispatcher to stay away (expires after 2h).

  crew --version | crew help
`;

/** Tiny flag parser: --k v, --k=v, booleans, and repeatable --protected. */
export function parseArgs(argv) {
  const BOOL = new Set(["yes", "force", "print", "json", "help", "version", "weekly", "dry-run", "now", "stdin", "slack", "hold", "no-schedule"]);
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
      else io.stdout.write(`wrote ${r.briefFile}\nwrote ${r.statusFile}\nusage ≈$${r.cost.toFixed(2)} at API list price, billed to your subscription (${r.attempts} attempt${r.attempts > 1 ? "s" : ""})\n`);
      if (!r.skipped && !flags["dry-run"] && config.slack?.news) {
        const n = await postNews({ config, text: briefNews({ status: r.status, mode, url: r.url }) });
        io.stdout.write(n.ok ? "posted to Slack\n" : `Slack: not posted (${n.why})\n`);
      }
      return 0;
    }
    if (cmd === "queue") return queueCmd(parsed, io);
    if (cmd === "dispatch") {
      const { root, config } = projectContext(flags);
      const r = await runDispatch({ root, config, dryRun: !!flags["dry-run"] });
      io.stdout.write(flags.json ? JSON.stringify(r, null, 2) + "\n" : describeDispatch(r) + "\n");
      const all = r.action === "batch" ? r.results : [r];
      return all.some((x) => ["failed", "canary-failed"].includes(x.action)) ? 1 : 0;
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
        const logon = flags.logon ?? "auto";
        if (!["auto", "s4u", "interactive"].includes(logon)) throw new Error("--logon must be auto, s4u or interactive");
        const got = installJob(plan, undefined, { logon });
        const note = got.logon === "interactive" ? " - runs while you are logged in (registered without admin)" : "";
        io.stdout.write(`installed ${plan.name} (${JOBS[job].what})${note}\n  file: ${plan.file}\n  log:  ${plan.logFile}\n`);
        return 0;
      }
      throw new Error("usage: crew schedule install|remove|status");
    }
    if (cmd === "watch") {
      const { root, config } = projectContext(flags);
      const r = await runWatch({ root, config, dryRun: !!flags["dry-run"] });
      io.stdout.write(`${new Date().toISOString()} ${describeDispatch(r.dispatch)}${r.board ? ` · board ${r.board.action}${r.board.why ? ` (${r.board.why})` : ""}` : ""}${r.news ? ` · news ${r.news.ok ? "sent" : `not sent (${r.news.why})`}` : ""}${r.commands?.ran ? ` · ${r.commands.ran} Slack command(s)` : ""}${r.commands?.error ? ` · Slack commands error: ${r.commands.error}` : ""}\n`);
      const all = r.dispatch.action === "batch" ? r.dispatch.results : [r.dispatch];
      return all.some((x) => ["failed", "canary-failed"].includes(x.action)) || r.board?.action === "error" ? 1 : 0;
    }
    if (cmd === "review") {
      const { root, config } = projectContext(flags);
      const r = await runReview({ root, config, dryRun: !!flags["dry-run"] });
      const line = r.action === "reviewed"
        ? (r.dry ? `would review with ${r.routine} and open ${r.branch}` : `reviewed -> ${r.url} · ${r.issues.length} proposal(s) filed · ≈$${r.cost.toFixed(2)}`)
        : `${r.action}${r.why ? `: ${r.why}` : ""}${r.issues?.length ? ` · ${r.issues.length} proposal(s) filed` : ""}`;
      io.stdout.write(line + "\n");
      if (!r.dry && config.slack?.news && ["reviewed", "no-report", "failed"].includes(r.action)) {
        const text = r.action === "reviewed"
          ? `🔎 *Self-review done:* <${r.url}|the plan PR> is waiting for you${r.issues.length ? `, with ${r.issues.length} new proposal(s) to approve` : ""}.`
          : `⚠️ Self-review ${r.action}: ${String(r.why ?? "").slice(0, 200)}`;
        await postNews({ config, text });
      }
      return ["reviewed"].includes(r.action) ? 0 : 1;
    }
    if (cmd === "project") {
      if (parsed.pos[0] !== "add") throw new Error("usage: crew project add --repo owner/name [--dir <path>] [--slack-channel C0123] [--roles a,b] [--test-cmd \"...\"] [--no-schedule] [--logon auto|interactive] [--dry-run]");
      // Run inside an existing project and the new one copies its machines, caps and Slack settings,
      // and goes next to it on disk.
      const here = findRepoRoot(process.cwd());
      let like = null;
      try { like = here ? loadConfig(here) : null; } catch { like = null; }
      const repo = flags.repo;
      const dir = flags.dir ?? (here && repo ? path.join(path.dirname(here), repo.split("/")[1]) : null);
      const r = await addProject({ repo, dir, like, slackChannel: flags["slack-channel"] ?? null,
        flags: { roles: flags.roles, "test-cmd": flags["test-cmd"], protected: flags.protected },
        schedule: !flags["no-schedule"], logon: flags.logon ?? "auto", dryRun: !!flags["dry-run"] });
      io.stdout.write(`${r.dir}\n${r.steps.map((s) => `  ${s.step}: ${s.outcome}`).join("\n")}\n${r.failed ? "stopped: fix the doctor failure, then run the same command again\n" : "done\n"}`);
      return r.failed ? 1 : 0;
    }
    if (cmd === "notify") {
      const text = parsed.pos.join(" ").trim();
      if (!text) throw new Error('usage: crew notify "<what needs you, and where>"');
      const { config } = projectContext(flags);
      const r = await notifyOwner({ config, text });
      io.stdout.write(r.ok ? `notified: ${r.text}\n` : `not sent (${r.why}): ${text}\n`);
      return r.ok ? 0 : 1;
    }
    if (cmd === "board") {
      const { root, config } = projectContext(flags);
      if (!config.slack) throw new Error(`no "slack" in crew.json (add {"slack": {"channel": "C..."}})`);
      const r = await syncBoard({ root, config, force: !!flags.force });
      io.stdout.write(`board: ${r.action}${r.why ? ` (${r.why})` : ""}\n`);
      return 0;
    }
    if (cmd === "machine") {
      const sub = parsed.pos[0] ?? "show";
      if (sub === "show") {
        io.stdout.write(`this machine: ${thisMachine() ?? "(no name set; run: crew machine set <name>)"}\n`);
        return 0;
      }
      if (sub !== "set" || !parsed.pos[1]) throw new Error("usage: crew machine set <name> | show");
      const { config } = projectContext(flags);
      setMachine(config, parsed.pos[1]);
      io.stdout.write(`this machine is now "${parsed.pos[1].toLowerCase()}"\n`);
      return 0;
    }
    if (cmd === "sync") {
      const { root, config } = projectContext(flags);
      const r = syncCheckout({ root, config });
      io.stdout.write(`sync: ${r.outcome} - ${r.detail}\n`);
      return r.ok ? 0 : 1;
    }
    if (cmd === "token") {
      if (parsed.pos[0] !== "set") throw new Error("usage: crew token set [--slack] [--stdin]");
      if (flags.slack) {
        const t = flags.stdin ? fs.readFileSync(0, "utf8").replace(/\s+/g, "") : await promptToken({ label: "Slack bot token (starts with xoxb-)" });
        if (!t) throw new Error("cancelled; nothing saved");
        io.stdout.write(`saved to ${saveSlackToken(t)} (readable only by you)\n`);
        return 0;
      }
      const token = flags.stdin ? fs.readFileSync(0, "utf8").replace(/\s+/g, "") : await promptToken();
      if (!token) throw new Error("cancelled; nothing saved");
      const file = saveToken(token);
      io.stdout.write(`saved to ${file} (readable only by you)\n`);
      const c = canary({ env: claudeEnv(process.env), cwd: process.cwd() });
      io.stdout.write(c.ok ? "test call: ok - scheduled runs can log in\n" : `test call FAILED: ${c.why}\n`);
      return c.ok ? 0 : 1;
    }
    if (cmd === "roles") {
      const { config } = projectContext(flags);
      const roles = roleList(config);
      io.stdout.write(roles.length ? roles.map((r) => `${r.name}\t${r.memory}`).join("\n") + "\n" : "no project roles in crew.json\n");
      return 0;
    }
    if (cmd === "stop") {
      const { root, config } = projectContext(flags);
      const r = stopBatch({ root, config, hold: !!flags.hold });
      if (r.why) {
        io.stderr.write(`crew stop: ${r.why}\n`);
        return 1;
      }
      io.stdout.write(`${r.stopped ? `stopped batch pid ${r.pid}` : "no running batch"} · ${r.worktrees} worktree(s) removed · ${r.blocked.length ? `blocked #${r.blocked.join(", #")}` : "no issues left in doing"}${flags.hold ? " · lease held" : ""}\n`);
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
    case "batch": return `${r.results.length} dev workers${dry}:\n${r.results.map((x) => `  ${describeDispatch(x)}`).join("\n")}`;
    case "built": return `built #${r.issue}${r.url ? ` -> ${r.url}` : ""}${r.protected?.length ? ` (protected: ${r.protected.join(", ")})` : ""}${r.cost !== undefined ? ` · ${r.cost.toFixed(2)}` : ""}${dry}`;
    case "fixed": return `fix round on #${r.issue} (PR #${r.pr})${r.cost !== undefined ? ` · ${r.cost.toFixed(2)}` : ""}${dry}`;
    case "blocked": return `#${r.issue} blocked: new Codex findings after ${r.rounds ?? "the"} fix round${r.rounds === 1 ? "" : "s"}${dry}`;
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
