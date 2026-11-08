// `crew doctor`: read-only checks that the machine and the project are ready. Never prints secrets.
import { run as realRun } from "./exec.mjs";
import { findRepoRoot, loadConfig, ConfigError, CONFIG_REL, resolveCmd } from "./config.mjs";
import { oauthTokenStatus } from "./secrets.mjs";

const MIN_NODE = 20;

/**
 * Run every check. `deps` lets tests swap the outside world.
 * Returns {checks: [{name, status: "ok"|"warn"|"fail", detail}], config}.
 */
export function doctor({ cwd = process.cwd(), configPath = null, env = process.env, run = realRun, nodeVersion = process.versions.node, platform = process.platform } = {}) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  // 1. Node
  const major = Number(nodeVersion.split(".")[0]);
  add("node", major >= MIN_NODE ? "ok" : "fail", `v${nodeVersion}${major >= MIN_NODE ? "" : ` (need ${MIN_NODE}+)`}`);

  // 2. Billing trap: an API key in the environment overrides the subscription.
  if (env.ANTHROPIC_API_KEY) add("anthropic api key", "fail", "ANTHROPIC_API_KEY is set: runs would bill the API, not your subscription. Unset it.");
  else add("anthropic api key", "ok", "not set (runs use your subscription)");
  if (env.ANTHROPIC_AUTH_TOKEN) add("anthropic auth token", "warn", "ANTHROPIC_AUTH_TOKEN is set; check it is intended");

  // 3. Claude Code
  const cv = run("claude", ["--version"]);
  if (!cv.ok) add("claude", "fail", cv.missing ? "claude not found on PATH" : `claude --version failed: ${firstLine(cv.stderr)}`);
  else add("claude", "ok", firstLine(cv.stdout));

  // 4. Long-lived token for scheduled runs
  const tok = oauthTokenStatus(env, platform);
  if (!tok.present) add("oauth token", "warn", `CLAUDE_CODE_OAUTH_TOKEN not found (needed for scheduled runs from Phase 4; create with "claude setup-token", store in ${tok.file})`);
  else if (tok.looseMode) add("oauth token", "warn", `found in ${tok.source}, but ${tok.file} is readable by other users (chmod 600)`);
  else add("oauth token", "ok", `found in ${tok.source}`);

  // 5. GitHub CLI + auth
  const gv = run("gh", ["--version"]);
  let ghOk = gv.ok;
  if (!gv.ok) add("gh", "fail", gv.missing ? "gh not found on PATH" : `gh --version failed: ${firstLine(gv.stderr)}`);
  else {
    const as = run("gh", ["auth", "status", "--hostname", "github.com"]);
    const text = `${as.stdout}\n${as.stderr}`;
    if (!as.ok) {
      ghOk = false;
      add("gh auth", "fail", "not logged in to github.com (run \"gh auth login\")");
    } else {
      const scopes = parseScopes(text);
      if (scopes === null) add("gh auth", "warn", "logged in; token scopes not shown (fine-grained token?) - repo write access is checked below");
      else if (!scopes.includes("repo")) add("gh auth", "fail", `logged in, but token lacks the "repo" scope (has: ${scopes.join(", ") || "none"})`);
      else add("gh auth", "ok", `logged in; scopes: ${scopes.join(", ")}`);
    }
  }

  // 6. Repo + config
  const root = findRepoRoot(cwd);
  if (!root) {
    add("git repo", "fail", `${cwd} is not inside a git repository`);
    return { checks, config: null };
  }
  add("git repo", "ok", root);

  let config = null;
  try {
    config = loadConfig(root, configPath);
    add("crew config", "ok", `${configPath ?? CONFIG_REL} valid`);
  } catch (e) {
    add("crew config", "fail", e instanceof ConfigError ? e.problems.join("; ") : e.message);
    return { checks, config: null };
  }

  if (!config.protected_paths.length && !config.protected_paths_cmd)
    add("protected paths", "warn", "none configured: agent PRs touching any file will be ordinary PRs");
  else if (config.protected_paths_cmd && !resolveCmd(config.protected_paths_cmd, root, platform))
    add("protected paths", "fail", `protected_paths_cmd has no entry for ${platform} and no "default"`);
  else add("protected paths", "ok", config.protected_paths_cmd ? `checked by: ${resolveCmd(config.protected_paths_cmd, root, platform)}` : `${config.protected_paths.length} pattern(s)`);
  if (config.test_cmd && !resolveCmd(config.test_cmd, root, platform))
    add("test command", "warn", `test_cmd has no entry for ${platform}: the dev worker will run without tests`);
  else if (config.test_cmd) add("test command", "ok", resolveCmd(config.test_cmd, root, platform));

  // Run state (ledger, lock, logs) must never be committed.
  const ign = run("git", ["check-ignore", "-q", ".crew/ledger.json"], { cwd: root });
  if (ign.code === 0) add("crew state ignored", "ok", ".crew/ is in .gitignore");
  else add("crew state ignored", "warn", 'add ".crew/" to .gitignore (run state: ledger, lock, logs)');

  // 7. Origin remote matches the configured repo
  const origin = run("git", ["remote", "get-url", "origin"], { cwd: root });
  const originRepo = origin.ok ? repoFromRemote(origin.stdout.trim()) : null;
  if (!originRepo) add("git origin", "warn", "no GitHub origin remote found");
  else if (originRepo.toLowerCase() !== config.repo.toLowerCase())
    add("git origin", "fail", `origin is ${originRepo}, config says ${config.repo}`);
  else add("git origin", "ok", originRepo);

  if (!ghOk) return { checks, config };

  // 8. Repo reachable, branch, permission, visibility
  const rv = run("gh", ["repo", "view", config.repo, "--json", "nameWithOwner,visibility,defaultBranchRef,viewerPermission"]);
  if (!rv.ok) add("github repo", "fail", `cannot read ${config.repo}: ${firstLine(rv.stderr)}`);
  else {
    let info;
    try {
      info = JSON.parse(rv.stdout);
    } catch {
      info = null;
    }
    if (!info) add("github repo", "fail", "unexpected output from gh repo view");
    else {
      const perm = info.viewerPermission;
      const canWrite = ["ADMIN", "MAINTAIN", "WRITE"].includes(perm);
      add("github repo", canWrite ? "ok" : "fail", `${info.nameWithOwner} (${String(info.visibility).toLowerCase()}, your access: ${String(perm).toLowerCase()})`);
      const remoteDefault = info.defaultBranchRef?.name;
      if (remoteDefault && remoteDefault !== config.default_branch)
        add("default branch", "fail", `GitHub says "${remoteDefault}", config says "${config.default_branch}"`);
      else add("default branch", "ok", config.default_branch);
      if (info.visibility === "PRIVATE")
        add("github plan note", "warn", "private repo: on GitHub Free there is no branch protection or auto-merge, so the dispatcher's local guards are the only push guard");
    }
  }

  // 9. Who gh is logged in as vs who may mark issues ready
  const me = run("gh", ["api", "user", "--jq", ".login"]);
  if (me.ok) {
    const login = me.stdout.trim();
    if (login.toLowerCase() === config.owner_login.toLowerCase())
      add("github identity", "ok", `logged in as ${login} (the owner)`);
    else add("github identity", "warn", `logged in as ${login}; owner_login is ${config.owner_login} (fine for a builder machine account)`);
  }

  return { checks, config };
}

export function parseScopes(text) {
  const m = text.match(/Token scopes:\s*(.*)/i);
  if (!m) return null;
  return m[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}

export function repoFromRemote(url) {
  const m = url.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function formatChecks(checks) {
  const tag = { ok: "OK  ", warn: "WARN", fail: "FAIL" };
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks.map((c) => `${tag[c.status]}  ${c.name.padEnd(width)}  ${c.detail}`).join("\n");
}

function firstLine(s) {
  return String(s ?? "").trim().split(/\r?\n/)[0] ?? "";
}
