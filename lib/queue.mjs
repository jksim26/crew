// The work queue lives in GitHub issues. State is one crew label per issue.
import fs from "node:fs";
import { run as realRun } from "./exec.mjs";
import { gh, ghJson } from "./gh.mjs";
import { sanitize } from "./collect.mjs";

export const STATES = {
  ready: { color: "0E8A16", description: "crew: approved by the owner; the dev worker may take it" },
  doing: { color: "1D76DB", description: "crew: the dev worker is building it now" },
  "in-review": { color: "5319E7", description: "crew: PR open, waiting for review" },
  blocked: { color: "B60205", description: "crew: stuck; the issue says what the owner must do" },
  "needs-jk": { color: "FBCA04", description: "crew: needs the owner (proposal, decision or protected change)" },
};
const STATE_NAMES = Object.keys(STATES);

export function ensureLabels(config, run = realRun) {
  const done = [];
  for (const [name, { color, description }] of Object.entries(STATES)) {
    gh(run, ["label", "create", name, "--repo", config.repo, "--color", color, "--description", description, "--force"]);
    done.push(name);
  }
  return done;
}

function priorityOf(labels) {
  for (const l of labels) {
    const m = /^priority:(\d+)$/.exec(l);
    if (m) return Number(m[1]);
  }
  return Number.POSITIVE_INFINITY;
}

/** Who applied the issue's current `ready` label? null if it is not currently applied. */
export function readyLabeler(config, number, run = realRun) {
  const events = ghJson(run, ["api", "--paginate", "--slurp", `repos/${config.repo}/issues/${number}/events?per_page=100`]) ?? [];
  const flat = events.flat();
  let actor = null;
  for (const e of flat) {
    if (e?.label?.name !== "ready") continue;
    if (e.event === "labeled") actor = e.actor?.login ?? null;
    else if (e.event === "unlabeled") actor = null;
  }
  return actor;
}

/**
 * Open issues labelled `ready` (and no other crew state), ordered by `priority:N` then age.
 * Only issues whose `ready` label was applied by `owner_login` are eligible.
 * @returns {{issue: object|null, skipped: {number:number, reason:string}[]}}
 */
