import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, normalize, ConfigError, DEFAULTS } from "../lib/config.mjs";

const base = { repo: "jk/proj", owner_login: "jk" };

test("minimal config is valid and gets defaults", () => {
  assert.deepEqual(validate(base), []);
  const c = normalize(base);
  assert.equal(c.default_branch, "main");
  assert.equal(c.wip_cap, 2);
  assert.deepEqual(c.caps, DEFAULTS.caps);
  assert.equal(c.brief.deliver, "pr");
});

test("partial caps merge over defaults", () => {
  const c = normalize({ ...base, caps: { max_turns: 30 } });
  assert.equal(c.caps.max_turns, 30);
  assert.equal(c.caps.wall_min, DEFAULTS.caps.wall_min);
});

test("zero or negative caps are refused (0 never means unlimited)", () => {
  for (const v of [0, -1, NaN, "5"]) {
    const p = validate({ ...base, caps: { max_turns: v } });
    assert.ok(p.some((s) => s.includes("caps.max_turns")), `value ${v}`);
  }
});

test("whole-number caps reject fractions", () => {
  assert.ok(validate({ ...base, caps: { issue_attempts: 1.5 } }).some((s) => s.includes("whole number")));
});

test("budget ordering: run <= issue <= day, idle <= wall", () => {
  assert.ok(validate({ ...base, caps: { max_budget_usd: 20 } }).some((s) => s.includes("max_budget_usd")));
  assert.ok(validate({ ...base, caps: { issue_budget_usd: 30 } }).some((s) => s.includes("daily_budget_usd")));
  assert.ok(validate({ ...base, caps: { idle_min: 60 } }).some((s) => s.includes("idle_min")));
});

test("unknown keys are reported as typos", () => {
  assert.ok(validate({ ...base, wipcap: 2 }).some((s) => s.includes('unknown key "wipcap"')));
  assert.ok(validate({ ...base, caps: { max_turn: 5 } }).some((s) => s.includes("caps.max_turn")));
  assert.ok(validate({ ...base, brief: { deliverr: "pr" } }).some((s) => s.includes("brief.deliverr")));
});

test("repo and owner are required and shaped", () => {
  assert.ok(validate({ owner_login: "jk" }).some((s) => s.includes('"repo"')));
  assert.ok(validate({ repo: "nope", owner_login: "jk" }).some((s) => s.includes('"repo"')));
  assert.ok(validate({ repo: "jk/p" }).some((s) => s.includes("owner_login")));
});

test("agent branch prefix must end in / and must not cover the default branch", () => {
  assert.ok(validate({ ...base, agent_branch_prefix: "agent" }).some((s) => s.includes("ending in")));
  assert.ok(validate({ ...base, agent_branch_prefix: "main/" }).some((s) => s.includes("must not cover")));
  assert.ok(validate({ ...base, default_branch: "agent/x", agent_branch_prefix: "agent/" }).some((s) => s.includes("must not cover")));
});

test("wip cap range", () => {
  assert.ok(validate({ ...base, wip_cap: 0 }).length);
  assert.ok(validate({ ...base, wip_cap: 31 }).length);
  assert.deepEqual(validate({ ...base, wip_cap: 20, parallel: 13 }), []);
  assert.ok(validate({ ...base, parallel: 0 }).length);
  assert.deepEqual(validate({ ...base, wip_cap: 3 }), []);
});

test("brief sources must stay inside the repo; deliver is an enum", () => {
  assert.ok(validate({ ...base, brief: { sources: ["../secret"] } }).some((s) => s.includes("inside the repo")));
  assert.ok(validate({ ...base, brief: { sources: ["/etc/passwd"] } }).some((s) => s.includes("inside the repo")));
  assert.ok(validate({ ...base, brief: { deliver: "email" } }).some((s) => s.includes("brief.deliver")));
  assert.deepEqual(validate({ ...base, brief: { sources: ["wiki/log.md"], deliver: "local" } }), []);
});

test("roles accept names or {name, memory}; roleList fills default memory files", async () => {
  const { roleList } = await import("../lib/config.mjs");
  assert.deepEqual(validate({ ...base, roles: ["trade", { name: "ops", memory: "wiki/roles/ops.md" }] }), []);
  assert.ok(validate({ ...base, roles: [{ name: "ops", memory: "../x.md" }] }).some((s) => s.includes("repo-relative")));
  assert.ok(validate({ ...base, roles: [{ name: "ops", mem: "x" }] }).some((s) => s.includes('unknown key "mem"')));
  assert.ok(validate({ ...base, roles: ["Bad Name"] }).length);
  assert.deepEqual(roleList(normalize({ ...base, roles: ["trade", { name: "ops", memory: "wiki/roles/ops.md" }] })),
    [{ name: "trade", memory: "docs/handoff/trade.md" }, { name: "ops", memory: "wiki/roles/ops.md" }]);
});

