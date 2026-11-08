import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalize, validate, machineNames } from "../lib/config.mjs";
import { routeIssue, setMachine, thisMachine } from "../lib/machine.mjs";
import { mrkdwn, collectBoard, renderBoard, syncBoard, postNews, briefNews, dispatchNews, boardHeader } from "../lib/slack.mjs";
import { runWatch } from "../lib/watch.mjs";
import { readState } from "../lib/brief.mjs";
import { ensureLabels } from "../lib/queue.mjs";
import { validSlackToken, saveSlackToken } from "../lib/token.mjs";

const base = { repo: "jk/proj", owner_login: "jk" };
const config = normalize({ ...base, slack: { channel: "C0123ABCD" }, machines: { main: "pc", helpers: ["mac"] } });
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "crew-slack-"));
const tmpEnv = () => ({ XDG_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "crew-cfg-")), APPDATA: fs.mkdtempSync(path.join(os.tmpdir(), "crew-cfg-")), CREW_SLACK_TOKEN: "xoxb-test" });

test("config: slack and machines validate and default", () => {
  assert.deepEqual(config.slack, { channel: "C0123ABCD", board: true, news: true, commanders: [] });
  assert.deepEqual(machineNames(config), ["pc", "mac"]);
  assert.equal(normalize(base).slack, null);
  assert.deepEqual(machineNames(normalize(base)), []);
  assert.ok(validate({ ...base, slack: { channel: "#general" } }).some((p) => /channel ID/.test(p)));
  assert.ok(validate({ ...base, slack: { channel: "C0123ABCD", boards: true } }).some((p) => /slack.boards/.test(p)));
  assert.ok(validate({ ...base, machines: { main: "PC" } }).some((p) => /machines.main/.test(p)));
  assert.ok(validate({ ...base, machines: { main: "pc", helpers: ["pc"] } }).some((p) => /different/.test(p)));
  assert.ok(validate({ ...base, machines: { main: "ready" } }).some((p) => /clashes/.test(p)));
});

test("routing: unlabelled work goes to the main machine, a machine label pins it", () => {
  assert.equal(routeIssue(config, ["ready"], "pc"), null);
  assert.match(routeIssue(config, ["ready"], "mac"), /runs on pc/);
  assert.equal(routeIssue(config, ["ready", "mac"], "mac"), null);
  assert.match(routeIssue(config, ["ready", "mac"], "pc"), /for mac/);
  assert.match(routeIssue(config, ["ready"], null), /no crew name/);
  assert.match(routeIssue(config, ["ready"], "laptop"), /does not list/);
  assert.equal(routeIssue(normalize(base), ["ready"], null), null); // routing off: anyone
});

test("machine name is stored machine-locally and must be a configured one", () => {
  const env = tmpEnv();
  assert.equal(thisMachine(env), null);
  setMachine(config, "Mac", { env });
  assert.equal(thisMachine(env), "mac");
  assert.throws(() => setMachine(config, "laptop", { env }), /not in crew.json/);
});

test("slack token: only a bot token is saved", () => {
  const env = tmpEnv();
  assert.ok(validSlackToken("xoxb-1234567890-abcdefghijkl"));
  assert.ok(!validSlackToken("xoxp-1234567890-abcdefghijkl"));
  assert.throws(() => saveSlackToken("sk-ant-oat01-nope", { env }), /xoxb-/);
  const file = saveSlackToken("xoxb-1234567890-abcdefghijkl", { env });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).CREW_SLACK_TOKEN, "xoxb-1234567890-abcdefghijkl");
});

test("mrkdwn: links and bold convert, the rest is escaped", () => {
  assert.equal(mrkdwn("the [fix](https://x/1?a=1&b=2) for <b> & **you**"), "the <https://x/1?a=1&b=2|fix> for &lt;b&gt; &amp; *you*");
});

const issues = [
  { number: 3, title: "Add  the board", labels: [{ name: "ready" }, { name: "mac" }], url: "https://github.com/jk/proj/issues/3" },
  { number: 1, title: "Fix <it>", labels: [{ name: "ready" }], url: "https://github.com/jk/proj/issues/1" },
  { number: 2, title: "Doing one", labels: [{ name: "doing" }, { name: "ready" }], url: "https://github.com/jk/proj/issues/2" },
  { number: 9, title: "Not crew", labels: [{ name: "bug" }], url: "u9" },
];
const ghRun = (list) => (cmd, args) => (cmd === "gh" && args[0] === "issue" ? { ok: true, stdout: JSON.stringify(list) } : { ok: true, stdout: "" });

