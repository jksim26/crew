import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalize, validate } from "../lib/config.mjs";
import { runReview, reviewPermissions, buildReviewPrompt } from "../lib/review.mjs";
import { renderBoard } from "../lib/slack.mjs";

const base = { repo: "jk/proj", owner_login: "jk" };
const config = normalize({ ...base, review: { routine: "docs/self-review.md", bash: ["${root}/.venv/bin/python scripts/"] } });

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crew-review-"));
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "self-review.md"), "# Routine\nWrite wiki/memory/self-review-<date>.md and file proposals with gh issue create.\n");
  return root;
}

const RESULT = (obj, cost = 0.9) => JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: cost, result: JSON.stringify(obj) });

function world({ commits = 1, existing = [] } = {}) {
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push({ line, input: opts.input });
    if (cmd === "claude") return { ok: true, stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, result: "ok" }) };
    if (line.startsWith("git rev-list --count")) return { ok: true, stdout: `${commits}\n` };
    if (line.startsWith("git rev-parse")) return { ok: true, stdout: "abc\n" };
    if (line.startsWith("git worktree add")) {
      fs.mkdirSync(args[args.length - 2], { recursive: true });
      return { ok: true, stdout: "" };
    }
    if (line.startsWith("gh issue list")) return { ok: true, stdout: JSON.stringify(existing.map((title) => ({ title }))) };
    if (line.startsWith("gh issue create")) return { ok: true, stdout: `https://github.com/jk/proj/issues/${100 + calls.filter((c) => c.line.startsWith("gh issue create")).length}\n` };
    if (line.startsWith("gh pr list")) return { ok: true, stdout: "[]" };
    if (line.startsWith("gh pr create")) return { ok: true, stdout: "https://github.com/jk/proj/pull/9\n" };
    return { ok: true, stdout: "" };
  };
  const streams = [];
  const runStream = async (cmd, args, o) => {
    streams.push({ args, o });
    return { code: 0, stdout: RESULT({ status: "done", pr_title: "plan: self-review 2026-11-09", pr_body: "Top findings", proposals: [
      { title: "fix-a - one", body: "scope" }, { title: "already-there - two", body: "scope" }, { title: "", body: "no title" },
    ] }), stderr: "", timedOut: null };
  };
  return { run, runStream, calls, streams };
}

test("config: review validates and defaults", () => {
  assert.deepEqual(config.review, { routine: "docs/self-review.md", bash: ["${root}/.venv/bin/python scripts/"], budget_usd: 5, max_issues: 8 });
  assert.equal(normalize(base).review, null);
  assert.ok(validate({ ...base, review: {} }).some((p) => /review.routine/.test(p)));
  assert.ok(validate({ ...base, review: { routine: "../x.md" } }).some((p) => /review.routine/.test(p)));
  assert.ok(validate({ ...base, review: { routine: "a.md", max_issues: 99 } }).some((p) => /max_issues/.test(p)));
});

test("review: reads the main checkout, writes only its worktree, never pushes or runs gh", () => {
  const { allowed, disallowed } = reviewPermissions(config, "/Users/jk/proj");
  assert.ok(allowed.includes("Bash(/Users/jk/proj/.venv/bin/python scripts/:*)"));
  assert.ok(disallowed.includes("Edit(//Users/jk/proj/**)") && disallowed.includes("Write(//Users/jk/proj/**)"));
  assert.ok(disallowed.includes("Bash(gh:*)") && disallowed.includes("Bash(git push:*)"));
  const win = reviewPermissions(config, "X:\\Claude\\Proj".split("\\").join(path.sep));
  if (path.sep === "\\") assert.ok(win.disallowed.includes("Edit(//x/Claude/Proj/**)"));
  const p = buildReviewPrompt({ config, routine: "ROUTINE", main: "/m", date: "2026-11-09" });
  assert.match(p, /<routine>\nROUTINE\n<\/routine>/);
  assert.match(p, /do not: put the PR title/);
});

test("review: files new proposals as needs-jk (deduped), pushes crew/review-<date>, opens the plan PR", async () => {
  const root = tmpRoot();
  const w = world({ existing: ["Already-There - two"] });
  const r = await runReview({ root, config, run: w.run, runStream: w.runStream, now: new Date("2026-11-09T10:00:00Z") });
  assert.equal(r.action, "reviewed");
  assert.equal(r.url, "https://github.com/jk/proj/pull/9");
  assert.deepEqual(r.issues, ["https://github.com/jk/proj/issues/101"]);
  const created = w.calls.filter((c) => c.line.startsWith("gh issue create"));
  assert.equal(created.length, 1);
  assert.match(created[0].line, /--label needs-jk/);
  assert.ok(w.calls.some((c) => c.line.includes("push --quiet --force origin HEAD:refs/heads/crew/review-2026-11-09")));
  const pr = w.calls.find((c) => c.line.startsWith("gh pr create"));
  assert.match(pr.line, /--title plan: self-review 2026-11-09/);
  assert.match(pr.input, /Top findings[\s\S]*issues\/101/);
  const { args, o } = w.streams[0];
  assert.ok(args.includes("--add-dir") && args.includes(root));
  assert.match(o.input, /Main checkout \(live files, read-only to you\)/);
});

test("review: no commit means no PR, but proposals are still filed", async () => {
  const w = world({ commits: 0 });
  const r = await runReview({ root: tmpRoot(), config, run: w.run, runStream: w.runStream });
  assert.equal(r.action, "no-report");
  assert.equal(r.issues.length, 2);
  assert.ok(!w.calls.some((c) => c.line.startsWith("gh pr create")));
});

test("review: dry run changes nothing; no review config is a clear error", async () => {
  const w = world();
  const r = await runReview({ root: tmpRoot(), config, run: w.run, runStream: w.runStream, dryRun: true, now: new Date("2026-11-09T10:00:00Z") });
  assert.deepEqual([r.action, r.dry, r.branch], ["reviewed", true, "crew/review-2026-11-09"]);
  assert.equal(w.calls.length, 0);
  await assert.rejects(runReview({ root: tmpRoot(), config: normalize(base) }), /no "review"/);
});

test("board: a long column links the rest on GitHub instead of a dead '...more'", () => {
  const many = Array.from({ length: 33 }, (_, i) => ({ number: i + 1, title: `t${i}`, url: `u${i}`, machine: null }));
  const text = renderBoard(config, { ready: many, doing: [], "in-review": [], blocked: [], "needs-jk": [] });
  assert.match(text, /<https:\/\/github.com\/jk\/proj\/issues\?q=is%3Aissue\+is%3Aopen\+label%3Aready\|…and 3 more on GitHub>/);
  assert.equal((text.match(/^• <u/gm) ?? []).length, 30);
});
