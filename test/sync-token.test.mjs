import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { syncCheckout } from "../lib/sync.mjs";
import { validToken, saveToken } from "../lib/token.mjs";
import { secretsPath, readOAuthToken } from "../lib/secrets.mjs";
import { normalize } from "../lib/config.mjs";

const config = normalize({ repo: "jk/proj", owner_login: "jk" });
const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

/** origin (bare), a "remote" clone that pushes, and the local checkout under test. */
function repos() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "crew-sync-"));
  const origin = path.join(base, "origin.git");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  const up = path.join(base, "up");
  git(base, "clone", "-q", origin, up);
  fs.writeFileSync(path.join(up, "a.txt"), "1\n");
  git(up, "add", ".");
  git(up, "commit", "-q", "-m", "one");
  git(up, "push", "-q", "origin", "HEAD:main");
  const local = path.join(base, "local");
  git(base, "clone", "-q", origin, local);
  const push = (msg) => {
    fs.appendFileSync(path.join(up, "a.txt"), `${msg}\n`);
    git(up, "commit", "-q", "-am", msg);
    git(up, "push", "-q", "origin", "HEAD:main");
  };
  return { local, push };
}

test("sync fast-forwards a clean checkout and leaves untracked files alone", () => {
  const { local, push } = repos();
  fs.writeFileSync(path.join(local, "notes.txt"), "mine\n"); // untracked
  push("two");
  push("three");
  const r = syncCheckout({ root: local, config });
  assert.deepEqual([r.ok, r.outcome], [true, "fast-forwarded"]);
  assert.match(r.detail, /2 commit/);
  assert.equal(fs.readFileSync(path.join(local, "a.txt"), "utf8"), "1\ntwo\nthree\n");
  assert.equal(fs.readFileSync(path.join(local, "notes.txt"), "utf8"), "mine\n");
  assert.equal(syncCheckout({ root: local, config }).outcome, "up-to-date");
});

test("sync refuses, and changes nothing, with tracked local edits", () => {
  const { local, push } = repos();
  push("two");
  fs.writeFileSync(path.join(local, "a.txt"), "edited\n");
  const r = syncCheckout({ root: local, config });
  assert.deepEqual([r.ok, r.outcome], [false, "skipped"]);
  assert.equal(fs.readFileSync(path.join(local, "a.txt"), "utf8"), "edited\n");
});

test("sync refuses on another branch and when diverged", () => {
  const { local, push } = repos();
  git(local, "switch", "-q", "-c", "feature");
  assert.match(syncCheckout({ root: local, config }).detail, /on feature, not main/);
  git(local, "switch", "-q", "main");
  fs.writeFileSync(path.join(local, "b.txt"), "local\n");
  git(local, "add", ".");
  git(local, "commit", "-q", "-m", "local only");
  push("remote only");
  const r = syncCheckout({ root: local, config });
  assert.deepEqual([r.ok, r.outcome], [false, "diverged"]);
  assert.match(fs.readFileSync(path.join(local, ".crew", "dispatch.log"), "utf8"), /"action":"sync","outcome":"diverged"/);
});

test("validToken accepts only subscription tokens", () => {
  assert.ok(validToken("sk-ant-oat01-" + "x".repeat(60)));
  assert.ok(!validToken("sk-ant-api03-" + "x".repeat(60)), "API keys are refused");
  assert.ok(!validToken("sk-ant-oat01-short"));
  assert.ok(!validToken("sk-ant-oat01-" + "x".repeat(30) + " " + "y".repeat(30)));
});

test("saveToken writes a private file that the jobs can read, keeping other keys", { skip: process.platform === "win32" && "POSIX modes" }, () => {
  const env = { XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "crew-tok-")) };
  const file = secretsPath(env, "darwin");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ OTHER: "keep" }));
  const tok = "sk-ant-oat01-" + "z".repeat(60);
  assert.equal(saveToken(tok, { env, platform: "darwin" }), file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(readOAuthToken(env, "darwin"), tok);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).OTHER, "keep");
  assert.throws(() => saveToken("sk-ant-api03-" + "z".repeat(60), { env, platform: "darwin" }), /nothing saved/);
});
