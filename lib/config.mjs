// Load and validate a project's .claude/crew.json. One hand-written validator, no dependencies.
import fs from "node:fs";
import path from "node:path";

export const CONFIG_REL = path.join(".claude", "crew.json");

/** crew's own full test run after the agent, at most this long (minutes). */
export const TEST_TIMEOUT_MIN = 30;

/**
 * Minutes a scheduled dispatch/watch/review run may live. A tick lives as long as its workers: the
 * agent (caps.wall_min), crew's own test run, then push and PR, plus margin. Shorter, and Task
 * Scheduler kills a worker mid-push.
 */
export const runLimitMin = (caps) => caps.wall_min + TEST_TIMEOUT_MIN + 15;

export const DEFAULTS = Object.freeze({
  default_branch: "main",
  agent_branch_prefix: "agent/",
  protected_paths: [],
  protected_paths_cmd: null,
  test_cmd: null,
  wip_cap: 2,
  parallel: 1,
  protected_draft: true,
  merge: null,
  caps: {
    max_turns: 60,
    max_budget_usd: 5,
    wall_min: 40,
    idle_min: 10,
    canary_sec: 300,
    issue_budget_usd: 15,
    issue_attempts: 2,
    fix_rounds: 3,
    sync_rounds: 2,
    infra_retries: 2,
    daily_budget_usd: 25,
  },
  brief: { sources: [], deliver: "pr" },
  roles: [],
  slack: null,
  machines: null,
  dispatch_hours: null,
  review: null,
  gate_comment_prefix: null,
});

const TOP_KEYS = new Set([
  "$schema", "repo", "owner_login", "default_branch", "agent_branch_prefix", "protected_paths",
  "protected_paths_cmd", "test_cmd", "wip_cap", "parallel", "protected_draft", "merge", "caps", "brief", "roles", "slack", "machines", "dispatch_hours", "review",
  "gate_comment_prefix",
]);
const SLACK_KEYS = new Set(["channel", "board", "news", "commanders"]);
const MACHINE_RE = /^[a-z][a-z0-9-]{0,19}$/;
const CAP_KEYS = Object.keys(DEFAULTS.caps);
const BRIEF_KEYS = new Set(["sources", "deliver"]);
const DELIVER = new Set(["pr", "local", "commit"]);
const CMD_OS = new Set(["default", "darwin", "linux", "win32"]);
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const BRANCH_RE = /^[A-Za-z0-9._\/-]+$/;

export class ConfigError extends Error {
  constructor(problems) {
    super(`invalid crew config:\n  - ${problems.join("\n  - ")}`);
    this.problems = problems;
  }
}

/** Merge defaults under a raw object, then validate. Returns the full config or throws ConfigError. */
export function normalize(raw) {
  const problems = validate(raw);
  if (problems.length) throw new ConfigError(problems);
  return {
    ...structuredClone(DEFAULTS),
    ...raw,
    caps: { ...DEFAULTS.caps, ...(raw.caps ?? {}) },
    brief: { ...DEFAULTS.brief, ...(raw.brief ?? {}) },
    slack: raw.slack ? { board: true, news: true, commanders: [], ...raw.slack } : null,
    machines: raw.machines ? { helpers: [], ...raw.machines } : null,
    review: raw.review ? { bash: [], budget_usd: 5, max_issues: 8, ...raw.review } : null,
  };
}

