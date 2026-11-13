import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { doctor, parseScopes, repoFromRemote, formatChecks } from "../lib/doctor.mjs";

function tmpRepo(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-doctor-"));
  fs.mkdirSync(path.join(dir, ".git"));
  if (config !== undefined) {
    fs.mkdirSync(path.join(dir, ".claude"));
    fs.writeFileSync(path.join(dir, ".claude", "crew.json"), typeof config === "string" ? config : JSON.stringify(config));
  }
  return dir;
}

/** Fake outside world. `over` maps "cmd arg0 arg1" prefixes to results. */
function fakeRun(over = {}) {
  const table = {
    "claude --version": { ok: true, stdout: "2.1.316 (Claude Code)\n" },
    "gh --version": { ok: true, stdout: "gh version 2.103.3\n" },
    "gh auth status": { ok: true, stdout: "", stderr: "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'\n" },
    "git remote get-url": { ok: true, stdout: "git@github.com:jk/proj.git\n" },
    "gh repo view": { ok: true, stdout: JSON.stringify({ nameWithOwner: "jk/proj", visibility: "PRIVATE", defaultBranchRef: { name: "main" }, viewerPermission: "ADMIN" }) },
    "gh api user": { ok: true, stdout: "jk\n" },
    ...over,
  };
  return (cmd, args) => {
    const key = Object.keys(table).find((k) => `${cmd} ${args.join(" ")}`.startsWith(k));
    const r = key ? table[key] : { ok: false, stderr: "unexpected call" };
    return { code: r.ok ? 0 : 1, stdout: "", stderr: "", missing: false, ...r };
  };
}

const cfg = { repo: "jk/proj", owner_login: "jk", protected_paths: ["src/risk/*"] };
const env = { CLAUDE_CODE_OAUTH_TOKEN: "x".repeat(40) };
const byName = (checks) => Object.fromEntries(checks.map((c) => [c.name, c]));

test("healthy setup: no failures", () => {
  const { checks } = doctor({ cwd: tmpRepo(cfg), env, run: fakeRun(), nodeVersion: "24.1.0" });
  assert.deepEqual(checks.filter((c) => c.status === "fail"), []);
  const c = byName(checks);
  assert.equal(c["github repo"].status, "ok");
  assert.equal(c["github plan note"].status, "warn"); // private repo on Free
  assert.equal(c["oauth token"].status, "ok");
});

test("ANTHROPIC_API_KEY set is a failure and its value is never printed", () => {
  const { checks } = doctor({ cwd: tmpRepo(cfg), env: { ...env, ANTHROPIC_API_KEY: "sk-ant-secret-value" }, run: fakeRun(), nodeVersion: "24.1.0" });
  assert.equal(byName(checks)["anthropic api key"].status, "fail");
  assert.ok(!formatChecks(checks).includes("sk-ant-secret-value"));
});

test("old node fails", () => {
  const { checks } = doctor({ cwd: tmpRepo(cfg), env, run: fakeRun(), nodeVersion: "18.19.0" });
  assert.equal(byName(checks).node.status, "fail");
});

test("missing token is a warning, not a failure", () => {
  const { checks } = doctor({ cwd: tmpRepo(cfg), env: { XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "x-")) }, run: fakeRun(), nodeVersion: "24.1.0", platform: "darwin" });
  assert.equal(byName(checks)["oauth token"].status, "warn");
});

test("gh token without repo scope fails", () => {
  const { checks } = doctor({ cwd: tmpRepo(cfg), env, run: fakeRun({ "gh auth status": { ok: true, stderr: "Token scopes: 'gist'" } }), nodeVersion: "24.1.0" });
  assert.equal(byName(checks)["gh auth"].status, "fail");
});

test("origin pointing at a different repo fails", () => {
  const { checks } = doctor({ cwd: tmpRepo(cfg), env, run: fakeRun({ "git remote get-url": { ok: true, stdout: "https://github.com/someone/else.git" } }), nodeVersion: "24.1.0" });
  assert.equal(byName(checks)["git origin"].status, "fail");
});