test("board: grouped by state (furthest along wins), machine shown, header fixed", () => {
  const cols = collectBoard(config, ghRun(issues));
  assert.deepEqual(cols.ready.map((i) => i.number), [1, 3]);
  assert.deepEqual(cols.doing.map((i) => i.number), [2]);
  assert.equal(cols.ready[1].machine, "mac");
  const text = renderBoard(config, cols, new Date("2026-11-08T12:00:00Z"));
  assert.ok(text.startsWith(boardHeader(config)));
  assert.match(text, /Ready\* \(2\)/);
  assert.match(text, /<https:\/\/github.com\/jk\/proj\/issues\/1\|#1> Fix &lt;it&gt;/);
  assert.match(text, /Add the board · _mac_/);
  assert.doesNotMatch(text, /Not crew/);
});

function fakeSlack({ pinned = [], failUpdate = null } = {}) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, o) => {
    const method = url.split("/").pop();
    const body = Object.fromEntries(new URLSearchParams(o.body));
    calls.push({ method, body, auth: o.headers.Authorization });
    if (method === "pins.list") return { json: async () => ({ ok: true, items: pinned }) };
    if (method === "chat.update" && failUpdate) return { json: async () => ({ ok: false, error: failUpdate }) };
    if (method === "chat.postMessage") return { json: async () => ({ ok: true, ts: `100.${++n}` }) };
    return { json: async () => ({ ok: true }) };
  };
  return { fetchImpl, calls };
}

test("syncBoard: posts and pins once, then updates in place, and skips when unchanged", async () => {
  const root = tmpRoot();
  const env = tmpEnv();
  const s = fakeSlack();
  const r1 = await syncBoard({ root, config, run: ghRun(issues), env, fetchImpl: s.fetchImpl });
  assert.equal(r1.action, "posted");
  assert.deepEqual(s.calls.map((c) => c.method), ["pins.list", "chat.postMessage", "pins.add"]);
  assert.equal(s.calls[1].auth, "Bearer xoxb-test");
  assert.equal(readState(root).slackBoard.ts, "100.1");

  const r2 = await syncBoard({ root, config, run: ghRun(issues), env, fetchImpl: s.fetchImpl });
  assert.equal(r2.action, "skipped");

  const r3 = await syncBoard({ root, config, run: ghRun(issues.slice(1)), env, fetchImpl: s.fetchImpl });
  assert.equal(r3.action, "updated");
  assert.equal(s.calls.at(-1).method, "chat.update");
  assert.equal(s.calls.at(-1).body.ts, "100.1");
});

test("syncBoard: reuses a board this bot pinned earlier, and re-posts if it was deleted", async () => {
  const env = tmpEnv();
  const pinned = [{ type: "message", message: { ts: "55.5", bot_id: "B1", text: `${boardHeader(config)}\nold` } }];
  const s = fakeSlack({ pinned });
  const r = await syncBoard({ root: tmpRoot(), config, run: ghRun(issues), env, fetchImpl: s.fetchImpl });
  assert.equal(r.action, "updated");
  assert.equal(s.calls.find((c) => c.method === "chat.update").body.ts, "55.5");

  const gone = fakeSlack({ pinned, failUpdate: "message_not_found" });
  const r2 = await syncBoard({ root: tmpRoot(), config, run: ghRun(issues), env, fetchImpl: gone.fetchImpl });
  assert.equal(r2.action, "posted");
});

