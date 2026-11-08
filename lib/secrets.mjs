// Where the machine-local secrets live (never in a repo). Values are never printed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function secretsPath(env = process.env, platform = process.platform) {
  if (platform === "win32") {
    const base = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "crew", "secrets.json");
  }
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "crew", "secrets.json");
}

/** Returns {present, file, source, looseMode} for CLAUDE_CODE_OAUTH_TOKEN without exposing it. */
export function oauthTokenStatus(env = process.env, platform = process.platform) {
  const file = secretsPath(env, platform);
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { present: true, file, source: "environment", looseMode: false };
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return { present: false, file, source: null, looseMode: false };
  }
  let present = false;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    present = typeof data.CLAUDE_CODE_OAUTH_TOKEN === "string" && data.CLAUDE_CODE_OAUTH_TOKEN.length > 20;
  } catch {
    present = false;
  }
  const looseMode = platform !== "win32" && (st.mode & 0o077) !== 0;
  return { present, file, source: present ? "secrets file" : null, looseMode };
}

/** The token value for a child process environment, or null. Never logged. */
export function readOAuthToken(env = process.env, platform = process.platform) {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    const data = JSON.parse(fs.readFileSync(secretsPath(env, platform), "utf8"));
    return typeof data.CLAUDE_CODE_OAUTH_TOKEN === "string" && data.CLAUDE_CODE_OAUTH_TOKEN ? data.CLAUDE_CODE_OAUTH_TOKEN : null;
  } catch {
    return null;
  }
}

/** Any value from the machine-local secrets file (env var of the same name wins), or null. */
export function readLocal(key, env = process.env, platform = process.platform) {
  if (env[key]) return env[key];
  try {
    const v = JSON.parse(fs.readFileSync(secretsPath(env, platform), "utf8"))[key];
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

/** Write one key to the machine-local secrets file, readable only by this user. Returns the file. */
export function saveLocal(key, value, { env = process.env, platform = process.platform } = {}) {
  const file = secretsPath(env, platform);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { /* new file */ }
  data[key] = value;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  if (platform !== "win32") fs.chmodSync(file, 0o600);
  return file;
}