export function nextIssue(config, { run = realRun, exclude = () => null } = {}) {
  const list = ghJson(run, ["issue", "list", "--repo", config.repo, "--state", "open", "--label", "ready", "--limit", "100",
    "--json", "number,title,body,labels,createdAt,url"]) ?? [];
  const items = list.map((i) => ({ ...i, labels: (i.labels ?? []).map((l) => l.name) }))
    .sort((a, b) => priorityOf(a.labels) - priorityOf(b.labels) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const skipped = [];
  for (const i of items) {
    const other = i.labels.filter((l) => l !== "ready" && STATE_NAMES.includes(l));
    if (other.length) {
      skipped.push({ number: i.number, reason: `also labelled ${other.join(", ")}` });
      continue;
    }
    const why = exclude(i);
    if (why) {
      skipped.push({ number: i.number, reason: why });
      continue;
    }
    const by = readyLabeler(config, i.number, run);
    if (!by || by.toLowerCase() !== config.owner_login.toLowerCase()) {
      skipped.push({ number: i.number, reason: `ready label applied by ${by ?? "unknown"}, not ${config.owner_login}` });
      continue;
    }
    return { issue: i, skipped };
  }
  return { issue: null, skipped };
}

/** Move an issue to one crew state (removing the others) and optionally comment why. */
export function setState(config, number, state, { reason = null, run = realRun } = {}) {
  if (!STATE_NAMES.includes(state)) throw new Error(`unknown state "${state}" (one of: ${STATE_NAMES.join(", ")})`);
  const cur = ghJson(run, ["issue", "view", String(number), "--repo", config.repo, "--json", "labels"]);
  const present = (cur?.labels ?? []).map((l) => l.name).filter((l) => STATE_NAMES.includes(l) && l !== state);
  const args = ["issue", "edit", String(number), "--repo", config.repo, "--add-label", state];
  if (present.length) args.push("--remove-label", present.join(","));
  gh(run, args);
  if (reason) gh(run, ["issue", "comment", String(number), "--repo", config.repo, "--body-file", "-"], { input: `**crew:** ${reason}` });
  return { state, removed: present };
}

/** Text of an issue that is safe to put in a prompt: hidden content removed, length bounded. */
export function issueForPrompt(issue) {
  const body = String(issue.body ?? "")
    .replace(/^\s*\[[^\]]*\]:\s*#\s*(?:\(.*\)|".*")\s*$/gm, "") // markdown "comments": [//]: # (...)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  return { number: issue.number, title: sanitize(issue.title, 300), body: sanitize(body, 12_000), url: issue.url };
}

/** Create a proposal issue. Never labels `ready`: only the owner marks work ready. */
export function newIssue(config, { title, body, label = "needs-jk", run = realRun }) {
  if (label === "ready") throw new Error(`refusing to create an issue as "ready"; only the owner marks work ready`);
  const out = gh(run, ["issue", "create", "--repo", config.repo, "--title", title, "--body-file", "-", "--label", label], { input: body });
  return out.trim().split("\n").pop();
}

/**
 * Parse a markdown checklist into tasks: each `- [ ] title` line plus its indented body.
 * `section` limits parsing to one heading (text match) until the next heading of the same or higher level.
 */
export function parseChecklist(text, { section = null } = {}) {
  let lines = text.split(/\r?\n/);
  if (section) {
    const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, "").trim() === section.replace(/^#+\s*/, "").trim());
    if (start < 0) throw new Error(`section "${section}" not found`);
    const level = lines[start].match(/^#+/)[0].length;
    const end = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l) && l.match(/^#+/)[0].length <= level);
    lines = lines.slice(start + 1, end < 0 ? undefined : end);
  }
  const tasks = [];
  let cur = null;
  for (const line of lines) {
    const m = /^(\s*)- \[( |x|X)\]\s+(.*)$/.exec(line);
    if (m && m[1].length === 0) {
      if (cur) tasks.push(cur);
      cur = m[2] === " " ? { title: cleanTitle(m[3]), body: [] } : null;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      if (cur) tasks.push(cur);
      cur = null;
      continue;
    }
    if (cur) cur.body.push(line);
  }
  if (cur) tasks.push(cur);
  return tasks.map((t) => ({ title: t.title, body: dedent(t.body.join("\n")).trim() }));
}

function cleanTitle(s) {
  return s.replace(/\*\*/g, "").replace(/`/g, "").trim().slice(0, 240);
}
function dedent(s) {
  const ind = Math.min(...s.split("\n").filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  return Number.isFinite(ind) ? s.split("\n").map((l) => l.slice(ind)).join("\n") : s;
}

/** Import tasks as issues, skipping titles that already exist as open issues. */
export function importChecklist(config, file, { section = null, label = "needs-jk", dryRun = false, run = realRun } = {}) {
  const tasks = parseChecklist(fs.readFileSync(file, "utf8"), { section });
  const existing = new Set((ghJson(run, ["issue", "list", "--repo", config.repo, "--state", "open", "--limit", "500", "--json", "title"]) ?? []).map((i) => i.title));
  const result = [];
  for (const t of tasks) {
    if (existing.has(t.title)) {
      result.push({ title: t.title, action: "skip (exists)" });
      continue;
    }
    if (dryRun) {
      result.push({ title: t.title, action: `would create (${label})` });
      continue;
    }
    const url = newIssue(config, { title: t.title, body: `${t.body}\n\n_Imported by crew from \`${file.split(/[\\/]/).pop()}\`._`, label, run });
    result.push({ title: t.title, action: "created", url });
  }
  return result;
}
