// `crew review`: the project's own self-review routine, run headless on the machine that holds the
// live files. The reviewer reads the main checkout (ledgers, logs, gitignored data) and a fresh
// worktree off origin/<default>, writes only its report there and commits locally. crew then pushes
// `crew/review-<date>`, opens the plan PR for the owner, and files the proposals as `needs-jk` issues.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run as realRun, runStreaming as realStream } from "./exec.mjs";
import { gh, ghJson } from "./gh.mjs";
import { newIssue } from "./queue.mjs";
import { readAgentFile, extractJson } from "./pm.mjs";
import { prePushHook, agentEnv, canary, parseStream } from "./dispatch.mjs";
import { resolveCmd, mainCheckout } from "./config.mjs";
import { acquireLock, logLine, loadLedger, saveLedger, dayKey } from "./state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(HERE, "..", "agents");
const MAX_TURNS = 80;

function git(run, args, cwd, timeoutMs = 120_000) {
  const r = run("git", args, { cwd, timeoutMs });
  if (!r.ok) throw new Error(`git ${args[0]} failed: ${String(r.stderr || r.stdout).trim().split("\n")[0]}`);
  return r.stdout;
}

export function reviewPermissions(config, main) {
  const allowed = [
    "Read", "Write", "Edit", "Glob", "Grep",
    "Bash(git status:*)", "Bash(git diff:*)", "Bash(git add:*)", "Bash(git commit:*)",
    "Bash(git log:*)", "Bash(git show:*)", "Bash(ls:*)",
    ...config.review.bash.map((b) => `Bash(${resolveCmd(b, main)}:*)`),
  ];
  // Claude Code permission rules take an absolute path as //path (Windows: //x/rest for X:\rest).
  const fwd = main.split(path.sep).join("/");
  const m = /^[A-Za-z]:/.test(fwd) ? `/${fwd[0].toLowerCase()}${fwd.slice(2)}` : fwd;
  const disallowed = [
    "Bash(git push:*)", "Bash(gh:*)", "Bash(curl:*)", "Bash(wget:*)", "WebFetch", "WebSearch", "Bash(rm -rf:*)",
    // The main checkout is read-only to the reviewer: it writes only in its own worktree.
    `Edit(/${m}/**)`, `Write(/${m}/**)`,
    "Read(./.env)", "Read(./.env.*)", "Read(**/.env)", "Read(**/.env.*)",
    "Bash(cat:*.env*)", "Bash(cat .env*)",
  ];
  return { allowed, disallowed };
}

export function buildReviewPrompt({ config, routine, main, date }) {
  return [
    `SELF-REVIEW for ${config.repo}, date ${date}.`,
    `Main checkout (live files, read-only to you): ${main}`,
    "Your working directory is a fresh worktree of the default branch; write your report here.",
    "",
    "The routine below is the project's own spec. Where it says to run `gh` (open the PR, file issues,",
    "list issues or PRs), do not: put the PR title, PR body and proposals in your final JSON instead.",
    "<routine>",
    routine,
    "</routine>",
    "",
    "When finished, commit locally (never push), then reply with only the final JSON from your instructions.",
  ].join("\n");
}

function writeAgentsFile(dir) {
  const a = readAgentFile(path.join(AGENTS_DIR, "reviewer.md"));
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({ "crew-reviewer": { description: a.description, prompt: a.prompt, ...(a.model ? { model: a.model } : {}) } }));
  return file;
}

/** Open issues by title, so a proposal already filed is not filed twice. */
function openTitles(config, run) {
  return new Set((ghJson(run, ["issue", "list", "--repo", config.repo, "--state", "open", "--limit", "500", "--json", "title"]) ?? []).map((i) => i.title.trim().toLowerCase()));
}

/**
 * @returns {{action: "reviewed"|"locked"|"failed"|"canary-failed"|"no-report", url?, issues?, cost?, why?}}
 */
