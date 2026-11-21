// Optional bridge to a lucid-dream memory server (https://github.com/jksim26/lucid-dream). Off unless
// crew.json has "lucid_dream": the project works the same without it.
// The server address and token are machine-local: LUCID_URL (e.g. http://pc:7878/mcp) and LUCID_TOKEN,
// from the environment or crew's secrets file (secrets.mjs), never from the repo.
import { readLocal } from "./secrets.mjs";
import { logLine } from "./state.mjs";

export const LUCID_URL_KEY = "LUCID_URL";
export const LUCID_TOKEN_KEY = "LUCID_TOKEN";
const TIMEOUT_MS = 15_000;
const MAX_NOTE = 2000;

/** Call one lucid-dream MCP tool and return its text. Throws with a message that never holds the token. */
export async function lucidCall(tool, args, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const url = readLocal(LUCID_URL_KEY, env);
  const token = readLocal(LUCID_TOKEN_KEY, env);
  if (!url || !token) throw new Error(`no lucid-dream server: set ${LUCID_URL_KEY} and ${LUCID_TOKEN_KEY} (environment or crew's secrets file)`);
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401) throw new Error("lucid-dream refused the token");
  if (!res.ok) throw new Error(`lucid-dream answered ${res.status}`);
  const reply = await res.json().catch(() => null);
  if (!reply) throw new Error("lucid-dream sent a reply crew cannot read");
  if (reply.error?.message) throw new Error(reply.error.message);
  const text = reply.result?.content?.[0]?.text ?? "";
  if (reply.result?.isError) throw new Error(text || "lucid-dream reported an error");
  return text;
}

/**
 * Save one note to shared memory when `lucid_dream.remember` is on. Never throws: memory is a
 * convenience, and a dead server must not fail a dev run or a handoff.
 * @returns {Promise<{ok:boolean, skipped?:boolean, why?:string}>}
 */
export async function remember({ root = null, config, text, topic = null, origin = null, saidBy = null, env = process.env, fetchImpl = globalThis.fetch }) {
  if (!config.lucid_dream?.remember) return { ok: false, skipped: true, why: `"lucid_dream.remember" is off in crew.json` };
  const note = String(text ?? "").trim().slice(0, MAX_NOTE);
  if (!note) return { ok: false, skipped: true, why: "nothing to save" };
  const args = { text: note };
  if (topic) args.topic = topic;
  if (origin) args.origin = origin;
  if (saidBy) args.said_by = saidBy;
  try {
    await lucidCall("remember", args, { env, fetchImpl });
    return { ok: true };
  } catch (e) {
    if (root) logLine(root, { action: "lucid-remember", outcome: "error", detail: e.message });
    return { ok: false, why: e.message };
  }
}
