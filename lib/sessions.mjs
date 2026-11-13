// Interactive Claude Code sessions in a crew repo, recorded by the plugin's hooks (hooks/hooks.json ->
// `crew session-hook <event>`). One file per session under the main checkout's .crew/sessions/, so
// `crew sessions`, the Slack board and the dispatch overlap guard can see what is open on this
// machine and which files it has edited. Crew's own headless runs carry CREW_AGENT=1 and are skipped.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mainCheckout } from "./config.mjs";
import { crewDir, readJson, writeJson, withFileLock } from "./state.mjs";
import { thisMachine } from "./machine.mjs";

export const DEFAULT_QUIET_MIN = 120;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export const sessionsDir = (root) => path.join(crewDir(root), "sessions");
const sessionFile = (root, id) => path.join(sessionsDir(root), `${id}.json`);

/** The folder holding .claude/crew.json at or above `cwd` (a repo or one of its worktrees), or null. */
function crewFolder(cwd) {
  let dir = path.resolve(String(cwd ?? ""));
  for (;;) {
    if (fs.existsSync(path.join(dir, ".claude", "crew.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The main checkout of the crew repo at or above `cwd`, or null when `cwd` is not in one. */
export function findCrewRoot(cwd) {
  const dir = crewFolder(cwd);
  return dir ? mainCheckout(dir) : null;
}

/** `file` relative to `top` with / separators, or null when it lies outside `top`. */
function repoPath(top, file) {
  const tryRel = (a, b) => {
    const rel = path.relative(a, b);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : null;
  };
  const abs = path.resolve(top, String(file));
  const direct = tryRel(top, abs);
  if (direct) return direct;
  try { return tryRel(fs.realpathSync(top), fs.realpathSync(abs)); } catch { return null; }
}

/**
 * Apply one hook event to the session's file.
 * @returns {{root: string|null, id: string|null, action: "skip"|"written"|"deleted"}}
 */
export function recordSessionEvent({ event, input, env = process.env, now = new Date() }) {
  const skip = { root: null, id: null, action: "skip" };
  if (env.CREW_AGENT === "1") return skip;
  const top = crewFolder(input?.cwd);
  if (!top) return skip;
  const root = mainCheckout(top);
  const id = String(input?.session_id ?? "");
  if (!ID_RE.test(id)) return { ...skip, root };
  const file = sessionFile(root, id);
  if (event === "SessionEnd") {
    fs.rmSync(file, { force: true });
    return { root, id, action: "deleted" };
  }
  withFileLock(root, `session-${id}`, () => {
    const at = now.toISOString();
    const cur = readJson(file, null);
    const s = cur ?? { id, host: os.hostname(), machine: thisMachine(env), cwd: input.cwd, worktree: top === root ? null : top, started: at, updated: at, files: [] };
    s.updated = at;
    if (event === "PostToolUse") {
      const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
      const rel = target ? repoPath(top, target) : null;
      if (rel && !s.files.includes(rel)) s.files.push(rel);
    }
    writeJson(file, s);
  }, { waitMs: 3000 });
  return { root, id, action: "written" };
}

/** This host's sessions active within `quietMin`; this host's quieter files are deleted. */
export function liveSessions(root, { now = Date.now(), quietMin = DEFAULT_QUIET_MIN } = {}) {
  let names = [];
  try { names = fs.readdirSync(sessionsDir(root)).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const f of names) {
    const s = readJson(path.join(sessionsDir(root), f), null);
    if (!s || s.host !== os.hostname()) continue;
    if (!(now - Date.parse(s.updated) < quietMin * 60_000)) {
      fs.rmSync(path.join(sessionsDir(root), f), { force: true });
      continue;
    }
    out.push({ ...s, files: Array.isArray(s.files) ? s.files : [] });
  }
  return out.sort((a, b) => Date.parse(a.started) - Date.parse(b.started));
}

/** Delete one session's file, or all of this host's when `id` is null. Returns how many went. */
export function clearSessions(root, id = null) {
  if (id != null) {
    const file = sessionFile(root, String(id));
    if (!ID_RE.test(String(id)) || !fs.existsSync(file)) return 0;
    fs.rmSync(file, { force: true });
    return 1;
  }
  let n = 0;
  let names = [];
  try { names = fs.readdirSync(sessionsDir(root)).filter((f) => f.endsWith(".json")); } catch { return 0; }
  for (const f of names) {
    const s = readJson(path.join(sessionsDir(root), f), null);
    if (s && s.host !== os.hostname()) continue;
    fs.rmSync(path.join(sessionsDir(root), f), { force: true });
    n++;
  }
  return n;
}
