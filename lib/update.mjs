// `crew update`: keep this machine's crew current. Scheduled jobs and the Claude plugin both run from a
// runner-only clone (never a folder people work in) that an hourly job moves forward to origin/main:
// at a safe moment, after the new version passed its own tests, with rollback and one Slack line per
// change. See docs/superpowers/specs/2026-11-14-auto-update-design.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJson, writeJson } from "./state.mjs";
import { readLocal, saveLocal } from "./secrets.mjs";

export const AUTO_UPDATE_KEY = "CREW_AUTO_UPDATE";
const MARKER_MS = 5 * 60_000;

/** Machine-local home for the runner clone and its state: local app data, never roaming or synced. */
export function updateHome(env = process.env, platform = process.platform) {
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "crew");
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "crew");
}
export const runnerDir = (env = process.env, platform = process.platform) => path.join(updateHome(env, platform), "runtime");
const stateFile = (env, platform) => path.join(updateHome(env, platform), "update.json");
const markerFile = (env, platform) => path.join(updateHome(env, platform), "updating");

const DEFAULT_STATE = Object.freeze({ current: null, previous: null, bad: [], last_check: null, last_result: null, temp_failures: 0, plugin_pending: false });

export function readUpdateState(env = process.env, platform = process.platform) {
  const s = readJson(stateFile(env, platform), {});
  return { ...DEFAULT_STATE, ...s, bad: Array.isArray(s.bad) ? s.bad : [] };
}
export function writeUpdateState(state, env = process.env, platform = process.platform) {
  writeJson(stateFile(env, platform), { ...DEFAULT_STATE, ...state });
}

/** On unless this machine said `crew update off`. */
export const autoUpdateOn = (env = process.env, platform = process.platform) => readLocal(AUTO_UPDATE_KEY, env, platform) !== "off";
export function setAutoUpdate(on, { env = process.env, platform = process.platform } = {}) {
  saveLocal(AUTO_UPDATE_KEY, on ? "on" : "off", { env, platform });
}

/** While the runner clone is being switched, watch and dispatch skip their tick (at most 5 minutes). */
export function markUpdating(env = process.env, platform = process.platform, now = new Date()) {
  fs.mkdirSync(updateHome(env, platform), { recursive: true });
  fs.writeFileSync(markerFile(env, platform), now.toISOString(), "utf8");
}
export function clearUpdating(env = process.env, platform = process.platform) {
  fs.rmSync(markerFile(env, platform), { force: true });
}
export function updatingNow(env = process.env, platform = process.platform, now = Date.now()) {
  try {
    const at = Date.parse(fs.readFileSync(markerFile(env, platform), "utf8").trim());
    return now - at < MARKER_MS && now >= at - MARKER_MS;
  } catch {
    return false;
  }
}