/** Return a list of human-readable problems; empty means valid. */
export function validate(raw) {
  const p = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return ["config must be a JSON object"];

  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) p.push(`unknown key "${k}" (typo?)`);

  if (typeof raw.repo !== "string" || !REPO_RE.test(raw.repo)) p.push(`"repo" must be "owner/name"`);
  if (typeof raw.owner_login !== "string" || !LOGIN_RE.test(raw.owner_login))
    p.push(`"owner_login" must be the GitHub login allowed to mark issues ready`);

  const branch = raw.default_branch ?? DEFAULTS.default_branch;
  if (typeof branch !== "string" || !BRANCH_RE.test(branch)) p.push(`"default_branch" is not a valid branch name`);

  const prefix = raw.agent_branch_prefix ?? DEFAULTS.agent_branch_prefix;
  if (typeof prefix !== "string" || !BRANCH_RE.test(prefix) || !prefix.endsWith("/"))
    p.push(`"agent_branch_prefix" must be a branch prefix ending in "/" (e.g. "agent/")`);
  else if (typeof branch === "string" && (branch === prefix.slice(0, -1) || branch.startsWith(prefix)))
    p.push(`"agent_branch_prefix" must not cover the default branch`);

  if ("protected_paths" in raw && !isStringArray(raw.protected_paths))
    p.push(`"protected_paths" must be an array of glob strings`);
  for (const k of ["protected_paths_cmd", "test_cmd"]) {
    if (!(k in raw) || raw[k] === null) continue;
    const v = raw[k];
    if (typeof v === "string") {
      if (!v.trim()) p.push(`"${k}" must be a non-empty command string, a per-OS object, or null`);
    } else if (isPlainObject(v)) {
      const keys = Object.keys(v);
      for (const os of keys) if (!CMD_OS.has(os)) p.push(`"${k}.${os}" is not one of: ${[...CMD_OS].join(", ")}`);
      for (const os of keys) if (typeof v[os] !== "string" || !v[os].trim()) p.push(`"${k}.${os}" must be a non-empty command string`);
      if (!keys.length) p.push(`"${k}" object is empty`);
    } else p.push(`"${k}" must be a non-empty command string, a per-OS object, or null`);
  }

  if ("wip_cap" in raw && !(Number.isInteger(raw.wip_cap) && raw.wip_cap >= 1 && raw.wip_cap <= 30))
    p.push(`"wip_cap" must be an integer from 1 to 30`);
  if ("protected_draft" in raw && typeof raw.protected_draft !== "boolean")
    p.push(`"protected_draft" must be true (a PR touching a protected path opens as a draft for the owner) or false (it opens normally, for the project's own PR gate)`);
  if ("merge" in raw && raw.merge !== null && raw.merge !== "codex-clean")
    p.push(`"merge" must be null (crew never merges) or "codex-clean" (crew merges an agent PR with green checks, a clean Codex review and no protected path)`);
  if ("gate_comment_prefix" in raw && raw.gate_comment_prefix !== null && !(typeof raw.gate_comment_prefix === "string" && raw.gate_comment_prefix.trim()))
    p.push(`"gate_comment_prefix" must be null or the non-empty start of the project's PR-gate comments (e.g. "pr-gate (")`);
  if ("parallel" in raw && !(Number.isInteger(raw.parallel) && raw.parallel >= 1 && raw.parallel <= 20))
    p.push(`"parallel" must be an integer from 1 to 20 (dev workers run at the same time)`);

  if ("caps" in raw) {
    if (!isPlainObject(raw.caps)) p.push(`"caps" must be an object`);
    else {
      for (const k of Object.keys(raw.caps)) if (!CAP_KEYS.includes(k)) p.push(`unknown cap "caps.${k}"`);
      for (const k of CAP_KEYS) {
        if (!(k in raw.caps)) continue;
        const v = raw.caps[k];
        // Zero or negative is rejected on purpose: in several loop tools 0 means "unlimited".
        if (typeof v !== "number" || !Number.isFinite(v) || v <= 0)
          p.push(`"caps.${k}" must be a positive number (0 is not "unlimited" here; it is refused)`);
        else if (["max_turns", "issue_attempts", "fix_rounds", "sync_rounds", "infra_retries"].includes(k) && !Number.isInteger(v))
          p.push(`"caps.${k}" must be a whole number`);
      }
      const c = { ...DEFAULTS.caps, ...raw.caps };
      if (Number.isFinite(c.max_budget_usd) && Number.isFinite(c.issue_budget_usd) && c.max_budget_usd > c.issue_budget_usd)
        p.push(`"caps.max_budget_usd" (per run) must not exceed "caps.issue_budget_usd" (per issue)`);
      if (Number.isFinite(c.issue_budget_usd) && Number.isFinite(c.daily_budget_usd) && c.issue_budget_usd > c.daily_budget_usd)
        p.push(`"caps.issue_budget_usd" must not exceed "caps.daily_budget_usd"`);
      if (Number.isFinite(c.idle_min) && Number.isFinite(c.wall_min) && c.idle_min > c.wall_min)
        p.push(`"caps.idle_min" must not exceed "caps.wall_min"`);
    }
  }

  if ("brief" in raw) {
    if (!isPlainObject(raw.brief)) p.push(`"brief" must be an object`);
    else {
      for (const k of Object.keys(raw.brief)) if (!BRIEF_KEYS.has(k)) p.push(`unknown key "brief.${k}"`);
      if ("sources" in raw.brief && !isStringArray(raw.brief.sources))
        p.push(`"brief.sources" must be an array of repo-relative paths`);
      else for (const s of raw.brief.sources ?? [])
        if (path.isAbsolute(s) || s.split(/[\\/]/).includes("..")) p.push(`"brief.sources" entry "${s}" must stay inside the repo`);
      if ("deliver" in raw.brief && !DELIVER.has(raw.brief.deliver))
        p.push(`"brief.deliver" must be one of: ${[...DELIVER].join(", ")}`);
    }
  }

  if ("roles" in raw) {
    if (!Array.isArray(raw.roles)) p.push(`"roles" must be an array`);
    else for (const r of raw.roles) {
      const name = typeof r === "string" ? r : r?.name;
      if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
        p.push(`each role must be a name like "ops", or {"name": "ops", "memory": "path/to/ops.md"}`);
        continue;
      }
      if (typeof r === "object") {
        for (const k of Object.keys(r)) if (!["name", "memory"].includes(k)) p.push(`unknown key "${k}" in role "${name}"`);
        if ("memory" in r && (typeof r.memory !== "string" || path.isAbsolute(r.memory) || r.memory.split(/[\\/]/).includes("..")))
          p.push(`role "${name}" memory must be a repo-relative path`);
      }
      if (["pm", "dev", "implementer"].includes(name)) p.push(`role "${name}" is built in; list only the project's own roles`);
    }
  }
  if ("slack" in raw && raw.slack !== null) {
    if (!isPlainObject(raw.slack)) p.push(`"slack" must be an object or null`);
    else {
      for (const k of Object.keys(raw.slack)) if (!SLACK_KEYS.has(k)) p.push(`unknown key "slack.${k}"`);
      if (typeof raw.slack.channel !== "string" || !/^[CG][A-Z0-9]{6,}$/.test(raw.slack.channel))
        p.push(`"slack.channel" must be a Slack channel ID like "C0123ABCD" (channel details, bottom of the About tab)`);
      for (const k of ["board", "news"]) if (k in raw.slack && typeof raw.slack[k] !== "boolean") p.push(`"slack.${k}" must be true or false`);
      if ("commanders" in raw.slack && !(Array.isArray(raw.slack.commanders) && raw.slack.commanders.every((u) => typeof u === "string" && /^[UW][A-Z0-9]{6,}$/.test(u))))
        p.push(`"slack.commanders" must be a list of Slack user IDs like "U0123ABCD" (profile > ... > Copy member ID)`);
    }
  }

  if ("review" in raw && raw.review !== null) {
    const r = raw.review;
    if (!isPlainObject(r)) p.push(`"review" must be an object like {"routine": "docs/self-review.md"}`);
    else {
      for (const k of Object.keys(r)) if (!["routine", "bash", "budget_usd", "max_issues"].includes(k)) p.push(`unknown key "review.${k}"`);
      if (typeof r.routine !== "string" || !r.routine || path.isAbsolute(r.routine) || r.routine.split(/[\\/]/).includes(".."))
        p.push(`"review.routine" must be a repo-relative path to the review routine`);
      if ("bash" in r && !(Array.isArray(r.bash) && r.bash.every((b) => (typeof b === "string" && b.trim()) || (isPlainObject(b) && Object.values(b).every((v) => typeof v === "string" && v.trim())))))
        p.push(`"review.bash" must be a list of command prefixes the reviewer may run (strings or per-OS objects)`);
      if ("budget_usd" in r && !(typeof r.budget_usd === "number" && r.budget_usd > 0)) p.push(`"review.budget_usd" must be a positive number`);
      if ("max_issues" in r && !(Number.isInteger(r.max_issues) && r.max_issues >= 0 && r.max_issues <= 20)) p.push(`"review.max_issues" must be a whole number from 0 to 20`);
    }
  }

  if ("dispatch_hours" in raw && raw.dispatch_hours !== null) {
    const h = raw.dispatch_hours;
    if (!Array.isArray(h) || !h.length || !h.every((w) => typeof w === "string" && parseWindow(w)))
      p.push(`"dispatch_hours" must be a list of local-time windows like ["14:00-19:45"] (or null for any time)`);
  }

  if ("machines" in raw && raw.machines !== null) {
    const m = raw.machines;
    if (!isPlainObject(m)) p.push(`"machines" must be an object like {"main": "pc", "helpers": ["mac"]}`);
    else {
      for (const k of Object.keys(m)) if (!["main", "helpers"].includes(k)) p.push(`unknown key "machines.${k}"`);
      if (typeof m.main !== "string" || !MACHINE_RE.test(m.main)) p.push(`"machines.main" must be a short lowercase name like "pc"`);
      if ("helpers" in m && !(Array.isArray(m.helpers) && m.helpers.every((h) => typeof h === "string" && MACHINE_RE.test(h))))
        p.push(`"machines.helpers" must be a list of short lowercase names like ["mac"]`);
      const all = [m.main, ...(Array.isArray(m.helpers) ? m.helpers : [])];
      if (new Set(all).size !== all.length) p.push(`"machines" names must be different from each other`);
      for (const n of all) if (["ready", "doing", "in-review", "blocked", "needs-jk"].includes(n)) p.push(`machine name "${n}" clashes with a crew state label`);
    }
  }
  return p;
}