test("built-in roles cannot be listed as project roles", () => {
  assert.ok(validate({ ...base, roles: ["trade", "pm"] }).some((s) => s.includes('"pm" is built in')));
});

test("commands: per-OS objects and ${root} substitution", async () => {
  const { resolveCmd } = await import("../lib/config.mjs");
  const v = { darwin: "${root}/.venv/bin/python -m pytest -q", win32: "${root}\\.venv\\Scripts\\python.exe -m pytest -q" };
  assert.deepEqual(validate({ ...base, test_cmd: v }), []);
  assert.equal(resolveCmd(v, "/r", "darwin"), "/r/.venv/bin/python -m pytest -q");
  assert.equal(resolveCmd(v, "C:\\r", "win32"), "C:\\r\\.venv\\Scripts\\python.exe -m pytest -q");
  assert.equal(resolveCmd(v, "/r", "linux"), null);
  assert.equal(resolveCmd({ default: "make test" }, "/r", "linux"), "make test");
  assert.equal(resolveCmd("npm test", "/r"), "npm test");
  assert.ok(validate({ ...base, test_cmd: { macos: "x" } }).some((s) => s.includes("test_cmd.macos")));
  assert.ok(validate({ ...base, test_cmd: {} }).some((s) => s.includes("empty")));
  assert.ok(validate({ ...base, test_cmd: 5 }).length);
});

test("mainCheckout follows a linked worktree back to the main checkout", async () => {
  const { mainCheckout } = await import("../lib/config.mjs");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "crew-wt-"));
  const main = path.join(base, "main");
  fs.mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
  const wt = path.join(base, "wt");
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`);
  assert.equal(mainCheckout(wt), main);
  assert.equal(mainCheckout(main), main);
  assert.equal(mainCheckout(path.join(base, "nope")), path.join(base, "nope"));
});

test("commands must be non-empty strings or null", () => {
  assert.ok(validate({ ...base, test_cmd: "" }).length);
  assert.deepEqual(validate({ ...base, test_cmd: null, protected_paths_cmd: "python check.py" }), []);
});

test("normalize throws ConfigError listing every problem", () => {
  assert.throws(() => normalize({ repo: "x" }), (e) => e instanceof ConfigError && e.problems.length >= 2);
});

test("non-object config is refused", () => {
  assert.deepEqual(validate([]), ["config must be a JSON object"]);
  assert.deepEqual(validate(null), ["config must be a JSON object"]);
});

test("resolveCmd quotes a root with spaces, once, and leaves quoted or space-free paths alone", async () => {
  const { resolveCmd } = await import("../lib/config.mjs");
  const win = '${root}\\.venv\\Scripts\\python.exe -m pytest -q -m "not integration"';
  assert.equal(resolveCmd(win, "X:\\Claude\\Claude Trading"), '"X:\\Claude\\Claude Trading\\.venv\\Scripts\\python.exe" -m pytest -q -m "not integration"');
  assert.equal(resolveCmd('"${root}/.venv/bin/python" -m pytest', "/a b"), '"/a b/.venv/bin/python" -m pytest');
  assert.equal(resolveCmd("${root}/.venv/bin/python -m pytest", "/ab"), "/ab/.venv/bin/python -m pytest");
});

test("allow_bash accepts command prefixes and refuses dangerous ones", async () => {
  const { validate } = await import("../lib/config.mjs");
  const base = { repo: "a/b", owner_login: "a" };
  assert.deepEqual(validate({ ...base, allow_bash: ["cargo test", "cargo clippy", "make lint", "pytest", "npm test"] }).filter((m) => m.includes("allow_bash")), []);
  for (const bad of [["git push"], ["gh pr merge"], ["curl x"], ["rm -rf /"], ["cargo; rm"], "cargo", ["cargo"],
                     ["bash -c"], ["sh -c"], ["python -c"], ["python3 -m"], ["env FOO"], ["xargs cargo"], ["sudo cargo"],
                     ["./run tests"], ["/usr/bin/cargo test"], ["node x"], ["npx something"], ["Python.exe -c"],
                     ["cargo test | sh"], ["cargo `x`"], ["python3.12 -c"], ["busybox sh"], ["npm exec x"], ["pnpm dlx x"],
                     ["go run x"], ["uv run x"], ["cargo install x"], ["socat x"], ["make"], ["pytest -k"], ["cargo test extra"]])
    assert.ok(validate({ ...base, allow_bash: bad }).some((m) => m.includes("allow_bash")), JSON.stringify(bad));
});
