// Load and validate a project's .claude/crew.json. One hand-written validator, no dependencies.
import fs from "node:fs";
import path from "node:path";

export const CONFIG_REL = path.join(".claude", "crew.json");

export const DEFAULTS = Object.freeze({
  default_branch: "main",
  agent_branch_prefix: "agent/",
  protected_paths: [],
  protected_paths_cmd: null,
  test_cmd: null,
  wip_cap: 2,
  caps: {
    max_turns: 60,
    max_budget_usd: 5,
    wall_min: 40,
    idle_min: 10,
    issue_budget_usd: 15,
    issue_attempts: 2,
    daily_budget_usd: 25,
  },
  brief: { sources: [], deliver: "pr" },
  roles: [],
});

const TOP_KEYS = new Set([
  "$schema", "repo", "owner_login", "default_branch", "agent_branch_prefix", "protected_paths",
  "protected_paths_cmd", "test_cmd", "wip_cap", "caps", "brief", "roles",
]);
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

  if ("wip_cap" in raw && !(Number.isInteger(raw.wip_cap) && raw.wip_cap >= 1 && raw.wip_cap <= 10))
    p.push(`"wip_cap" must be an integer from 1 to 10`);

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
        else if ((k === "max_turns" || k === "issue_attempts") && !Number.isInteger(v))
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
  return p;
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
  return s === null ? null : s.split("${root}").join(root);
}