export async function runReview({ root, config, run = realRun, runStream = realStream, env = process.env, now = new Date(), dryRun = false }) {
  if (!config.review) throw new Error(`no "review" in crew.json (add {"review": {"routine": "path/to/routine.md"}})`);
  const main = mainCheckout(root);
  const routineFile = path.join(main, ...config.review.routine.split("/"));
  const routine = fs.readFileSync(routineFile, "utf8");
  const date = now.toISOString().slice(0, 10);
  const branch = `crew/review-${date}`;
  if (dryRun) return { action: "reviewed", dry: true, branch, routine: config.review.routine };

  const release = acquireLock(root, { staleMs: config.caps.wall_min * 2 * 60_000 });
  if (!release) return done(root, { action: "locked" });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crew-review-"));
  const wt = path.join(tmp, "wt");
  const hooks = path.join(tmp, "hooks");
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, "pre-push"), prePushHook({ ...config, agent_branch_prefix: "crew/review-" }));
  fs.chmodSync(path.join(hooks, "pre-push"), 0o755);
  const childEnv = agentEnv(env, hooks);
  const local = `crew-review/${date}-${Date.now()}`;
  let cost = 0;
  let wtMade = false;
  const ledger = loadLedger(root);
  try {
    const c = canary({ run, env: childEnv, cwd: root });
    if (!c.ok) return done(root, { action: "canary-failed", why: c.why });
    cost += c.cost;
    git(run, ["fetch", "--quiet", "origin", config.default_branch], root);
    git(run, ["worktree", "add", "--quiet", "-b", local, wt, `origin/${config.default_branch}`], root);
    wtMade = true;
    const startSha = git(run, ["rev-parse", "HEAD"], wt).trim();

    const { allowed, disallowed } = reviewPermissions(config, main);
    const budget = config.review.budget_usd;
    const args = [
      "-p", "--agents", writeAgentsFile(tmp), "--agent", "crew-reviewer",
      "--output-format", "stream-json", "--verbose",
      "--max-turns", String(MAX_TURNS), "--max-budget-usd", budget.toFixed(2),
      "--strict-mcp-config", "--no-session-persistence",
      "--permission-mode", "acceptEdits", "--permission-prompts", "none",
      "--add-dir", main,
      "--allowedTools", ...allowed, "--disallowedTools", ...disallowed,
    ];
    const res = await runStream("claude", args, {
      cwd: wt, env: childEnv, input: buildReviewPrompt({ config, routine, main, date }),
      wallMs: config.caps.wall_min * 60_000, idleMs: config.caps.idle_min * 60_000,
    });
    const result = parseStream(res.stdout);
    cost += result ? Number(result.total_cost_usd) || 0 : budget;
    let report = null;
    try {
      report = result?.result ? extractJson(result.result) : null;
    } catch { /* no JSON */ }

    // Proposals are filed even when the report commit is missing: they are the useful half.
    const proposals = (report?.proposals ?? []).filter((p) => p?.title && p?.body).slice(0, config.review.max_issues);
    const seen = openTitles(config, run);
    const issues = [];
    for (const p of proposals) {
      const title = String(p.title).replace(/\s+/g, " ").trim().slice(0, 240);
      if (seen.has(title.toLowerCase())) continue;
      const url = newIssue(config, { title, body: `${p.body}\n\n_Proposed by the crew self-review ${date}. Label \`ready\` to approve._`, run });
      issues.push(url);
      seen.add(title.toLowerCase());
    }

    const commits = Number(git(run, ["rev-list", "--count", `${startSha}..HEAD`], wt).trim());
    if (!commits) return done(root, { action: "no-report", issues, cost, why: report?.remaining ?? (result ? "the reviewer wrote no report" : `the run failed: ${String(res.stderr).trim().split("\n")[0] || "no result"}`) });

    git(run, ["-c", `core.hooksPath=${hooks}`, "push", "--quiet", "--force", "origin", `HEAD:refs/heads/${branch}`], wt);
    const body = [
      report?.pr_body ?? "(the reviewer returned no PR body)",
      "",
      issues.length ? `**Proposals filed (needs-jk, label \`ready\` to approve):**\n${issues.map((u) => `- ${u}`).join("\n")}` : "**No new proposals filed.**",
      "",
      `<sub>crew review · ≈$${cost.toFixed(2)} API-equiv. (subscription usage) · merging this PR approves the plan; it never merges itself</sub>`,
    ].join("\n");
    const existing = ghJson(run, ["pr", "list", "--repo", config.repo, "--head", branch, "--state", "open", "--json", "url"]) ?? [];
    const url = existing.length ? existing[0].url
      : gh(run, ["pr", "create", "--repo", config.repo, "--base", config.default_branch, "--head", branch,
        "--title", report?.pr_title ?? `plan: self-review ${date}`, "--body-file", "-"], { input: body }).trim().split("\n").pop();
    return done(root, { action: "reviewed", url, issues, cost });
  } catch (err) {
    return done(root, { action: "failed", why: err.message, cost });
  } finally {
    const d = dayKey(now);
    ledger.days[d] = Math.round(((ledger.days[d] ?? 0) + cost) * 10000) / 10000;
    saveLedger(root, ledger);
    if (wtMade) run("git", ["worktree", "remove", "--force", wt], { cwd: root });
    run("git", ["branch", "-D", local], { cwd: root });
    fs.rmSync(tmp, { recursive: true, force: true });
    release();
  }
}

function done(root, entry) {
  logLine(root, { action: `review:${entry.action}`, ...entry });
  return entry;
}
