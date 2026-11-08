// `crew project add`: set a new project up on this (central) machine in one go - the steps a person
// would otherwise do by hand after creating the GitHub repo and the Slack channel:
//   clone -> .claude/crew.json (+ slack, machines) -> .gitignore .crew/ -> commit -> labels ->
//   doctor -> schedule the jobs -> pin the Slack board and say hello.
// Idempotent: a step that is already done is reported as such and skipped.
import fs from "node:fs";
import path from "node:path";
import { run as realRun } from "./exec.mjs";
import { CONFIG_REL, loadConfig, normalize } from "./config.mjs";
import { detect, buildConfig } from "./init.mjs";
import { ensureLabels } from "./queue.mjs";
import { doctor } from "./doctor.mjs";
import { planJob, installJob, parseWhen } from "./schedule.mjs";
import { syncBoard, postNews } from "./slack.mjs";
import { gh } from "./gh.mjs";
import { syncCheckout } from "./sync.mjs";
import { repoFromRemote } from "./doctor.mjs";

export const DEFAULT_JOBS = [
  { job: "sync", when: { at: "06:30" } },
  { job: "watch", when: { every: 10 } },
  { job: "brief", when: { at: "20:30" } },
  { job: "brief-weekly", when: { at: "18:00", weekday: 0 } },
];
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

function git(run, args, cwd) {
  const r = run("git", args, { cwd, timeoutMs: 120_000 });
  if (!r.ok) throw new Error(`git ${args[0]} failed: ${String(r.stderr || r.stdout).trim().split("\n")[0]}`);
  return r.stdout;
}

/**
 * @param {object} o
 * @param {string} o.repo            owner/name (the GitHub repo must exist)
 * @param {string} o.dir             where to clone it
 * @param {object} [o.like]          an existing project's config to copy slack.board/news, machines and caps from
 * @param {string} [o.slackChannel]  the new project's Slack channel ID
 * @param {object} [o.flags]         crew init flags: roles, test-cmd, protected, owner
 * @param {boolean} [o.schedule=true]
 * @param {string} [o.logon="auto"]
 * @returns {Promise<{dir, steps: {step:string, outcome:string}[], config}>}
 */