test("postNews never throws; briefNews and dispatchNews are short and plain", async () => {
  const bad = async () => ({ json: async () => ({ ok: false, error: "not_in_channel" }) });
  const r = await postNews({ config, text: "hi", env: tmpEnv(), fetchImpl: bad });
  assert.deepEqual(r, { ok: false, why: "slack chat.postMessage: not_in_channel" });
  assert.equal((await postNews({ config: normalize(base), text: "hi" })).ok, false);

  const status = { headline: "Two fixes shipped", what_happened: "We fixed [the login](https://x/pr/1).", blocked: [{ what: "Docs", why: "w", unblock: "u" }],
    decisions: [{ question: "Merge #5?", recommendation: "Yes", cost_of_waiting: "c" }], next: "More tests." };
  const text = briefNews({ status, mode: "daily", url: "https://x/pr/9" });
  assert.match(text, /Brief\*: Two fixes shipped/);
  assert.match(text, /<https:\/\/x\/pr\/1\|the login>/);
  assert.match(text, /Stuck \(1\)/);
  assert.match(text, /1\. Merge #5\?/);
  assert.match(text, /<https:\/\/x\/pr\/9\|full brief>/);

  assert.match(dispatchNews({ action: "built", issue: 4, url: "https://x/pull/7", protected: [] }, config), /Built <https:\/\/github.com\/jk\/proj\/issues\/4\|#4>/);
  assert.equal(dispatchNews({ action: "idle" }, config), null);
  assert.equal(dispatchNews({ action: "wip" }, config), null);
});

test("watch: dispatch, then board, then one news line, not repeated within 6 hours", async () => {
  const root = tmpRoot();
  const sent = [];
  const deps = {
    root, config, env: tmpEnv(),
    dispatch: async () => ({ action: "canary-failed", why: "401" }),
    board: async () => ({ action: "skipped", why: "board unchanged" }),
    news: async ({ text }) => (sent.push(text), { ok: true }),
  };
  const t0 = new Date("2026-11-08T10:00:00Z");
  const r = await runWatch({ ...deps, now: t0 });
  assert.equal(r.board.action, "skipped");
  assert.equal(sent.length, 1);
  await runWatch({ ...deps, now: new Date("2026-11-08T10:10:00Z") });
  assert.equal(sent.length, 1);
  await runWatch({ ...deps, now: new Date("2026-11-08T16:30:00Z") });
  assert.equal(sent.length, 2);

  const quiet = await runWatch({ ...deps, dispatch: async () => ({ action: "idle", skipped: [] }), now: new Date("2026-11-08T17:00:00Z") });
  assert.equal(quiet.news, null);

  const boom = await runWatch({ ...deps, board: async () => { throw new Error("slack down"); }, dispatch: async () => ({ action: "idle" }) });
  assert.equal(boom.board.action, "error");

  const noSlack = await runWatch({ ...deps, config: normalize(base), dispatch: async () => ({ action: "built", issue: 1 }) });
  assert.equal(noSlack.board, null);
  assert.equal(noSlack.news, null);
});

test("ensureLabels also creates one label per machine", () => {
  const calls = [];
  ensureLabels(config, (cmd, args) => (calls.push(args.join(" ")), { ok: true, stdout: "" }));
  assert.ok(calls.some((c) => c.startsWith("label create pc ") && /central machine/.test(c)));
  assert.ok(calls.some((c) => c.startsWith("label create mac ") && /helper/.test(c)));
});

test("dispatch on a helper machine leaves unlabelled work for the main machine", async () => {
  const { runDispatch } = await import("../lib/dispatch.mjs");
  const run = (cmd, args) => {
    const l = `${cmd} ${args.join(" ")}`;
    if (l.startsWith("gh pr list")) return { ok: true, stdout: "[]" };
    if (l.startsWith("gh issue list")) return { ok: true, stdout: JSON.stringify([{ number: 1, title: "t", body: "", labels: [{ name: "ready" }], createdAt: "2026-11-01T00:00:00Z", url: "u" }]) };
    return { ok: true, stdout: "" };
  };
  const r = await runDispatch({ root: tmpRoot(), config, run, runStream: async () => assert.fail("no model run"), machine: "mac", now: new Date("2026-11-08T12:00:00Z") });
  assert.equal(r.action, "idle");
  assert.match(r.skipped[0].reason, /runs on pc/);
});

test("dispatch_hours: watch only dispatches inside the windows; windows may cross midnight", async () => {
  const { inDispatchHours } = await import("../lib/config.mjs");
  const at = (h, m) => new Date(2026, 10, 8, h, m);
  const c = normalize({ ...base, dispatch_hours: ["14:00-19:45", "23:00-01:00"] });
  assert.equal(inDispatchHours(c, at(14, 0)), true);
  assert.equal(inDispatchHours(c, at(19, 45)), false);
  assert.equal(inDispatchHours(c, at(8, 0)), false);
  assert.equal(inDispatchHours(c, at(0, 30)), true);
  assert.equal(inDispatchHours(normalize(base), at(8, 0)), true);
  assert.ok(validate({ ...base, dispatch_hours: ["2pm-5pm"] }).length);
  assert.ok(validate({ ...base, dispatch_hours: [] }).length);

  let called = 0;
  const r = await runWatch({ root: tmpRoot(), config: c, env: tmpEnv(), now: at(8, 0), dispatch: async () => (called++, { action: "idle" }), board: async () => ({ action: "skipped" }) });
  assert.equal(called, 0);
  assert.equal(r.dispatch.action, "quiet");
  await runWatch({ root: tmpRoot(), config: c, env: tmpEnv(), now: at(15, 0), dispatch: async () => (called++, { action: "idle" }), board: async () => ({ action: "skipped" }) });
  assert.equal(called, 1);
});

test("news wording: draft reason, gate, and a timed-out login check is not a token problem", () => {
  assert.match(dispatchNews({ action: "built", issue: 4, url: "u", draft: "tests failed", protected: [] }, config), /\(draft: tests failed\)/);
  assert.match(dispatchNews({ action: "built", issue: 4, url: "u", draft: null, gate: true, protected: ["x"] }, config), /review gate decides/);
  assert.match(dispatchNews({ action: "canary-failed", why: "spawnSync claude ETIMEDOUT" }, config), /took too long/);
  assert.match(dispatchNews({ action: "canary-failed", why: "401 invalid token" }, config), /crew token set/);
});
