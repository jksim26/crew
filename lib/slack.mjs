// Slack: one pinned "board" message per project channel, kept in step with the GitHub labels, plus
// short news lines (briefs, builds, blocks). GitHub stays the truth; Slack is the window.
// Needs a bot token (xoxb-) with chat:write, pins:read and pins:write, and the bot invited to the channel.
// Canvases (the board as the channel canvas, plus any slack.canvases a project defines) also need
// canvases:write. Without it the pinned message still works; the canvas half logs the refusal and
// tries again every few hours.
// Canvases (the board as a channel canvas, plus any slack.canvases a project defines) also need
// canvases:write, and channels:read to find a channel canvas someone else created. Without them the
// pinned message still works; the canvas half logs the error and retries every few hours.
import crypto from "node:crypto";
import path from "node:path";
import { run as realRun } from "./exec.mjs";
import { ghJson } from "./gh.mjs";
import { readLocal } from "./secrets.mjs";
import { readState, writeState } from "./brief.mjs";
import { machineNames } from "./config.mjs";
import { localStamp } from "./render.mjs";
import { liveWorkers, logLine, withFileLock } from "./state.mjs";
import { thisMachine } from "./machine.mjs";

export const SLACK_TOKEN_KEY = "CREW_SLACK_TOKEN";

export const slackToken = (env = process.env) => readLocal(SLACK_TOKEN_KEY, env);

