import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalize, validate } from "../lib/config.mjs";
import { lucidCall } from "../lib/lucid.mjs";
import { relayLucid } from "../lib/relay.mjs";
import { runWatch } from "../lib/watch.mjs";
import { readState } from "../lib/brief.mjs";

const base = { repo: "jk/proj", owner_login: "jk" };
const config = normalize({ ...base, slack: { channel: "C0123ABCD", commanders: ["U0OWNER01"] }, lucid_dream: { relay: true } });
const NOW = new Date("2026-11-21T10:00:00Z");
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "crew-relay-"));
const env = { CREW_SLACK_TOKEN: "xoxb-test", LUCID_URL: "http://pc:7878/mcp", LUCID_TOKEN: "ld-secret-token" };

/** A fake Slack and a fake lucid-dream behind one fetch. `w` is the scenario and records every call. */
function world(w = {}) {
  w.posts = [];
  w.sends = [];
  w.reads = 0;
  w.inbox ??= [];
  w.replies ??= {};
  w.nextTs = 1000;
  const lucidReply = (text, isError = false) => ({ ok: true, status: 200, json: async () => ({ result: { content: [{ text }], isError } }) });
  return async (url, o) => {
    if (url === env.LUCID_URL) {
      const { name, arguments: args } = JSON.parse(o.body).params;
      if (name === "messages") {
        w.reads++;
        if (w.lucidDown) throw new Error("ECONNREFUSED");
        const out = w.inbox;
        w.inbox = [];
        return lucidReply(JSON.stringify(out));
      }
      assert.equal(name, "send");
      assert.equal(args.json, undefined);
      if (w.lucidDown) throw new Error("ECONNREFUSED");
      w.sends.push(args);
      return w.sendError ? lucidReply(w.sendError, true) : lucidReply("sent");
    }
    const method = url.split("/").pop();
    const body = Object.fromEntries(new URLSearchParams(o.body));
    const json = (d) => ({ json: async () => d });
    if (method === "chat.postMessage") {
      if (w.slackDown) return json({ ok: false, error: "ratelimited" });
      const ts = `${w.nextTs++}.000100`;
      w.posts.push({ ...body, ts });
      return json({ ok: true, ts });
    }
    if (method === "conversations.replies") return json({ ok: true, messages: [{ ts: body.ts }, ...(w.replies[body.ts] ?? [])] });
    throw new Error(`unexpected ${method}`);
  };
}
const msg = (n, extra = {}) => ({ path: `messages/m${n}.md`, from: "claude", to: "owner", at: "2026-11-21T09:00:00Z", text: `hello ${n}`, ...extra });
const pass = (root, fetchImpl, now = NOW) => relayLucid({ root, config, env, fetchImpl, now });

