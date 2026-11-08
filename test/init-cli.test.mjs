import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { init, buildConfig } from "../lib/init.mjs";
import { parseArgs, main } from "../lib/cli.mjs";
import { secretsPath, oauthTokenStatus } from "../lib/secrets.mjs";
import { fileURLToPath } from "node:url";

const fakeRun = (cmd, args) => {
  const k = `${cmd} ${args.join(" ")}`;
  if (k.startsWith("git remote get-url")) return { ok: true, stdout: "https://github.com/jk/proj.git\n" };
  if (k.startsWith("git symbolic-ref")) return { ok: true, stdout: "origin/main\n" };
  if (k.startsWith("gh api user")) return { ok: true, stdout: "jk\n" };
  return { ok: false, stdout: "", stderr: "" };
};
const sink = () => ({ data: "", write(s) { this.data += s; } });

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-init-"));
  fs.mkdirSync(path.join(dir, ".git"));
  return dir;
}

test("init writes an explicit, valid config from detected values", async () => {
  const dir = tmpRepo();
  const { file, config } = await init({ cwd: dir, flags: { yes: true, roles: "trade, ops", protected: ["a/*"] }, run: fakeRun });
  assert.equal(file, path.join(dir, ".claude", "crew.json"));
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written.repo, "jk/proj");
  assert.equal(written.owner_login, "jk");
  assert.deepEqual(written.roles, ["trade", "ops"]);
  assert.deepEqual(written.protected_paths, ["a/*"]);
  assert.equal(written.caps.max_turns, 60); // caps written out, not hidden
  assert.deepEqual(config, written);
});

test("init refuses to overwrite without --force", async () => {
  const dir = tmpRepo();
  await init({ cwd: dir, flags: { yes: true }, run: fakeRun });
  await assert.rejects(init({ cwd: dir, flags: { yes: true }, run: fakeRun }), /already exists/);
  await init({ cwd: dir, flags: { yes: true, force: true, owner: "other" }, run: fakeRun });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".claude", "crew.json"), "utf8")).owner_login, "other");
});

test("init --print writes nothing", async () => {
  const dir = tmpRepo();
  const out = sink();
  await init({ cwd: dir, flags: { print: true }, run: fakeRun, stdout: out });
  assert.ok(!fs.existsSync(path.join(dir, ".claude", "crew.json")));
  assert.equal(JSON.parse(out.data).repo, "jk/proj");
});

test("init fails with every problem when nothing can be detected", async () => {
  const dir = tmpRepo();
  await assert.rejects(init({ cwd: dir, flags: { yes: true }, run: () => ({ ok: false }) }), /"repo"[\s\S]*owner_login/);
});

test("buildConfig: flags override detection", () => {
  const c = buildConfig({ repo: "a/b", owner_login: "x" }, { repo: "c/d", "wip-cap": "3" });
  assert.equal(c.repo, "c/d");
  assert.equal(c.wip_cap, 3);
});

test("parseArgs handles --k v, --k=v, booleans and repeats", () => {
  const r = parseArgs(["init", "--repo", "a/b", "--owner=jk", "--yes", "--protected", "x/*", "--protected", "y/*"]);
  assert.equal(r.cmd, "init");
  assert.deepEqual(r.flags, { repo: "a/b", owner: "jk", yes: true, protected: ["x/*", "y/*"] });
  assert.throws(() => parseArgs(["init", "--repo"]), /needs a value/);
});

test("main: version, help, unknown command", async () => {
  const out = sink(), err = sink();
  assert.equal(await main(["--version"], { stdout: out, stderr: err }), 0);
  assert.match(out.data, /^crew \d+\.\d+\.\d+/);
  assert.equal(await main(["help"], { stdout: sink(), stderr: err }), 0);
  assert.equal(await main([], { stdout: sink(), stderr: err }), 2);
  assert.equal(await main(["frobnicate"], { stdout: sink(), stderr: err }), 2);
});

test("plugin.json and package.json versions agree", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const plugin = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(plugin.version, pkg.version);
});

test("secretsPath is per-platform and outside any repo", () => {
  assert.equal(secretsPath({ APPDATA: "C:/Users/jk/AppData/Roaming" }, "win32"), path.join("C:/Users/jk/AppData/Roaming", "crew", "secrets.json"));
  assert.equal(secretsPath({ XDG_CONFIG_HOME: "/x" }, "darwin"), path.join("/x", "crew", "secrets.json"));
});

test("oauthTokenStatus reads the secrets file and flags loose permissions", { skip: process.platform === "win32" && "POSIX file modes" }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "team-sec-"));
  const env = { XDG_CONFIG_HOME: base };
  const file = secretsPath(env, "darwin");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ CLAUDE_CODE_OAUTH_TOKEN: "t".repeat(40) }), { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  assert.deepEqual({ ...oauthTokenStatus(env, "darwin"), file: null }, { present: true, file: null, source: "secrets file", looseMode: true });
  fs.chmodSync(file, 0o600);
  assert.equal(oauthTokenStatus(env, "darwin").looseMode, false);
});
