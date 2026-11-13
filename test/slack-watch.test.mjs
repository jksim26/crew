import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalize, validate, machineNames } from "../lib/config.mjs";
import { routeIssue, setMachine, thisMachine } from "../lib/machine.mjs";
import { mrkdwn, collectBoard, renderBoard, renderBoardMarkdown, syncBoard, publishCanvas, refreshCanvases, postNews, briefNews, dispatchNews, boardHeader } from "../lib/slack.mjs";
import { runWatch } from "../lib/watch.mjs";
import { readState } from "../lib/brief.mjs";
import { ensureLabels } from "../lib/queue.mjs";
import { validSlackToken, saveSlackToken } from "../lib/token.mjs";

const base = { repo: "jk/proj", owner_login: "jk" };
const config = normalize({ ...base, slack: { channel: "C0123ABCD" }, machines: { main: "pc", helpers: ["mac"] } });
const cfgC = normalize({ ...base, slack: { channel: "C0123ABCD", canvas: true }, machines: { main: "pc", helpers: ["mac"] } });
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

function fakeSlack({ pinned = [], failUpdate = null, canvas = {} } = {}) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, o) => {
    const method = url.split("/").pop();
    const body = /json/.test(o.headers["Content-Type"]) ? JSON.parse(o.body) : Object.fromEntries(new URLSearchParams(o.body));
    calls.push({ method, body, auth: o.headers.Authorization });
    if (canvas[method]) return { json: async () => (typeof canvas[method] === "function" ? canvas[method](body) : canvas[method]) };
    if (method === "conversations.canvases.create" || method === "canvases.create") return { json: async () => ({ ok: true, canvas_id: `F${calls.length}` }) };
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
  const config = cfgC;
  const r1 = await syncBoard({ root, config, run: ghRun(issues), env, fetchImpl: s.fetchImpl, now: new Date("2026-11-08T12:00:00Z") });
  assert.equal(r1.action, "posted");
  assert.deepEqual(s.calls.map((c) => c.method), ["conversations.canvases.create", "pins.list", "chat.postMessage", "pins.add"]);
  assert.equal(s.calls[2].auth, "Bearer xoxb-test");
  assert.equal(readState(root).slackBoard.ts, "100.1");

  const r2 = await syncBoard({ root, config, run: ghRun(issues), env, fetchImpl: s.fetchImpl });
  assert.equal(r2.action, "skipped");

  const r3 = await syncBoard({ root, config, run: ghRun(issues.slice(1)), env, fetchImpl: s.fetchImpl });
  assert.equal(r3.action, "updated");
  assert.equal(s.calls.at(-1).method, "chat.update");
  assert.equal(s.calls.at(-1).body.ts, "100.1");
  // The canvas followed the same change, edited in place as markdown.
  const edit = s.calls.find((c) => c.method === "canvases.edit");
  assert.equal(edit.body.canvas_id, "F1");
  assert.equal(edit.body.changes[0].operation, "replace");
  assert.equal(edit.body.changes[0].document_content.type, "markdown");
  assert.match(edit.body.changes[0].document_content.markdown, /^# crew board · jk\/proj/);
  assert.equal(r3.canvas.action, "updated");
});