/** "HH:MM-HH:MM" -> {from, to} in minutes after midnight, or null. A window may cross midnight. */
export function parseWindow(w) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(String(w).trim());
  if (!m) return null;
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = Number(m[3]) * 60 + Number(m[4]);
  return from === to ? null : { from, to };
}

/** Is `now` (local time) inside one of the config's dispatch windows? Always true when none are set. */
export function inDispatchHours(config, now = new Date()) {
  if (!config.dispatch_hours) return true;
  const t = now.getHours() * 60 + now.getMinutes();
  return config.dispatch_hours.map(parseWindow).some(({ from, to }) => (from < to ? t >= from && t < to : t >= from || t < to));
}

/** Every machine name in the config (main first), or [] when routing is off. */
export function machineNames(config) {
  return config.machines ? [config.machines.main, ...config.machines.helpers] : [];
}

/** Find the repo root (directory containing .git) at or above `start`. */
export function findRepoRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Read + normalize the config for the repo at `root`. Throws ConfigError or a file error. */
export function loadConfig(root, configPath = null) {
  const file = configPath ? path.resolve(configPath) : path.join(root, CONFIG_REL);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT")
      throw new ConfigError([configPath ? `config file not found: ${file}` : `no ${CONFIG_REL} in ${root} (run "crew init")`]);
    throw e;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError([`${CONFIG_REL} is not valid JSON: ${e.message}`]);
  }
  return normalize(raw);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isStringArray(v) {
  return Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);
}

