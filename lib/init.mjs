// `crew init`: write .claude/crew.json from detected values, flags, or answers.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { run as realRun } from "./exec.mjs";
import { CONFIG_REL, DEFAULTS, findRepoRoot, normalize } from "./config.mjs";
import { repoFromRemote } from "./doctor.mjs";

/** Work out sensible defaults from the repo and gh. Missing values stay undefined. */
export function detect(root, run = realRun) {
  const out = {};
  const origin = run("git", ["remote", "get-url", "origin"], { cwd: root });
  if (origin.ok) out.repo = repoFromRemote(origin.stdout.trim()) ?? undefined;
  const head = run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: root });
  if (head.ok) out.default_branch = head.stdout.trim().replace(/^origin\//, "") || undefined;
  const me = run("gh", ["api", "user", "--jq", ".login"]);
  if (me.ok) out.owner_login = me.stdout.trim() || undefined;
  return out;
}

/** Build the config object (explicit, with every cap written out) from detected values + flags. */
export function buildConfig(detected, flags) {
  const raw = {
    repo: flags.repo ?? detected.repo,
    owner_login: flags.owner ?? detected.owner_login,
    default_branch: flags["default-branch"] ?? detected.default_branch ?? DEFAULTS.default_branch,
    agent_branch_prefix: flags["branch-prefix"] ?? DEFAULTS.agent_branch_prefix,
    protected_paths: flags.protected ?? [],
    protected_paths_cmd: null,
    test_cmd: flags["test-cmd"] ?? null,
    wip_cap: flags["wip-cap"] !== undefined ? Number(flags["wip-cap"]) : DEFAULTS.wip_cap,
    caps: { ...DEFAULTS.caps },
    brief: { sources: [], deliver: DEFAULTS.brief.deliver },
    roles: flags.roles ? String(flags.roles).split(",").map((s) => s.trim()).filter(Boolean) : [],
  };
  return normalize(raw); // throws ConfigError with every problem listed
}

export async function init({ cwd = process.cwd(), flags = {}, run = realRun, stdin = process.stdin, stdout = process.stdout } = {}) {
  const root = findRepoRoot(cwd);
  if (!root) throw new Error(`${cwd} is not inside a git repository`);
  const file = path.join(root, CONFIG_REL);
  if (fs.existsSync(file) && !flags.force && !flags.print)
    throw new Error(`${CONFIG_REL} already exists (use --force to overwrite, --print to preview)`);

  const detected = detect(root, run);
  if (!flags.yes && !flags.print && stdin.isTTY) await ask(detected, flags, stdin, stdout);

  const { repo, owner_login, ...rest } = buildConfig(detected, flags);
  const config = { repo, owner_login, ...rest }; // identity first, so the file reads top-down
  const text = JSON.stringify(config, null, 2) + "\n";
  if (flags.print) {
    stdout.write(text);
    return { file: null, config };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  return { file, config };
}

async function ask(detected, flags, stdin, stdout) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const q = async (label, key, current) => {
      if (flags[key] !== undefined) return;
      const a = (await rl.question(`${label}${current ? ` [${current}]` : ""}: `)).trim();
      if (a) flags[key] = a;
    };
    await q("GitHub repo (owner/name)", "repo", detected.repo);
    await q("Login allowed to mark issues ready", "owner", detected.owner_login);
    await q("Default branch", "default-branch", detected.default_branch ?? DEFAULTS.default_branch);
    await q("Project roles, comma separated (e.g. trade,ops)", "roles", "");
    await q("Test command (blank for none)", "test-cmd", "");
  } finally {
    rl.close();
  }
}