export async function addProject({ repo, dir, like = null, slackChannel = null, flags = {}, schedule = true, logon = "auto",
  run = realRun, env = process.env, fetchImpl = globalThis.fetch, install = installJob, doctorFn = doctor, dryRun = false }) {
  if (!REPO_RE.test(String(repo ?? ""))) throw new Error(`--repo must be owner/name, got "${repo ?? ""}"`);
  if (!dir) throw new Error("--dir is required (where to put the project on this machine)");
  dir = path.resolve(dir);
  const steps = [];
  const step = (s, outcome) => steps.push({ step: s, outcome });

  // 1. Clone, or reuse the folder if it already holds THIS repo (then bring it up to date).
  if (fs.existsSync(path.join(dir, ".git"))) {
    const o = run("git", ["remote", "get-url", "origin"], { cwd: dir });
    const there = o.ok ? repoFromRemote(o.stdout.trim()) : null;
    if (!there || there.toLowerCase() !== repo.toLowerCase())
      throw new Error(`${dir} already holds ${there ?? "a repo with no GitHub origin"}, not ${repo}; pick another --dir`);
    if (dryRun) step("clone", `would reuse ${dir} and fast-forward it`);
    else {
      const head = run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: dir });
      const branch = head.ok ? head.stdout.trim().replace(/^origin\//, "") : "main";
      const sy = syncCheckout({ root: dir, config: { default_branch: branch || "main" }, run });
      step("clone", `reused ${dir}; sync: ${sy.outcome} (${sy.detail})`);
    }
  } else if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    throw new Error(`${dir} exists and is not empty but is not a git repo; empty it or pick another --dir`);
  } else if (dryRun) step("clone", `would clone ${repo} into ${dir}`);
  else {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    gh(run, ["repo", "clone", repo, dir], { timeoutMs: 300_000 });
    step("clone", `cloned ${repo} into ${dir}`);
  }

  // 2. crew.json.
  const file = path.join(dir, CONFIG_REL);
  let config;
  if (fs.existsSync(file)) {
    config = loadConfig(dir);
    step("config", `${CONFIG_REL} already there; left as is`);
  } else {
    const base = buildConfig(dryRun ? {} : detect(dir, run), { ...flags, repo });
    const raw = { ...base };
    if (like?.caps) raw.caps = { ...like.caps };
    if (like?.machines) raw.machines = like.machines;
    const channel = slackChannel ?? null;
    if (channel) raw.slack = { channel, board: like?.slack?.board ?? true, news: like?.slack?.news ?? true };
    config = normalize(raw);
    const { repo: r, owner_login, ...rest } = config;
    const text = JSON.stringify({ repo: r, owner_login, ...stripDefaults(rest) }, null, 2) + "\n";
    if (dryRun) step("config", `would write ${CONFIG_REL}${channel ? ` (Slack ${channel})` : ""}${like?.machines ? ` (machines: ${[like.machines.main, ...(like.machines.helpers ?? [])].join(", ")})` : ""}`);
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, "utf8");
      step("config", `wrote ${CONFIG_REL}${channel ? ` with Slack ${channel}` : " (no Slack channel given)"}`);
    }
  }

  // 3. .gitignore + commit + push (straight to the default branch: it is the project's setup commit).
  if (!dryRun) {
    const gi = path.join(dir, ".gitignore");
    const cur = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
    if (!/^\.crew\/?$/m.test(cur)) fs.writeFileSync(gi, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + "# crew run state (ledger, lock, logs)\n.crew/\n", "utf8");
    git(run, ["add", "--", CONFIG_REL.split(path.sep).join("/"), ".gitignore"], dir);
    const staged = run("git", ["diff", "--cached", "--quiet"], { cwd: dir });
    if (staged.ok) step("commit", "nothing new to commit");
    else {
      git(run, ["commit", "--quiet", "-m", "crew: project setup (.claude/crew.json, ignore .crew/)"], dir);
      const p = run("git", ["push", "--quiet", "origin", `HEAD:refs/heads/${config.default_branch}`], { cwd: dir, timeoutMs: 120_000 });
      step("commit", p.ok ? `pushed the setup commit to ${config.default_branch}` : `committed locally; push failed (${String(p.stderr).trim().split("\n")[0]}) - push it by hand`);
    }
  } else step("commit", "would commit crew.json and .gitignore to the default branch");

  // 4. Labels.
  if (dryRun) step("labels", "would create the crew labels");
  else step("labels", `created: ${ensureLabels(config, run).join(", ")}`);

  // 5. Doctor.
  if (!dryRun) {
    const { checks } = doctorFn({ cwd: dir, env, run });
    const bad = checks.filter((c) => c.status === "fail");
    const warn = checks.filter((c) => c.status === "warn");
    step("doctor", bad.length ? `FAIL: ${bad.map((c) => `${c.name} (${c.detail})`).join("; ")}` : `ok${warn.length ? ` (${warn.length} warning${warn.length > 1 ? "s" : ""}: ${warn.map((c) => c.name).join(", ")})` : ""}`);
    if (bad.length) return { dir, steps, config, failed: true };
  } else step("doctor", "would run crew doctor");

  // 6. Jobs.
  if (schedule) {
    for (const { job, when } of DEFAULT_JOBS) {
      if (dryRun) {
        step(`job ${job}`, "would schedule");
        continue;
      }
      const plan = planJob({ root: dir, config, job, when: parseWhen(when), run });
      const got = install(plan, run, { logon });
      step(`job ${job}`, `scheduled${got?.logon === "interactive" ? " (runs while you are logged in)" : ""}`);
    }
  } else step("jobs", "skipped (--no-schedule)");

  // 7. Slack.
  if (config.slack && !dryRun) {
    try {
      const b = await syncBoard({ root: dir, config, run, env, fetchImpl, force: true });
      step("slack board", b.action);
    } catch (e) {
      step("slack board", `failed: ${e.message} (is @crew invited to the channel?)`);
    }
    const n = await postNews({ config, env, fetchImpl, text: `👋 crew is set up for ${config.repo}. Label an issue \`ready\` and the dev worker picks it up within 10 minutes.` });
    step("slack hello", n.ok ? "posted" : `not posted (${n.why})`);
  }
  return { dir, steps, config, failed: false };
}

/** Keep the written file short: drop keys equal to their defaults, except the ones people edit. */
function stripDefaults(c) {
  const out = { ...c };
  for (const k of ["slack", "machines", "dispatch_hours", "review"]) if (out[k] === null) delete out[k];
  if (out.slack) out.slack = { channel: out.slack.channel, ...(out.slack.board === false ? { board: false } : {}), ...(out.slack.news === false ? { news: false } : {}) };
  return out;
}

/** "key=value" words (from Slack) and --flags both become one flags object. */
export function parseKeyValues(words) {
  const out = {};
  for (const w of words) {
    const m = /^-{0,2}([a-z][a-z-]*)=(.*)$/.exec(w);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
