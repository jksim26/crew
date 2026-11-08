// Slack: one pinned "board" message per project channel, kept in step with the GitHub labels, plus
// short news lines (briefs, builds, blocks). GitHub stays the truth; Slack is the window.
// Needs a bot token (xoxb-) with chat:write, pins:read and pins:write, and the bot invited to the channel.
import crypto from "node:crypto";
import { run as realRun } from "./exec.mjs";
import { ghJson } from "./gh.mjs";
import { readLocal } from "./secrets.mjs";
import { readState, writeState } from "./brief.mjs";
import { machineNames } from "./config.mjs";
import { localStamp } from "./render.mjs";

export const SLACK_TOKEN_KEY = "CREW_SLACK_TOKEN";

export const slackToken = (env = process.env) => readLocal(SLACK_TOKEN_KEY, env);

/** Call one Slack Web API method. Throws with Slack's error code on failure. */
export async function slackCall(method, body, { token, fetchImpl = globalThis.fetch }) {
  if (!token) throw new Error(`no Slack token (run: crew token set --slack)`);
  const res = await fetchImpl(`https://slack.com/api/${method}`, {
    method: "POST",
    // Form-encoded works for every method; read methods such as pins.list reject a JSON body.
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${token}` },
    body: new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString(),
  });
  const data = await res.json().catch(() => ({ ok: false, error: `http ${res.status}` }));
  if (!data.ok) {
    const err = new Error(`slack ${method}: ${data.error ?? "failed"}`);
    err.code = data.error;
    throw err;
  }
  return data;
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Markdown (links, bold) to Slack mrkdwn, with everything else escaped. */
export function mrkdwn(md) {
  const parts = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m;
  const text = String(md ?? "");
  while ((m = re.exec(text))) {
    parts.push(esc(text.slice(last, m.index)), `<${m[2].replace(/[<>|]/g, "")}|${esc(m[1]).replace(/\|/g, "/")}>`);
    last = m.index + m[0].length;
  }
  parts.push(esc(text.slice(last)));
  return parts.join("").replace(/\*\*([^*]+)\*\*/g, "*$1*");
}

export const COLUMNS = [
  { state: "ready", title: "Ready", icon: "🟢", hint: "approved, waiting for the dev worker" },
  { state: "doing", title: "Doing", icon: "🔵", hint: "being built now" },
  { state: "in-review", title: "In review", icon: "🟣", hint: "PR open" },
  { state: "blocked", title: "Blocked", icon: "🔴", hint: "needs you to unstick it" },
  { state: "needs-jk", title: "Waiting for your OK", icon: "🟡", hint: "label ready to approve" },
];

/** Open issues grouped by crew state, plain data (no model). */
export function collectBoard(config, run = realRun) {
  const list = ghJson(run, ["issue", "list", "--repo", config.repo, "--state", "open", "--limit", "300",
    "--json", "number,title,labels,url"]) ?? [];
  const names = machineNames(config);
  const cols = Object.fromEntries(COLUMNS.map((c) => [c.state, []]));
  for (const i of list) {
    const labels = (i.labels ?? []).map((l) => l.name);
    // An issue in two states shows once, in the furthest-along column.
    const state = ["doing", "in-review", "blocked", "ready", "needs-jk"].find((s) => labels.includes(s));
    if (!state) continue;
    const machine = labels.find((l) => names.includes(l)) ?? null;
    cols[state].push({ number: i.number, title: String(i.title ?? "").replace(/\s+/g, " ").trim().slice(0, 90), url: i.url, machine });
  }
  for (const c of Object.values(cols)) c.sort((a, b) => a.number - b.number);
  return cols;
}

const MAX_PER_COLUMN = 30;

/** The pinned message text. The first line is fixed so the message can be found again. */
export function renderBoard(config, cols, now = new Date()) {
  const head = boardHeader(config);
  const lines = [head, `_updated ${localStamp(now.toISOString())} · GitHub labels are the truth; this copies them_`, ""];
  for (const c of COLUMNS) {
    const items = cols[c.state] ?? [];
    lines.push(`${c.icon} *${c.title}* (${items.length}) · ${c.hint}`);
    for (const i of items.slice(0, MAX_PER_COLUMN))
      lines.push(`• <${i.url}|#${i.number}> ${esc(i.title)}${i.machine ? ` · _${i.machine}_` : ""}`);
    if (items.length > MAX_PER_COLUMN)
      lines.push(`• <https://github.com/${config.repo}/issues?q=is%3Aissue+is%3Aopen+label%3A${encodeURIComponent(c.state)}|…and ${items.length - MAX_PER_COLUMN} more on GitHub>`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export const boardHeader = (config) => `*crew board · ${config.repo}*`;

export function boardHash(cols) {
  return crypto.createHash("sha256").update(JSON.stringify(cols)).digest("hex").slice(0, 16);
}

/**
 * Post or update the pinned board. Skips when nothing changed since the last update.
 * @returns {Promise<{action:"skipped"|"updated"|"posted", ts?:string}>}
 */
export async function syncBoard({ root, config, run = realRun, env = process.env, fetchImpl = globalThis.fetch, now = new Date(), force = false }) {
  if (!config.slack?.board) return { action: "skipped", why: "no slack board configured" };
  const token = slackToken(env);
  const channel = config.slack.channel;
  const cols = collectBoard(config, run);
  const hash = boardHash(cols);
  const state = readState(root);
  const prev = state.slackBoard?.channel === channel ? state.slackBoard : null;
  if (!force && prev?.hash === hash) return { action: "skipped", why: "board unchanged" };
  const text = renderBoard(config, cols, now);
  const call = (m, b) => slackCall(m, b, { token, fetchImpl });

  let ts = prev?.ts ?? (await findPinnedBoard(config, call));
  let action = "updated";
  if (ts) {
    try {
      await call("chat.update", { channel, ts, text });
    } catch (e) {
      if (!["message_not_found", "cant_update_message", "edit_window_closed"].includes(e.code)) throw e;
      ts = null;
    }
  }
  if (!ts) {
    ts = (await call("chat.postMessage", { channel, text, unfurl_links: false, unfurl_media: false })).ts;
    try {
      await call("pins.add", { channel, timestamp: ts });
    } catch (e) {
      if (e.code !== "already_pinned") throw e;
    }
    action = "posted";
  }
  writeState(root, { ...readState(root), slackBoard: { channel, ts, hash, at: now.toISOString() } });
  return { action, ts };
}

/** A board this bot pinned earlier (state lost, or another checkout posted it). */
async function findPinnedBoard(config, call) {
  let items = [];
  try {
    items = (await call("pins.list", { channel: config.slack.channel })).items ?? [];
  } catch (e) {
    if (e.code === "missing_scope") return null;
    throw e;
  }
  const head = boardHeader(config);
  const hit = items.find((i) => i.type === "message" && i.message?.bot_id && String(i.message.text ?? "").startsWith(head));
  return hit?.message?.ts ?? null;
}

/** One news line to the project channel. Never throws: news is best effort, the work already happened. */
export async function postNews({ config, text, env = process.env, fetchImpl = globalThis.fetch }) {
  if (!config.slack?.news) return { ok: false, why: "no slack news configured" };
  try {
    await slackCall("chat.postMessage", { channel: config.slack.channel, text, unfurl_links: false, unfurl_media: false }, { token: slackToken(env), fetchImpl });
    return { ok: true };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

/**
 * A heads-up that needs the owner now (an admin/UAC prompt, a login, a click at the machine):
 * posted to the project channel with an @mention of every commander, so their phone buzzes and a
 * messenger bot watching the channel can relay it. Never throws.
 */
export async function notifyOwner({ config, text, env = process.env, fetchImpl = globalThis.fetch }) {
  if (!config.slack?.channel) return { ok: false, why: "no slack channel in crew.json" };
  const who = (config.slack.commanders ?? []).map((u) => `<@${u}>`).join(" ");
  const body = `${who ? `${who} ` : ""}🔔 ${text}`;
  try {
    await slackCall("chat.postMessage", { channel: config.slack.channel, text: body, unfurl_links: false, unfurl_media: false }, { token: slackToken(env), fetchImpl });
    return { ok: true, text: body };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

/** The brief as a short Slack message: the headline, what happened, what needs the owner, a link. */
export function briefNews({ status, mode, url = null }) {
  const lines = [`${mode === "weekly" ? "🗓️ *Week in review*" : "📰 *Brief*"}: ${mrkdwn(status.headline)}`, "", mrkdwn(status.what_happened)];
  if (mode === "weekly" && status.week_in_review) lines.push("", mrkdwn(status.week_in_review));
  if (status.blocked.length) lines.push("", `*Stuck (${status.blocked.length}):* ${status.blocked.map((b) => mrkdwn(b.what)).join(" · ")}`);
  if (status.decisions.length) {
    lines.push("", "*For you to decide:*");
    status.decisions.forEach((d, i) => lines.push(`${i + 1}. ${mrkdwn(d.question)} _(my pick: ${mrkdwn(d.recommendation)})_`));
  }
  lines.push("", `*Next:* ${mrkdwn(status.next)}`);
  if (url) lines.push(`<${url}|full brief>`);
  return lines.join("\n");
}

/** A dispatch result as one news line, or null when there is nothing worth saying. */
export function dispatchNews(r, config) {
  if (r.action === "batch") return r.results.map((x) => dispatchNews(x, config)).filter(Boolean).join("\n") || null;
  const link = (n) => `<https://github.com/${config.repo}/issues/${n}|#${n}>`;
  switch (r.action) {
    case "built": return `🛠️ Built ${link(r.issue)}${r.url ? `: <${r.url}|PR>` : ""}${r.draft ? ` (draft: ${esc(r.draft)})` : r.gate ? " (trading code: the review gate decides)" : r.protected?.length ? " (touches protected files, waits for you)" : ", Codex reviewing"}`;
    case "started": return r.fix
      ? `🔧 A dev worker is fixing Codex's comments on ${link(r.issues[0])}`
      : `🏗️ ${r.issues.length === 1 ? "A dev worker started" : `${r.issues.length} dev workers started`}: ${r.issues.map(link).join(", ")}`;
    case "fixed": return `🔧 Fixed the review comments on ${link(r.issue)}`;
    case "blocked": return `🔴 ${link(r.issue)} is stuck after ${r.rounds ?? "its"} fix round${r.rounds === 1 ? "" : "s"}; it needs you`;
    case "failed": return `⚠️ ${r.issue ? link(r.issue) : "A dev run"} failed: ${esc(String(r.why ?? "").slice(0, 200))}`;
    case "canary-failed": return /ETIMEDOUT|took over/i.test(String(r.why ?? ""))
      ? `⏳ The login check took too long (machine busy); the next run tries again`
      : `⚠️ The dev worker could not log in (${esc(String(r.why ?? "").slice(0, 120))}). Check the token: crew token set`;
    default: return null;
  }
}
