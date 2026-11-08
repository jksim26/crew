// The Slack command bridge: the owner (or a messenger bot posting as the owner, e.g. Grok Bot) writes
// `crew <command>` in the project channel; `crew watch` on the central machine reads it and replies in
// the thread. No inbound port, no tunnel, no model call to read it.
//   - only messages from slack.commanders (Slack user IDs) count; everything else is ignored
//   - only the commands below run, each mapped to a fixed crew argv (nothing is passed to a shell)
//   - `ready` is never set from here: approving work stays a GitHub action by the owner
import { run as realRun } from "./exec.mjs";
import { slackCall, slackToken } from "./slack.mjs";
import { readState, writeState } from "./brief.mjs";
import { CREW_BIN } from "./schedule.mjs";
import { parseKeyValues } from "./project.mjs";
import { logLine } from "./state.mjs";

const SAFE_VALUE = /^[A-Za-z0-9._\/:\\ -]{1,200}$/;

/** Text of a Slack message -> crew argv, or {error}, or null when it is not a crew command. */
export function parseCommand(text) {
  const t = String(text ?? "").replace(/<@[A-Z0-9]+>/g, "").replace(/&amp;/g, "&").replace(/[`*_]/g, "").trim();
  const m = /^crew\s+(.+)$/i.exec(t);
  if (!m) return null;
  const words = m[1].trim().split(/\s+/);
  const head = words[0].toLowerCase();
  switch (head) {
    case "help": return { help: true };
    case "brief": return { argv: words[1]?.toLowerCase() === "weekly" ? ["brief", "--weekly", "--force"] : ["brief", "--force"] };
    case "review": return { argv: ["review"] };
    case "board": return { argv: ["board", "--force"] };
    case "next": return { argv: ["queue", "next"] };
    case "doctor": return { argv: ["doctor"] };
    case "queue": return words[1]?.toLowerCase() === "next" ? { argv: ["queue", "next"] } : { error: "only `crew queue next` is allowed from Slack" };
    case "project": {
      if (words[1]?.toLowerCase() !== "add") return { error: "usage: crew project add repo=owner/name channel=C0123 [dir=X:\\Claude\\Name] [roles=a,b] [test-cmd=...]" };
      const kv = parseKeyValues(words.slice(2));
      if (!kv.repo) return { error: "crew project add needs repo=owner/name" };
      const argv = ["project", "add", "--repo", kv.repo];
      const map = { channel: "slack-channel", "slack-channel": "slack-channel", dir: "dir", roles: "roles", "test-cmd": "test-cmd" };
      for (const [k, flag] of Object.entries(map)) if (kv[k] !== undefined) argv.push(`--${flag}`, kv[k]);
      for (let i = 2; i < argv.length; i += 2) if (!SAFE_VALUE.test(argv[i + 1] ?? "")) return { error: `value for ${argv[i]} has characters crew will not pass on` };
      return { argv };
    }
    default: return { error: `unknown command "${head}". Try: crew help` };
  }
}

export const HELP_TEXT = [
  "*crew commands* (run on the central machine, reply in this thread):",
  "• `crew brief` / `crew brief weekly` – write the brief now",
  "• `crew review` – run the self-review now (plan PR + proposals)",
  "• `crew board` – refresh the pinned board",
  "• `crew next` – what the dev worker takes next",
  "• `crew doctor` – health check",
  "• `crew project add repo=owner/name channel=C0123 [dir=...] [roles=a,b] [test-cmd=...]` – set up a new project here",
  "Approving work stays on GitHub: label an issue `ready`.",
].join("\n");

/**
 * Read new commands from the channel, run each, reply in its thread.
 * @returns {Promise<{ran:number, skipped?:string}>}
 */
export async function runCommands({ root, config, env = process.env, run = realRun, fetchImpl = globalThis.fetch, now = new Date(), node = process.execPath, bin = CREW_BIN }) {
  const who = config.slack?.commanders ?? [];
  if (!who.length) return { ran: 0, skipped: "no slack.commanders" };
  const token = slackToken(env);
  const call = (m, b) => slackCall(m, b, { token, fetchImpl });
  const channel = config.slack.channel;
  const state = readState(root);
  const last = state.slackCommands?.channel === channel ? state.slackCommands.ts : null;
  const save = (ts) => writeState(root, { ...readState(root), slackCommands: { channel, ts } });

  if (!last) {
    // First run: start from now, so old messages in the channel are never replayed.
    save(String(now.getTime() / 1000));
    return { ran: 0, skipped: "first run: listening from now on" };
  }
  const hist = await call("conversations.history", { channel, oldest: last, limit: 50 });
  const msgs = (hist.messages ?? []).filter((m) => !m.thread_ts || m.thread_ts === m.ts).sort((a, b) => Number(a.ts) - Number(b.ts));
  let ran = 0;
  for (const msg of msgs) {
    save(msg.ts); // move past it first: a command that crashes is never re-run in a loop
    if (msg.bot_id || !who.includes(msg.user)) continue;
    const cmd = parseCommand(msg.text);
    if (!cmd) continue;
    let reply;
    if (cmd.help) reply = HELP_TEXT;
    else if (cmd.error) reply = `⚠️ ${cmd.error}`;
    else {
      const r = run(node, [bin, ...cmd.argv], { cwd: root, env, timeoutMs: (config.caps.wall_min + 5) * 60_000 });
      const out = `${r.stdout ?? ""}${r.stderr ? `\n${r.stderr}` : ""}`.trim() || "(no output)";
      reply = `${r.ok ? "✅" : "⚠️"} \`crew ${cmd.argv.join(" ")}\`\n\`\`\`\n${out.slice(-2500)}\n\`\`\``;
      logLine(root, { action: "slack-command", command: cmd.argv.join(" "), ok: r.ok });
    }
    await call("chat.postMessage", { channel, thread_ts: msg.ts, text: reply, unfurl_links: false });
    ran++;
  }
  return { ran };
}