test("default branch mismatch and read-only access fail", () => {
  const view = { nameWithOwner: "jk/proj", visibility: "PUBLIC", defaultBranchRef: { name: "master" }, viewerPermission: "READ" };
  const { checks } = doctor({ cwd: tmpRepo(cfg), env, run: fakeRun({ "gh repo view": { ok: true, stdout: JSON.stringify(view) } }), nodeVersion: "24.1.0" });
  const c = byName(checks);
  assert.equal(c["default branch"].status, "fail");
  assert.equal(c["github repo"].status, "fail");
  assert.equal(c["github plan note"], undefined); // public: no Free-plan warning
});

test("missing config fails and stops before network checks", () => {
  const { checks } = doctor({ cwd: tmpRepo(), env, run: fakeRun(), nodeVersion: "24.1.0" });
  assert.equal(byName(checks)["crew config"].status, "fail");
  assert.equal(byName(checks)["github repo"], undefined);
});

test("invalid JSON config is reported", () => {
  const { checks } = doctor({ cwd: tmpRepo("{not json"), env, run: fakeRun(), nodeVersion: "24.1.0" });
  assert.match(byName(checks)["crew config"].detail, /not valid JSON/);
});

test("gh missing fails and skips GitHub checks", () => {
  const { checks } = doctor({ cwd: tmpRepo(cfg), env, run: fakeRun({ "gh --version": { ok: false, missing: true } }), nodeVersion: "24.1.0" });
  const c = byName(checks);
  assert.equal(c.gh.status, "fail");
  assert.equal(c["github repo"], undefined);
});

test("not a git repo fails cleanly", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-nogit-"));
  const { checks } = doctor({ cwd: dir, env, run: fakeRun(), nodeVersion: "24.1.0" });
  assert.equal(byName(checks)["git repo"].status, "fail");
});

test("different gh login is a warning (builder account)", () => {
  const { checks } = doctor({ cwd: tmpRepo(cfg), env, run: fakeRun({ "gh api user": { ok: true, stdout: "jk-bot\n" } }), nodeVersion: "24.1.0" });
  assert.equal(byName(checks)["github identity"].status, "warn");
});

test("--config reads a config kept outside the repo", () => {
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "team-cfg-")), "trial.json");
  fs.writeFileSync(outside, JSON.stringify(cfg));
  const { checks } = doctor({ cwd: tmpRepo(), configPath: outside, env, run: fakeRun(), nodeVersion: "24.1.0" });
  assert.equal(byName(checks)["crew config"].status, "ok");
  const missing = doctor({ cwd: tmpRepo(), configPath: outside + ".nope", env, run: fakeRun(), nodeVersion: "24.1.0" });
  assert.match(byName(missing.checks)["crew config"].detail, /config file not found/);
});

test("parseScopes", () => {
  assert.deepEqual(parseScopes("  - Token scopes: 'gist', 'repo'"), ["gist", "repo"]);
  assert.equal(parseScopes("Logged in to github.com"), null);
});

test("repoFromRemote handles ssh, https and .git", () => {
  assert.equal(repoFromRemote("git@github.com:jk/proj.git"), "jk/proj");
  assert.equal(repoFromRemote("https://github.com/jk/proj"), "jk/proj");
  assert.equal(repoFromRemote("https://github.com/jk/proj.git/"), "jk/proj");
  assert.equal(repoFromRemote("https://gitlab.com/jk/proj"), null);
});

test("doctor: warns when jobs run outside the runner", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crew-doc-"));
  const { checks } = doctor({ cwd: tmpRepo(cfg), env: { ...env, XDG_DATA_HOME: dir }, run: fakeRun(), nodeVersion: "24.1.0", home: dir, platform: "darwin" });
  const runner = checks.find((c) => c.name === "runner");
  assert.equal(runner.status, "warn");
  assert.match(runner.detail, /crew update setup/);
});