/** Roles as [{name, memory}], with the default memory file docs/handoff/<role>.md. */
export function roleList(config) {
  return (config.roles ?? []).map((r) => (typeof r === "string" ? { name: r, memory: `docs/handoff/${r}.md` } : { memory: `docs/handoff/${r.name}.md`, ...r }));
}

/**
 * A command for this machine: a string, or {darwin|linux|win32|default}. `${root}` becomes the
 * project's main checkout (so a worktree can still reach an untracked .venv). null if none applies.
 */
export function resolveCmd(v, root, platform = process.platform) {
  if (v === null || v === undefined) return null;
  const s = typeof v === "string" ? v : v[platform] ?? v.default ?? null;
  if (s === null) return null;
  if (!/\s/.test(root)) return s.split("${root}").join(root);
  // A root with a space ("X:\\Claude\\Claude Trading") must be quoted, or cmd and sh split the path
  // ("'X:\\Claude\\Claude' is not recognized", PC 2026-11-09). Quote the whole path token, unless
  // the config already quoted it.
  return s.replace(/(^|[^"\w])\$\{root\}([^\s"]*)/g, (_, pre, rest) => `${pre}"${root}${rest}"`).split("${root}").join(root);
}

/**
 * The main checkout for a repo root that may be a linked worktree (where `.git` is a file
 * "gitdir: <main>/.git/worktrees/<name>"). Untracked files such as a .venv live only there.
 */
export function mainCheckout(root) {
  const dotgit = path.join(root, ".git");
  try {
    if (fs.statSync(dotgit).isDirectory()) return root;
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, "utf8"));
    if (!m) return root;
    const gitdir = path.resolve(root, m[1].trim());
    const parts = gitdir.split(path.sep);
    const i = parts.lastIndexOf("worktrees");
    return i > 0 && parts[i - 1] === ".git" ? parts.slice(0, i - 1).join(path.sep) || path.sep : root;
  } catch {
    return root;
  }
}
