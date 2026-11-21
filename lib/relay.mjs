// Owner relay between lucid-dream and Slack (opt-in: "lucid_dream": {"relay": true}). Run by `crew watch`.
//   in:  messages other agents left for the owner's lucid-dream agent are posted to the project channel,
//        one Slack message each. They are read from the server once, so they are parked in
//        .crew/state.json first and only dropped after Slack has them.
//   out: a reply written IN THAT THREAD by a slack.commanders user is sent back with `send` to the agent
//        that wrote it. Nothing in a reply is run or parsed: it is passed on as plain text.
// Up to one watch interval (10 minutes) of delay each way.
import { lucidCall } from "./lucid.mjs";
import { slackCall, slackToken, mrkdwn } from "./slack.mjs";
import { readState, writeState } from "./brief.mjs";
import { logLine } from "./state.mjs";

export const MAX_POSTS_PER_TICK = 10;
export const MAX_THREADS = 20;
export const THREAD_DAYS = 7;
const MAX_TEXT = 3000;

const unslack = (s) => String(s ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();

/**
 * One relay pass. Never throws: each half reports its own error in the result.
 * @returns {Promise<{received:number, posted:number, replied:number, errors:string[]}>}
 */
export async function relayLucid({ root, config, env = process.env, fetchImpl = globalThis.fetch, now = new Date() }) {
  const out = { received: 0, posted: 0, replied: 0, errors: [] };
  const channel = config.slack.channel;
  const commanders = config.slack.commanders ?? [];
  const call = (m, b) => slackCall(m, b, { token: slackToken(env), fetchImpl });
  const lucid = (tool, args) => lucidCall(tool, args, { env, fetchImpl });
  const state = () => {
    const s = readState(root).lucidRelay ?? {};
    return { outbox: s.outbox ?? [], threads: s.threads ?? {} };
  };
  const save = (s) => writeState(root, { ...readState(root), lucidRelay: s });
  const fail = (what, e) => {
    out.errors.push(`${what}: ${e.message}`);
    logLine(root, { action: "lucid-relay", outcome: "error", detail: `${what}: ${e.message}` });
  };

  // 1. Take what is waiting on the server and park it before anything else can fail.
  try {
    const list = JSON.parse(await lucid("messages", { json: true }));
    const s = state();
    const known = new Set([...s.outbox.map((m) => m.path), ...Object.values(s.threads).map((t) => t.path)]);
    for (const m of Array.isArray(list) ? list : []) {
      if (!m?.path || m.to === "all" || known.has(m.path)) continue; // a broadcast is not for the owner
      known.add(m.path);
      s.outbox.push({ path: m.path, from: String(m.from ?? "?"), at: m.at ?? null, text: String(m.text ?? "") });
      out.received++;
    }
    if (out.received) save(s);
  } catch (e) {
    fail("read messages", e);
  }

  // 2. Post parked messages to Slack, one thread each.
  for (let i = 0; i < MAX_POSTS_PER_TICK; i++) {
    const s = state();
    const m = s.outbox[0];
    if (!m) break;
    const body = mrkdwn(m.text.length > MAX_TEXT ? `${m.text.slice(0, MAX_TEXT)} ... (cut)` : m.text);
    try {
      const r = await call("chat.postMessage", {
        channel, unfurl_links: false, unfurl_media: false,
        text: `📨 *${mrkdwn(m.from)}* wrote to you:\n${body}\n\n_Reply in this thread and crew sends it back to ${mrkdwn(m.from)}._`,
      });
      s.outbox.shift();
      s.threads[r.ts] = { from: m.from, path: m.path, at: now.toISOString(), last: r.ts };
      save(s);
      out.posted++;
    } catch (e) {
      fail("post to Slack", e);
      break;
    }
  }

  // 3. Send the owner's thread replies back.
  if (commanders.length) {
    const s = state();
    const cutoff = now.getTime() - THREAD_DAYS * 86_400_000;
    for (const [ts, t] of Object.entries(s.threads)) if (Date.parse(t.at) < cutoff) delete s.threads[ts];
    const live = Object.entries(s.threads).sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, MAX_THREADS);
    for (const [ts, t] of live) {
      let replies;
      try {
        const r = await call("conversations.replies", { channel, ts, oldest: t.last, limit: 50 });
        replies = (r.messages ?? []).filter((m) => m.ts !== ts && Number(m.ts) > Number(t.last)).sort((a, b) => Number(a.ts) - Number(b.ts));
      } catch (e) {
        fail("read Slack replies", e);
        continue;
      }
      for (const m of replies) {
        if (!m.bot_id && commanders.includes(m.user) && unslack(m.text)) {
          let ack;
          try {
            await lucid("send", { to: t.from, text: unslack(m.text), re: t.path });
            ack = `✅ sent to ${mrkdwn(t.from)}`;
            out.replied++;
          } catch (e) {
            if (e.transport) { fail("send reply", e); break; } // server unreachable: this reply is tried again next tick
            ack = `⚠️ not sent: ${mrkdwn(e.message)}`;
            fail("send reply", e);
          }
          await call("chat.postMessage", { channel, thread_ts: ts, text: ack, unfurl_links: false }).catch(() => {});
        }
        t.last = m.ts; // past it: handled, or not the owner's
      }
    }
    save(s);
  }
  return out;
}