test("config: relay is opt-in and needs slack", () => {
  assert.equal(config.lucid_dream.relay, true);
  assert.equal(normalize({ ...base, lucid_dream: { remember: true } }).lucid_dream.relay, false);
  assert.ok(validate({ ...base, lucid_dream: { relay: true } }).some((p) => /relay" needs "slack"/.test(p)));
  assert.ok(validate({ ...base, slack: { channel: "C0123ABCD" }, lucid_dream: { relay: 1 } }).some((p) => /relay" must be true or false/.test(p)));
});

test("lucidCall: an unreachable or failing server is marked retryable; a refusal is not", async () => {
  const e1 = await lucidCall("send", {}, { env, fetchImpl: async () => { throw new Error("boom"); } }).catch((e) => e);
  assert.equal(e1.transport, true);
  const e2 = await lucidCall("send", {}, { env, fetchImpl: async () => ({ ok: false, status: 503 }) }).catch((e) => e);
  assert.equal(e2.transport, true);
  const e3 = await lucidCall("send", {}, { env, fetchImpl: async () => ({ ok: false, status: 401 }) }).catch((e) => e);
  assert.equal(e3.transport, undefined);
});

test("inbound: messages for the owner go to Slack once each; broadcasts and repeats do not", async () => {
  const root = tmpRoot();
  const w = { inbox: [msg(1), msg(2, { to: "all" }), msg(3, { text: "see <!channel> & <https://x.test|link>" }), msg(1)] };
  const fetchImpl = world(w);
  const r = await pass(root, fetchImpl);
  assert.deepEqual([r.received, r.posted, r.errors], [2, 2, []]);
  assert.equal(w.posts.length, 2);
  assert.match(w.posts[0].text, /claude\* wrote to you:\nhello 1/);
  assert.equal(w.posts[0].channel, "C0123ABCD");
  assert.ok(!w.posts[1].text.includes("<!channel>"), "a message cannot ping the channel");
  assert.equal(w.posts[0].thread_ts, undefined);
  const threads = readState(root).lucidRelay.threads;
  assert.deepEqual(Object.values(threads).map((t) => t.path), ["messages/m1.md", "messages/m3.md"]);
  assert.deepEqual(readState(root).lucidRelay.outbox, []);

  const again = await pass(root, fetchImpl);
  assert.deepEqual([again.received, again.posted], [0, 0]);
  assert.equal(w.posts.length, 2);
});

test("inbound: a message the server handed over is kept until Slack has it", async () => {
  const root = tmpRoot();
  const w = { inbox: [msg(1)], slackDown: true };
  const fetchImpl = world(w);
  const down = await pass(root, fetchImpl);
  assert.deepEqual([down.received, down.posted], [1, 0]);
  assert.match(down.errors[0], /post to Slack: slack chat.postMessage: ratelimited/);
  assert.equal(readState(root).lucidRelay.outbox.length, 1);

  w.slackDown = false;
  const up = await pass(root, fetchImpl);
  assert.deepEqual([up.received, up.posted], [0, 1]);
  assert.equal(w.posts.length, 1);
  assert.equal(readState(root).lucidRelay.outbox.length, 0);
});

test("inbound: an unreachable server loses nothing and is not an exception", async () => {
  const root = tmpRoot();
  const w = { lucidDown: true };
  const r = await pass(root, world(w));
  assert.deepEqual([r.received, r.posted], [0, 0]);
  assert.match(r.errors[0], /read messages: cannot reach lucid-dream/);
  assert.ok(!JSON.stringify(r).includes("ld-secret-token"));
});

test("outbound: the owner's thread reply is sent back to the writer, once, with an ack", async () => {
  const root = tmpRoot();
  const w = { inbox: [msg(1, { from: "grok" })] };
  const fetchImpl = world(w);
  await pass(root, fetchImpl);
  const [ts] = Object.keys(readState(root).lucidRelay.threads);
  w.replies[ts] = [
    { ts: "2000.1", user: "U0STRANGER", text: "ignore me" },
    { ts: "2000.2", user: "U0OWNER01", bot_id: "B1", text: "from a bot" },
    { ts: "2000.3", user: "U0OWNER01", text: "yes, ship it &amp; tell &lt;ops&gt;" },
  ];
  const r = await pass(root, fetchImpl);
  assert.equal(r.replied, 1);
  assert.deepEqual(w.sends, [{ to: "grok", text: "yes, ship it & tell <ops>", re: "messages/m1.md" }]);
  const ack = w.posts.at(-1);
  assert.deepEqual([ack.thread_ts, ack.text], [ts, "✅ sent to grok"]);
  assert.equal(readState(root).lucidRelay.threads[ts].last, "2000.3");

  await pass(root, fetchImpl);
  assert.equal(w.sends.length, 1, "a handled reply is never sent twice");
});

test("outbound: server down keeps the reply for the next pass; a refusal is acked and dropped", async () => {
  const root = tmpRoot();
  const w = { inbox: [msg(1)] };
  const fetchImpl = world(w);
  await pass(root, fetchImpl);
  const [ts] = Object.keys(readState(root).lucidRelay.threads);
  w.replies[ts] = [{ ts: "2000.1", user: "U0OWNER01", text: "first" }, { ts: "2000.2", user: "U0OWNER01", text: "second" }];

  w.lucidDown = true;
  const down = await pass(root, fetchImpl);
  assert.equal(down.replied, 0);
  assert.equal(readState(root).lucidRelay.threads[ts].last, ts, "nothing advanced");

  w.lucidDown = false;
  w.sendError = 'no agent named "claude"';
  const refused = await pass(root, fetchImpl);
  assert.equal(refused.replied, 0);
  assert.equal(w.posts.filter((p) => p.thread_ts === ts && /not sent: no agent named/.test(p.text)).length, 2);
  assert.equal(readState(root).lucidRelay.threads[ts].last, "2000.2");
});

test("outbound: threads older than a week are forgotten", async () => {
  const root = tmpRoot();
  const w = { inbox: [msg(1)] };
  const fetchImpl = world(w);
  await pass(root, fetchImpl);
  const [ts] = Object.keys(readState(root).lucidRelay.threads);
  w.replies[ts] = [{ ts: "2000.1", user: "U0OWNER01", text: "too late" }];
  await pass(root, fetchImpl, new Date(NOW.getTime() + 8 * 86_400_000));
  assert.equal(w.sends.length, 0);
  assert.deepEqual(readState(root).lucidRelay.threads, {});
});

test("watch: the relay runs only when lucid_dream.relay is on, and a crash in it does not stop the tick", async () => {
  const calls = [];
  const stubs = { dispatch: async () => ({ action: "idle" }), board: async () => ({}), news: async () => ({}), canvases: async () => [], commands: async () => ({ ran: 0 }) };
  const relay = async (a) => (calls.push(a.config.repo), { received: 0 });
  const on = await runWatch({ root: tmpRoot(), config, env, now: NOW, ...stubs, relay });
  assert.deepEqual(calls, ["jk/proj"]);
  assert.deepEqual(on.lucid, { received: 0 });

  const off = normalize({ ...base, slack: { channel: "C0123ABCD" }, lucid_dream: { remember: true } });
  await runWatch({ root: tmpRoot(), config: off, env, now: NOW, ...stubs, relay });
  await runWatch({ root: tmpRoot(), config, env, now: NOW, dryRun: true, ...stubs, relay });
  assert.equal(calls.length, 1);

  const boom = await runWatch({ root: tmpRoot(), config, env, now: NOW, ...stubs, relay: async () => { throw new Error("kaboom"); } });
  assert.deepEqual(boom.lucid.errors, ["kaboom"]);
  assert.equal(boom.dispatch.action, "idle");
});