test("board canvas: markdown rows, escaped titles, and off unless slack.canvas is true", async () => {
  const cols = collectBoard(config, ghRun(issues));
  const workers = [{ issue: 2, kind: "build", pr: 7, phase: "agent working", started: "2026-11-08T11:30:00Z", cost: 1.5, title: "Doing *one*" }];
  const md = renderBoardMarkdown(config, cols, new Date("2026-11-08T12:00:00Z"), workers);
  assert.match(md, /## ⚙️ Workers \(1\/1\)/);
  assert.match(md, /- \[#2\]\(https:\/\/github.com\/jk\/proj\/issues\/2\) build · \[PR #7\]\(https:\/\/github.com\/jk\/proj\/pull\/7\) · agent working · 30m · \$1\.50 · Doing \\\*one\\\*/);
  assert.match(md, /## 🟢 Ready \(2\)/);
  assert.match(md, /- \[#1\]\(https:\/\/github.com\/jk\/proj\/issues\/1\) Fix \\<it\\>/);
  assert.match(md, /## 🔴 Blocked \(0\)[^\n]*\n- none/);

  const off = config; // the default: no board canvas
  const s = fakeSlack();
  const r = await syncBoard({ root: tmpRoot(), config: off, run: ghRun(issues), env: tmpEnv(), fetchImpl: s.fetchImpl });
  assert.equal(r.canvas, undefined);
  assert.ok(!s.calls.some((c) => /canvas/.test(c.method)));
});

test("board canvas: a channel canvas crew did not make is never replaced; a refusal waits, the message still goes", async () => {
  const config = cfgC;
  const root = tmpRoot();
  const env = tmpEnv();
  const s = fakeSlack({ canvas: { "conversations.canvases.create": { ok: false, error: "channel_canvas_already_exists" } } });
  const t0 = new Date("2026-11-08T12:00:00Z");
  const r = await syncBoard({ root, config, run: ghRun(issues), env, fetchImpl: s.fetchImpl, now: t0 });
  assert.equal(r.action, "posted");
  assert.equal(r.canvas.action, "error");
  assert.ok(!s.calls.some((c) => c.method === "canvases.edit" || c.method === "canvases.create"));
  assert.equal(readState(root).slackCanvases.board.error, "channel_canvas_already_exists");
  // Within the retry wait the canvas is not tried again, even when the board changes.
  const n = s.calls.length;
  await syncBoard({ root, config, run: ghRun(issues.slice(1)), env, fetchImpl: s.fetchImpl, now: new Date(t0.getTime() + 3600_000) });
  assert.ok(!s.calls.slice(n).some((c) => /canvas/.test(c.method)));
  // A network failure (no Slack code) is retried on the next tick.
  const net = async () => { throw new Error("fetch failed"); };
  const r2 = await publishCanvas({ root: tmpRoot(), key: "board", channel: "C0123ABCD", title: "t", markdown: "x", hash: "h", token: "xoxb-test", fetchImpl: net, now: t0 });
  assert.equal(r2.action, "error");
});

test("project canvases: due runs publish the command's markdown; failures keep the last copy and alert once", async () => {
  const root = tmpRoot();
  const env = tmpEnv();
  const c = normalize({ ...base, slack: { channel: "C0123ABCD", canvases: [{ key: "account", title: "Alpaca account", command: ["py", "scripts/a.py"], every_min: 10, channel: "C0ACCOUNT1", machine: "pc" }] } });
  assert.deepEqual(validate({ ...base, slack: { channel: "C0123ABCD", canvases: [{ key: "board", title: "", command: "py", every_min: 0, colour: 1 }] } }).filter((p) => /canvases/.test(p)).length, 5);
  const s = fakeSlack();
  let out = "# Account\nequity 10,000";
  let ok = true;
  const ran = [];
  const run = (cmd, args, o) => (ran.push([cmd, ...args, o.cwd]), ok ? { ok: true, code: 0, stdout: out } : { ok: false, code: 2, stdout: "", stderr: "broker 500" });
  const t0 = new Date("2026-11-08T12:00:00Z");
  const at = (min) => new Date(t0.getTime() + min * 60_000);

  assert.deepEqual((await refreshCanvases({ root, config: c, run, env, fetchImpl: s.fetchImpl, now: t0, machine: "mac" }))[0].why, "runs on pc");
  let r = await refreshCanvases({ root, config: c, run, env, fetchImpl: s.fetchImpl, now: t0, machine: "pc" });
  assert.equal(r[0].action, "posted");
  assert.deepEqual(ran[0], ["py", "scripts/a.py", root]);
  const create = s.calls.find((x) => x.method === "conversations.canvases.create");
  assert.equal(create.body.channel_id, "C0ACCOUNT1");
  assert.equal(create.body.document_content.markdown, out);

  r = await refreshCanvases({ root, config: c, run, env, fetchImpl: s.fetchImpl, now: at(5), machine: "pc" });
  assert.equal(r[0].why, "not due");

  ok = false;
  const n = s.calls.length;
  r = await refreshCanvases({ root, config: c, run, env, fetchImpl: s.fetchImpl, now: at(10), machine: "pc" });
  assert.equal(r[0].action, "error");
  assert.match(r[0].why, /exit 2.*broker 500/);
  const alerts = () => s.calls.slice(n).filter((x) => x.method === "chat.postMessage");
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0].body.text, /Alpaca account\* canvas could not refresh/);
  // The canvas keeps the last good copy, labelled stale inside the canvas itself.
  const stale = s.calls.slice(n).find((x) => x.method === "canvases.edit").body.changes[0].document_content.markdown;
  assert.match(stale, /^> ⚠️ \*\*Stale:\*\* this section could not refresh; it shows the copy from .*broker 500/);
  assert.match(stale, /# Account\nequity 10,000$/);
  await refreshCanvases({ root, config: c, run, env, fetchImpl: s.fetchImpl, now: at(20), machine: "pc" });
  assert.equal(alerts().length, 1); // not repeated while it stays broken

  ok = true;
  out = "# Account\nequity 10,100";
  r = await refreshCanvases({ root, config: c, run, env, fetchImpl: s.fetchImpl, now: at(30), machine: "pc" });
  assert.equal(r[0].action, "updated");
  assert.equal(alerts().length, 2);
  assert.match(alerts()[1].body.text, /refreshing again/);
});

test("project canvas without its own channel is a standalone tab in the project channel, set read-only", async () => {
  const c = normalize({ ...base, slack: { channel: "C0123ABCD", canvases: [{ key: "account", title: "Alpaca account", command: ["py"], every_min: 10 }] } });
  const s = fakeSlack();
  await refreshCanvases({ root: tmpRoot(), config: c, run: () => ({ ok: true, code: 0, stdout: "hi" }), env: tmpEnv(), fetchImpl: s.fetchImpl, machine: "pc" });
  assert.deepEqual(s.calls.map((x) => x.method), ["canvases.create", "canvases.access.set"]);
  assert.equal(s.calls[0].body.title, "Alpaca account");
  assert.deepEqual(s.calls[1].body, { canvas_id: "F1", access_level: "read", channel_ids: ["C0123ABCD"] });
});

test("daily board: the first sync after board_daily_at posts a fresh board, unpins and relabels the old one", async () => {
  const root = tmpRoot();
  const env = tmpEnv();
  const c = normalize({ ...base, slack: { channel: "C0123ABCD", board_daily_at: "08:00" } });
  const s = fakeSlack();
  const local = (d, h, m) => new Date(2026, 10, d, h, m); // machine-local clock, like the PC
  const r1 = await syncBoard({ root, config: c, run: ghRun(issues), env, fetchImpl: s.fetchImpl, now: local(9, 18, 0) });
  assert.equal(r1.action, "posted");
  assert.equal(readState(root).slackBoard.day, "2026-11-09");
  // Same day, nothing changed: skipped. Next day before 08:00: still skipped.
  assert.equal((await syncBoard({ root, config: c, run: ghRun(issues), env, fetchImpl: s.fetchImpl, now: local(9, 23, 0) })).action, "skipped");
  assert.equal((await syncBoard({ root, config: c, run: ghRun(issues), env, fetchImpl: s.fetchImpl, now: local(10, 7, 50) })).action, "skipped");
  // Next day at 08:00, unchanged board: posted fresh anyway.
  const n = s.calls.length;
  const r2 = await syncBoard({ root, config: c, run: ghRun(issues), env, fetchImpl: s.fetchImpl, now: local(10, 8, 0) });
  assert.equal(r2.action, "reposted");
  assert.deepEqual(s.calls.slice(n).map((x) => x.method), ["chat.postMessage", "pins.add", "chat.getPermalink", "pins.remove", "chat.update"]);
  assert.equal(s.calls.at(-2).body.timestamp, "100.1");
  assert.equal(s.calls.at(-1).body.ts, "100.1");
  assert.ok(!s.calls.at(-1).body.text.startsWith(boardHeader(c))); // findPinnedBoard can never pick the old one
  assert.equal(readState(root).slackBoard.ts, "100.2");
  assert.equal(readState(root).slackBoard.day, "2026-11-10");
  // Once a day only: later changes that day update the new board in place.
  const r3 = await syncBoard({ root, config: c, run: ghRun(issues.slice(1)), env, fetchImpl: s.fetchImpl, now: local(10, 12, 0) });
  assert.equal(r3.action, "updated");
  assert.equal(s.calls.at(-1).body.ts, "100.2");
  assert.ok(validate({ ...base, slack: { channel: "C0123ABCD", board_daily_at: "8am" } }).some((p) => /board_daily_at/.test(p)));
});

test("canvas parts: a repo file and a command share one canvas; a failing part keeps its last copy, the others still update", async () => {
  const root = tmpRoot();
  const env = tmpEnv();
  // The file comes from origin/main (git show), never from the checkout's working copy.
  let onMain = "---\ntitle: roadmap\n---\n# Roadmap\n## Now\n- Rust P1";
  fs.mkdirSync(path.join(root, "wiki"), { recursive: true });
  fs.writeFileSync(path.join(root, "wiki/roadmap.md"), "# LOCAL EDIT, never published");
  const c = normalize({ ...base, slack: { channel: "C0123ABCD", canvases: [{ key: "live", title: "Live", every_min: 10, channel: "C0123ABCD",
    parts: [{ command: ["py", "acct.py"] }, { file: "wiki/roadmap.md" }] }] } });
  assert.deepEqual(validate({ ...base, slack: { channel: "C0123ABCD", canvases: [{ key: "a", title: "A", every_min: 10, command: ["x"], parts: [{ file: "a.md" }] }] } }).filter((p) => /exactly one/.test(p)).length, 1);
  assert.ok(validate({ ...base, slack: { channel: "C0123ABCD", canvases: [{ key: "a", title: "A", every_min: 10, parts: [{ file: "../x.md" }] }] } }).some((p) => /parts/.test(p)));
  assert.ok(validate({ ...base, slack: { channel: "C0123ABCD", canvas: true, canvases: [{ key: "a", title: "A", every_min: 10, channel: "C0123ABCD", command: ["x"] }] } }).some((p) => /already gives the board/.test(p)));
  const s = fakeSlack();
  let ok = true;
  const gitCalls = [];
  const run = (cmd, args) => {
    if (cmd === "git") {
      gitCalls.push(args.join(" "));
      return args[0] === "show" ? { ok: true, code: 0, stdout: onMain } : { ok: true, code: 0, stdout: "" };
    }
    return ok ? { ok: true, code: 0, stdout: "# Account\nequity 1" } : { ok: false, code: 2, stdout: "", stderr: "broker down" };
  };
  const t0 = new Date("2026-11-08T12:00:00Z");
  const at = (min) => new Date(t0.getTime() + min * 60_000);
  const md = () => s.calls.filter((x) => /canvas/.test(x.method) && x.body.changes?.[0]?.operation !== "rename").at(-1).body;
  const foot = "\n\n_Published from wiki/roadmap.md on main. Edit it by PR; edits made here are overwritten._";

  let r = await refreshCanvases({ root, config: c, run, env, fetchImpl: s.fetchImpl, now: t0, machine: "pc" });
  assert.equal(r[0].action, "posted");
  assert.deepEqual(gitCalls, ["fetch --quiet origin +refs/heads/main:refs/remotes/origin/main", "show origin/main:wiki/roadmap.md"]);
  assert.equal(md().document_content.markdown, `# Account\nequity 1\n\n---\n\n# Roadmap\n## Now\n- Rust P1${foot}`);

  ok = false;
  onMain = "# Roadmap\n## Now\n- Rust P2";
  r = await refreshCanvases({ root, config: c, run, env, fetchImpl: s.fetchImpl, now: at(10), machine: "pc" });
  assert.equal(r[0].action, "error");
  assert.equal(r[0].published, "updated");
  const now2 = md().changes[0].document_content.markdown;
  assert.match(now2, /^> ⚠️ \*\*Stale:\*\*.*broker down.*\n\n# Account\nequity 1\n\n---\n\n# Roadmap\n## Now\n- Rust P2/s);
  assert.match(s.calls.filter((x) => x.method === "chat.postMessage").at(-1).body.text, /Live\* canvas could not refresh.*broker down/);
});

test("canvas name: the channel canvas is created with the title and renamed when the title changes", async () => {
  const root = tmpRoot();
  const s = fakeSlack();
  const pub = (title, markdown, now) => publishCanvas({ root, key: "live", channel: "C0123ABCD", title, markdown, hash: markdown, token: "xoxb-test", fetchImpl: s.fetchImpl, now });
  const t0 = new Date("2026-11-08T12:00:00Z");
  await pub("Live board", "a", t0);
  assert.equal(s.calls[0].method, "conversations.canvases.create");
  assert.equal(s.calls[0].body.title, "Live board");
  // Same content, but the create-time title is not trusted on a channel canvas: one explicit rename.
  const r = await pub("Live board", "a", t0);
  assert.equal(r.action, "updated");
  const rename = s.calls.find((c) => c.body.changes?.[0]?.operation === "rename");
  assert.deepEqual(rename.body.changes[0].title_content, { type: "markdown", markdown: "Live board" });
  // Then nothing until the content or the title changes.
  const n = s.calls.length;
  assert.equal((await pub("Live board", "a", t0)).action, "skipped");
  await pub("Trading live", "a", t0);
  assert.deepEqual(s.calls.slice(n).map((c) => c.body.changes[0].operation), ["replace", "rename"]);
  // A refused rename never blocks the content and is not retried every tick.
  const bad = fakeSlack({ canvas: { "canvases.edit": (b) => (b.changes[0].operation === "rename" ? { ok: false, error: "invalid_arguments" } : { ok: true }) } });
  const root2 = tmpRoot();
  const pub2 = (title, markdown) => publishCanvas({ root: root2, key: "live", channel: "C0123ABCD", title, markdown, hash: markdown, token: "xoxb-test", fetchImpl: bad.fetchImpl, now: t0 });
  await pub2("X", "a");
  assert.equal((await pub2("X", "b")).action, "updated");
  assert.equal((await pub2("X", "b")).action, "skipped");
});

test("watch: project canvases refresh before dispatch", async () => {
  const order = [];
  const c = normalize({ ...base, slack: { channel: "C0123ABCD", canvases: [{ key: "account", title: "A", command: ["py"], every_min: 10 }] } });
  await runWatch({
    root: tmpRoot(), config: c, env: tmpEnv(), now: new Date("2026-11-08T10:00:00Z"),
    canvases: async () => (order.push("canvases"), []),
    dispatch: async () => (order.push("dispatch"), { action: "idle" }),
    board: async () => (order.push("board"), { action: "skipped" }),
    news: async () => ({ ok: true }),
  });
  assert.deepEqual(order, ["canvases", "dispatch", "board"]);
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

test("watch: when dev runs start, the board refreshes and a 'started' line goes out before the batch ends", async () => {
  const order = [];
  const r = await runWatch({
    root: tmpRoot(), config, env: tmpEnv(), now: new Date("2026-11-08T10:00:00Z"),
    dispatch: async ({ onStart }) => {
      await onStart({ action: "started", issues: [381, 382] });
      order.push("batch ran");
      return { action: "idle" };
    },
    board: async () => (order.push("board"), { action: "updated" }),
    news: async ({ text }) => (order.push(text), { ok: true }),
  });
  assert.deepEqual(order.slice(0, 3).map((x) => x.slice(0, 20)), ["board", "🏗️ 2 dev workers st", "batch ran"]);
  assert.match(order[1], /issues\/381\|#381>, <https:\/\/github.com\/jk\/proj\/issues\/382\|#382>/);
  assert.deepEqual(r.started.issues, [381, 382]);
  assert.match(dispatchNews({ action: "started", issues: [5], fix: true, pr: 9 }, config), /fixing Codex's comments/);
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

test("notifyOwner: @mentions every commander in the project channel; no channel is a clean refusal", async () => {
  const { notifyOwner } = await import("../lib/slack.mjs");
  const sent = [];
  const fetchImpl = async (url, o) => (sent.push(Object.fromEntries(new URLSearchParams(o.body))), { json: async () => ({ ok: true }) });
  const config = { slack: { channel: "C0123ABCD", commanders: ["U0OWNER01"], news: false } };
  const r = await notifyOwner({ config, text: "UAC prompt waiting on the PC", env: { CREW_SLACK_TOKEN: "xoxb-t" }, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(sent[0].channel, "C0123ABCD");
  assert.equal(sent[0].text, "<@U0OWNER01> 🔔 UAC prompt waiting on the PC");
  assert.match((await notifyOwner({ config: {}, text: "x" })).why, /no slack channel/);
});

test("dispatchNews: the PM's decisions on stuck PRs", () => {
  const config = { repo: "jk/proj" };
  assert.match(dispatchNews({ action: "pm-queued", issue: 4 }, config), /the PM is deciding/);
  assert.match(dispatchNews({ action: "pm-again", issue: 4, why: "only the null check is real" }, config), /PM sent .* back.*only the null check is real/);
  assert.match(dispatchNews({ action: "pm-merged", issue: 4, pr: 12, why: "false alarm" }, config), /PM merged .*false alarm/);
  assert.match(dispatchNews({ action: "pm-owner", issue: 4, why: "scope call" }, config), /needs-jk.*scope call/);
});

test("board: sessions section after workers", () => {
  const cols = collectBoard(config, ghRun(issues));
  const sessions = [{ id: "s1", host: "Mac", machine: "mac", cwd: "/x/proj", worktree: null, started: "2026-11-08T11:18:00Z", updated: "2026-11-08T11:57:00Z", files: ["a", "b"] }];
  const now = new Date("2026-11-08T12:00:00Z");
  const text = renderBoard(config, cols, now, [], sessions);
  assert.match(text, /🧑‍💻 \*Sessions\* \(1\) · open on this machine\n• mac · proj · open 42m · active 3m ago · 2 files/);
  assert.ok(text.indexOf("*Sessions*") > text.indexOf("*Workers*"));
  assert.ok(text.indexOf("*Sessions*") < text.indexOf("*Ready*"));
  const md = renderBoardMarkdown(config, cols, now, [], [{ ...sessions[0], machine: null, worktree: "/x/proj/.claude/worktrees/fix-it" }]);
  assert.match(md, /## 🧑‍💻 Sessions \(1\) · open on this machine\n- Mac · fix-it · open 42m · active 3m ago · 2 files/);
});

test("board: no sessions shows none", () => {
  const text = renderBoard(config, collectBoard(config, ghRun(issues)), new Date("2026-11-08T12:00:00Z"));
  assert.match(text, /\*Sessions\* \(0\) · open on this machine\n• none/);
});

test("board: a session opening changes the hash", async () => {
  const root = tmpRoot();
  const env = tmpEnv();
  const s = fakeSlack();
  const t = new Date();
  assert.equal((await syncBoard({ root, config: cfgC, run: ghRun(issues), env, fetchImpl: s.fetchImpl, now: t })).action, "posted");
  assert.equal((await syncBoard({ root, config: cfgC, run: ghRun(issues), env, fetchImpl: s.fetchImpl, now: t })).action, "skipped");
  fs.mkdirSync(path.join(root, ".crew", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(root, ".crew", "sessions", "s1.json"), JSON.stringify({ id: "s1", host: os.hostname(), started: t.toISOString(), updated: t.toISOString(), files: [] }));
  assert.equal((await syncBoard({ root, config: cfgC, run: ghRun(issues), env, fetchImpl: s.fetchImpl, now: t })).action, "updated");
});

test("watch: skips the tick while crew is updating", async () => {
  const { markUpdating } = await import("../lib/update.mjs");
  const env = { ...tmpEnv(), XDG_DATA_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "crew-upd-")) };
  env.LOCALAPPDATA = env.XDG_DATA_HOME;
  markUpdating(env);
  const called = [];
  const r = await runWatch({
    root: tmpRoot(), config: cfgC, env, now: new Date(),
    dispatch: async () => (called.push("dispatch"), { action: "idle" }),
    board: async () => (called.push("board"), { action: "skipped" }),
    news: async () => ({ ok: true }),
  });
  assert.deepEqual(r, { skipped: "crew is updating" });
  assert.deepEqual(called, []);
});
