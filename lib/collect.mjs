// Gather what the PM needs, with no model involved: PRs, issues by crew label, commits, reviews,
// and the tails of the project's own log files. Everything from GitHub is sanitized and truncated.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { run as realRun } from "./exec.mjs";

export const CREW_LABELS = ["ready", "doing", "in-review", "blocked", "needs-jk"];
const DAY = 86_400_000;
const SOURCE_LINES = 150;
const SOURCE_BYTES = 16_000;
const MAX_REVIEW_PRS = 10;

/** Remove things that hide text from a human reader: HTML comments, zero-width and bidi characters. */
export function sanitize(text, max = 600) {
  let s = String(text ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[​-‏‪-‮⁠-⁤﻿]/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (s.length > max) s = s.slice(0, max) + " …[truncated]";
  return s;
}

function ghJson(run, args) {
  const r = run("gh", args, { timeoutMs: 60_000 });
  if (!r.ok) throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${String(r.stderr).trim().split("\n")[0]}`);
  return JSON.parse(r.stdout || "null");
}

export function tailFile(file, lines = SOURCE_LINES, bytes = SOURCE_BYTES) {
  const text = fs.readFileSync(file, "utf8");
  let all = text.split(/\r?\n/);
  let tail = all.slice(-lines).join("\n");
  let truncated = all.length > lines;
  if (tail.length > bytes) {
    tail = tail.slice(-bytes);
    truncated = true;
  }
  return { tail, truncated };
}

/**
 * @param {{root:string, config:object, mode:"daily"|"weekly", now?:Date, lastBriefAt?:string|null, run?:Function}} o
 */
export function collect({ root, config, mode = "daily", now = new Date(), lastBriefAt = null, run = realRun }) {
  const repo = config.repo;
  const errors = [];
  const sinceMs = mode === "weekly" ? now - 7 * DAY : lastBriefAt ? Date.parse(lastBriefAt) : now - DAY;
  const since = new Date(Number.isFinite(sinceMs) ? sinceMs : now - DAY).toISOString();
  const ageDays = (iso) => Math.max(0, Math.floor((now - Date.parse(iso)) / DAY));

  // Repo must be reachable; everything else degrades into `errors`.
  ghJson(run, ["repo", "view", repo, "--json", "nameWithOwner"]);

  const soft = (label, fn, fallback) => {
    try {
      return fn();
    } catch (e) {
      errors.push(`${label}: ${e.message}`);
      return fallback;
    }
  };

  const merged = soft("merged PRs", () =>
    ghJson(run, ["pr", "list", "--repo", repo, "--state", "merged", "--search", `merged:>=${since.slice(0, 19)}Z`,
      "--limit", "50", "--json", "number,title,url,mergedAt,author,headRefName,body"]), []);
  const merged_prs = merged.map((p) => ({
    number: p.number, title: sanitize(p.title, 200), url: p.url, merged_at: p.mergedAt,
    author: p.author?.login ?? null, branch: p.headRefName, summary: sanitize(p.body, 500),
  }));

  const open = soft("open PRs", () =>
    ghJson(run, ["pr", "list", "--repo", repo, "--state", "open", "--limit", "50",
      "--json", "number,title,url,isDraft,createdAt,updatedAt,author,headRefName,reviewDecision,labels"]), []);
  const open_prs = open.map((p) => ({
    number: p.number, title: sanitize(p.title, 200), url: p.url, draft: !!p.isDraft,
    age_days: ageDays(p.createdAt), updated_at: p.updatedAt, author: p.author?.login ?? null,
    branch: p.headRefName, review_decision: p.reviewDecision || null,
    labels: (p.labels ?? []).map((l) => l.name),
    agent: typeof p.headRefName === "string" && p.headRefName.startsWith(config.agent_branch_prefix),
  })).sort((a, b) => b.age_days - a.age_days);

  const issuesRaw = soft("issues", () =>
    ghJson(run, ["issue", "list", "--repo", repo, "--state", "open", "--limit", "100",
      "--json", "number,title,url,labels,createdAt,updatedAt"]), []);
  const issues = Object.fromEntries(CREW_LABELS.map((l) => [l, []]));
  let other_open_issues = 0;
  for (const i of issuesRaw) {
    const names = (i.labels ?? []).map((l) => l.name);
    const item = { number: i.number, title: sanitize(i.title, 200), url: i.url, age_days: ageDays(i.createdAt), labels: names };
    const hit = CREW_LABELS.filter((l) => names.includes(l));
    if (!hit.length) other_open_issues++;
    for (const l of hit) issues[l].push(item);
  }

  const commitsRaw = soft("commits", () =>
    ghJson(run, ["api", `repos/${repo}/commits?sha=${encodeURIComponent(config.default_branch)}&since=${since}&per_page=50`]), []);
  const commits = (commitsRaw ?? []).map((c) => ({
    sha: String(c.sha).slice(0, 7), date: c.commit?.author?.date ?? null,
    author: c.author?.login ?? c.commit?.author?.name ?? null,
    message: sanitize(String(c.commit?.message ?? "").split("\n")[0], 160),
  }));

  // Recent review activity on PRs touched since the last brief.
  const recent = open_prs.filter((p) => Date.parse(p.updated_at) >= Date.parse(since))
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)).slice(0, MAX_REVIEW_PRS);
  const reviews = [];
  for (const p of recent) {
    const v = soft(`reviews on #${p.number}`, () =>
      ghJson(run, ["pr", "view", String(p.number), "--repo", repo, "--json", "reviews,comments"]), null);
    if (!v) continue;
    const items = [
      ...(v.reviews ?? []).map((r) => ({ kind: "review", author: r.author?.login, state: r.state, at: r.submittedAt, body: r.body })),
      ...(v.comments ?? []).map((c) => ({ kind: "comment", author: c.author?.login, at: c.createdAt, body: c.body })),
    ].filter((x) => x.at && Date.parse(x.at) >= Date.parse(since))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 3)
      .map((x) => ({ ...x, body: sanitize(x.body, 400) }));
    if (items.length) reviews.push({ pr: p.number, items });
  }

  // The project's own files: configured sources plus PROGRESS.md / LEARNINGS.md if present.
  const sourceList = [...new Set([...(config.brief.sources ?? []), "PROGRESS.md", "LEARNINGS.md"])];
  const sources = [];
  for (const rel of sourceList) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) {
      if ((config.brief.sources ?? []).includes(rel)) errors.push(`source ${rel}: not found`);
      continue;
    }
    const { tail, truncated } = tailFile(file);
    sources.push({ path: rel, tail: sanitize(tail, SOURCE_BYTES + 100), truncated });
  }

  const data = {
    repo, mode, generated_at: now.toISOString(), since,
    merged_prs, open_prs, issues, other_open_issues, commits, reviews, sources, errors,
  };
  data.fingerprint = fingerprint(data);
  return data;
}

/** A stable hash of what changed, so an unchanged day does not wake the model. */
export function fingerprint(d) {
  const basis = {
    merged: d.merged_prs.map((p) => p.number).sort(),
    open: d.open_prs.map((p) => [p.number, p.updated_at, p.draft, p.review_decision]).sort(),
    issues: Object.fromEntries(Object.entries(d.issues).map(([k, v]) => [k, v.map((i) => i.number).sort()])),
    commits: d.commits.map((c) => c.sha).sort(),
    sources: d.sources.map((s) => [s.path, crypto.createHash("sha256").update(s.tail).digest("hex")]),
  };
  return crypto.createHash("sha256").update(JSON.stringify(basis)).digest("hex").slice(0, 16);
}