/** Call one Slack Web API method. Throws with Slack's error code on failure. */
export async function slackCall(method, body, { token, fetchImpl = globalThis.fetch, json = false }) {
  if (!token) throw new Error(`no Slack token (run: crew token set --slack)`);
  const res = await fetchImpl(`https://slack.com/api/${method}`, {
    method: "POST",
    // Form-encoded works for every flat method; read methods such as pins.list reject a JSON body.
    // Canvas methods take nested objects (document_content, changes), so they go as JSON.
    headers: json
      ? { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` }
      : { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${token}` },
    body: json ? JSON.stringify(body) : new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString(),
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
const KINDS = { build: "build", fix: "fix round", sync: "merge round" };

/** One board line per running dev worker: issue, kind, PR, phase, minutes, cost so far. */
export function workerLines(config, workers, now = new Date()) {
  if (!workers.length) return ["• none"];
  return workers.map((w) => {
    const mins = Math.max(0, Math.round((now - Date.parse(w.started)) / 60_000));
    const pr = w.pr ? ` · <https://github.com/${config.repo}/pull/${w.pr}|PR #${w.pr}>` : "";
    const cost = Number(w.cost) ? ` · $${Number(w.cost).toFixed(2)}` : "";
    const title = w.title ? ` · ${esc(String(w.title).slice(0, 50))}` : "";
    return `• <https://github.com/${config.repo}/issues/${w.issue}|#${w.issue}> ${KINDS[w.kind] ?? w.kind ?? "job"}${pr} · ${esc(w.phase ?? "running")} · ${mins}m${cost}${title}`;
  });
}

export function renderBoard(config, cols, now = new Date(), workers = []) {
  const head = boardHeader(config);
  const lines = [head, `_updated ${localStamp(now.toISOString())} · GitHub labels are the truth; this copies them_`, ""];
  // Live dev workers first: what is running right now, on which issue or PR, and how far along.
  lines.push(`⚙️ *Workers* (${workers.length}/${config.parallel ?? 1}) · running now`, ...workerLines(config, workers, now), "");
  const working = new Set(workers.map((w) => w.issue));
  for (const c of COLUMNS) {
    const items = cols[c.state] ?? [];
    lines.push(`${c.icon} *${c.title}* (${items.length}) · ${c.hint}`);
    for (const i of items.slice(0, MAX_PER_COLUMN)) {
      const busy = working.has(i.number) && c.state !== "doing" ? " · ⚙️ _worker on it_" : "";
      lines.push(`• <${i.url}|#${i.number}> ${esc(i.title)}${i.machine ? ` · _${i.machine}_` : ""}${busy}`);
    }
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
  const workers = liveWorkers(root);
  // Elapsed time counts in 10-minute steps, so each tick refreshes a running worker's line.
  const hash = boardHash({ cols, workers: workers.map((w) => [w.issue, w.kind, w.pr, w.phase, Math.floor((now - Date.parse(w.started)) / 600_000)]) });
  const state = readState(root);
  const prev = state.slackBoard?.channel === channel ? state.slackBoard : null;

  // The canvas never blocks the message: it is a second window on the same labels.
  const canvas = config.slack.canvas === false ? null
    : await publishCanvas({ root, key: "board", channel, tab: false, title: `crew board · ${config.repo}`,
        markdown: () => renderBoardMarkdown(config, cols, now, workers), hash, token, fetchImpl, now, force });
  if (canvas?.action === "error") logLine(root, { action: "board-canvas", outcome: "error", detail: canvas.why });
  const withCanvas = canvas ? { canvas } : {};

  if (!force && prev?.hash === hash) return { action: "skipped", why: "board unchanged", ...withCanvas };
  const text = renderBoard(config, cols, now, workers);
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
  return { action, ts, ...withCanvas };
}

// ---- canvases ------------------------------------------------------------------------------

/** Escape the characters canvas markdown would read as formatting or links. */
const mdEsc = (s) => String(s ?? "").replace(/([\\`*_[\]#|<>~])/g, "\\$1");

/** The board as canvas markdown: the same rows as the pinned message, with real headings. */
export function renderBoardMarkdown(config, cols, now = new Date(), workers = []) {
  const gh = `https://github.com/${config.repo}`;
  const lines = [`# crew board · ${config.repo}`, `_updated ${localStamp(now.toISOString())} · GitHub labels are the truth; this copies them_`, ""];
  lines.push(`## ⚙️ Workers (${workers.length}/${config.parallel ?? 1}) · running now`);
  if (!workers.length) lines.push("- none");
  for (const w of workers) {
    const mins = Math.max(0, Math.round((now - Date.parse(w.started)) / 60_000));
    const pr = w.pr ? ` · [PR #${w.pr}](${gh}/pull/${w.pr})` : "";
    const cost = Number(w.cost) ? ` · $${Number(w.cost).toFixed(2)}` : "";
    const title = w.title ? ` · ${mdEsc(String(w.title).slice(0, 50))}` : "";
    lines.push(`- [#${w.issue}](${gh}/issues/${w.issue}) ${KINDS[w.kind] ?? w.kind ?? "job"}${pr} · ${mdEsc(w.phase ?? "running")} · ${mins}m${cost}${title}`);
  }
  lines.push("");
  const working = new Set(workers.map((w) => w.issue));
  for (const c of COLUMNS) {
    const items = cols[c.state] ?? [];
    lines.push(`## ${c.icon} ${c.title} (${items.length}) · ${c.hint}`);
    if (!items.length) lines.push("- none");
    for (const i of items.slice(0, MAX_PER_COLUMN)) {
      const busy = working.has(i.number) && c.state !== "doing" ? " · ⚙️ _worker on it_" : "";
      lines.push(`- [#${i.number}](${i.url}) ${mdEsc(i.title)}${i.machine ? ` · _${i.machine}_` : ""}${busy}`);
    }
    if (items.length > MAX_PER_COLUMN)
      lines.push(`- [and ${items.length - MAX_PER_COLUMN} more on GitHub](${gh}/issues?q=is%3Aissue+is%3Aopen+label%3A${encodeURIComponent(c.state)})`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

// A Slack refusal (scope, plan) is retried after this long; a network error retries next tick.
export const CANVAS_RETRY_MS = 6 * 3600_000;
const CANVAS_GONE = new Set(["canvas_not_found", "canvas_deleted", "file_not_found", "file_deleted", "invalid_canvas_id"]);
const doc = (markdown) => ({ type: "markdown", markdown });

/**
 * Keep one canvas in step with some markdown. `tab: false` uses the channel's own canvas (works on
 * the free plan); if someone else already made that canvas, or `tab: true`, it creates a standalone
 * canvas tabbed in the channel instead, so a hand-written channel canvas is never overwritten.
 * Never throws. State: state.slackCanvases[key] = {channel, id, hash, at, error?}.
 */
export async function publishCanvas({ root, key, channel, title, markdown, hash, tab = false, token, fetchImpl = globalThis.fetch, now = new Date(), force = false }) {
  const cur = readState(root).slackCanvases?.[key];
  const same = cur?.channel === channel ? cur : null;
  if (!force && same?.id && same.hash === hash) return { action: "skipped" };
  if (!force && same?.error && now - Date.parse(same.at) < CANVAS_RETRY_MS) return { action: "skipped", why: same.error };
  const save = (o) => {
    const st = readState(root);
    writeState(root, { ...st, slackCanvases: { ...(st.slackCanvases ?? {}), [key]: { channel, at: now.toISOString(), ...o } } });
  };
  const call = (m, b) => slackCall(m, b, { token, fetchImpl, json: true });
  const content = doc(typeof markdown === "function" ? markdown() : markdown);
  try {
    let id = same?.id ?? null;
    if (id) {
      try {
        await call("canvases.edit", { canvas_id: id, changes: [{ operation: "replace", document_content: content }] });
        save({ id, hash });
        return { action: "updated", id };
      } catch (e) {
        if (!CANVAS_GONE.has(e.code)) throw e;
        id = null;
      }
    }
    // Two watch ticks can overlap; only one may create. The claim is taken under a file lock.
    const claimed = withFileLock(root, `canvas-${key}`, () => {
      const c = readState(root).slackCanvases?.[key];
      if (c?.creating && now - Date.parse(c.creating) < 5 * 60_000) return false;
      save({ id: null, creating: now.toISOString() });
      return true;
    });
    if (!claimed) return { action: "skipped", why: "another run is creating it" };
    if (tab) {
      // A standalone canvas tabbed in the channel (paid Slack plans only).
      id = (await call("canvases.create", { title, document_content: content, channel_id: channel })).canvas_id ?? null;
      if (id) {
        try { await call("canvases.access.set", { canvas_id: id, access_level: "read", channel_ids: [channel] }); } catch { /* the tab still works */ }
      }
    } else {
      // The channel's own canvas. If one already exists crew did not make it, so it is never
      // replaced: the refusal is logged and retried later, and the owner can delete it or set
      // slack.canvas to false.
      id = (await call("conversations.canvases.create", { channel_id: channel, document_content: content })).canvas_id ?? null;
    }
    if (!id) throw new Error("slack: no canvas_id in the reply");
    save({ id, hash });
    return { action: "posted", id };
  } catch (e) {
    // A Slack refusal waits CANVAS_RETRY_MS; a network failure (no code) tries again next tick.
    save(e.code ? { id: same?.id ?? null, error: e.code } : { id: same?.id ?? null, hash: same?.hash ?? null });
    return { action: "error", why: e.message };
  }
}

/**
 * The project's own canvases (slack.canvases in crew.json): each runs a command whose stdout is
 * the canvas markdown, at most every `every_min` minutes. A failed or empty run publishes nothing,
 * so the canvas keeps its last good content. Never throws.
 */
export async function refreshCanvases({ root, config, run = realRun, env = process.env, fetchImpl = globalThis.fetch, now = new Date(), force = false, machine = thisMachine(env) }) {
  const list = config.slack?.canvases ?? [];
  const out = [];
  if (!list.length) return out;
  const token = slackToken(env);
  // One line to the project channel the first time a canvas stops refreshing, and one when it
  // recovers: the canvas itself keeps its last good content, so the alert is what says it is stale.
  const alert = async (c, failed, why = "") => {
    const runs = readState(root).slackCanvasRuns ?? {};
    if (!!runs[c.key]?.failing === failed) return;
    const st = readState(root);
    writeState(root, { ...st, slackCanvasRuns: { ...(st.slackCanvasRuns ?? {}), [c.key]: { ...(st.slackCanvasRuns?.[c.key] ?? {}), failing: failed } } });
    const text = failed ? `⚠️ The *${esc(c.title)}* canvas could not refresh and shows its last good copy: ${esc(why.slice(0, 200))}` : `✅ The *${esc(c.title)}* canvas is refreshing again`;
    try { await slackCall("chat.postMessage", { channel: config.slack.channel, text, unfurl_links: false, unfurl_media: false }, { token, fetchImpl }); } catch { /* best effort */ }
  };
  for (const c of list) {
    if (c.machine && c.machine !== machine) { out.push({ key: c.key, action: "skipped", why: `runs on ${c.machine}` }); continue; }
    const channel = c.channel ?? config.slack.channel;
    const last = readState(root).slackCanvasRuns?.[c.key];
    if (!force && last?.at && now - Date.parse(last.at) < c.every_min * 60_000) {
      out.push({ key: c.key, action: "skipped", why: "not due" });
      continue;
    }
    const st = readState(root);
    writeState(root, { ...st, slackCanvasRuns: { ...(st.slackCanvasRuns ?? {}), [c.key]: { ...(last ?? {}), at: now.toISOString() } } });
    const [cmd, ...args] = c.command;
    const exe = /[\\/]/.test(cmd) && !path.isAbsolute(cmd) ? path.resolve(root, cmd) : cmd;
    let r;
    try {
      r = run(exe, args, { cwd: root, timeoutMs: (c.timeout_sec ?? 120) * 1000 });
    } catch (e) {
      r = { ok: false, code: null, stdout: "", stderr: e.message };
    }
    const markdown = String(r.stdout ?? "").trim();
    if (!r.ok || !markdown) {
      const why = !r.ok
        ? `command failed (${r.timedOut ? "timed out" : `exit ${r.code}`}): ${String(r.stderr ?? "").trim().slice(-300)}`
        : "command printed nothing";
      logLine(root, { action: "canvas", key: c.key, outcome: "error", detail: why });
      await alert(c, true, why);
      out.push({ key: c.key, action: "error", why });
      continue;
    }
    const hash = crypto.createHash("sha256").update(markdown).digest("hex").slice(0, 16);
    const res = await publishCanvas({ root, key: c.key, channel, title: c.title, markdown, hash, tab: !c.channel, token, fetchImpl, now, force });
    if (res.action === "error") logLine(root, { action: "canvas", key: c.key, outcome: "error", detail: res.why });
    else await alert(c, false);
    out.push({ key: c.key, ...res });
  }
  return out;
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
    case "requeued": return `♻️ ${link(r.issue)} ran out of review rounds; crew closed the PR and is rebuilding it from the open findings`;
    case "escalated": return `🟡 ${link(r.issue)} is on your queue (needs-jk): reviewers still object after every automatic round`;
    case "synced": return `🔀 Brought ${link(r.issue)}'s PR up to date with main`;
    case "blocked": return `🔴 ${link(r.issue)} is stuck after ${r.rounds ?? "its"} fix round${r.rounds === 1 ? "" : "s"}; it needs you`;
    case "failed": return `⚠️ ${r.issue ? link(r.issue) : "A dev run"} failed: ${esc(String(r.why ?? "").slice(0, 200))}`;
    case "canary-failed": return /ETIMEDOUT|took over/i.test(String(r.why ?? ""))
      ? `⏳ The login check took too long (machine busy); the next run tries again`
      : `⚠️ The dev worker could not log in (${esc(String(r.why ?? "").slice(0, 120))}). Check the token: crew token set`;
    default: return null;
  }
}
