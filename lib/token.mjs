// `crew token set`: save the long-lived subscription token (from `claude setup-token`) to the
// machine-local secrets file, without the token ever being echoed, logged or typed into a command.
// macOS: a hidden-input dialog. Windows: PowerShell Read-Host -AsSecureString. Else: a hidden TTY prompt.
import { run as realRun } from "./exec.mjs";
import { saveLocal } from "./secrets.mjs";

const PREFIX = "sk-ant-oat";

export function validToken(t) {
  return typeof t === "string" && t.startsWith(PREFIX) && t.length > 40 && !/\s/.test(t);
}

/** Ask for the token without echoing it. Returns the trimmed string, or null when cancelled. */
export async function promptToken({ label = "Claude token (starts with sk-ant-oat)", platform = process.platform, run = realRun, stdin = process.stdin, stderr = process.stderr } = {}) {
  if (platform === "darwin") {
    const script = 'text returned of (display dialog "Paste your " & lbl & ", then click Save." default answer "" with hidden answer with title "crew: save a token" buttons {"Cancel", "Save"} default button "Save")';
    const r = run("osascript", ["-e", `set lbl to ${JSON.stringify(label)}`, "-e", script], { timeoutMs: 10 * 60_000 });
    return r.ok ? r.stdout.replace(/\s+/g, "") : null;
  }
  if (platform === "win32") {
    const ps = "$s = Read-Host -AsSecureString '" + `Paste your ${label}`.replace(/'/g, "''") + "'; " +
      "$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); " +
      "try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }";
    const r = run("powershell", ["-NoProfile", "-Command", ps], { timeoutMs: 10 * 60_000 });
    return r.ok ? r.stdout.replace(/\s+/g, "") : null;
  }
  if (!stdin.isTTY) return null;
  return await new Promise((resolve) => {
    stderr.write(`Paste your ${label} (input hidden), then Enter: `);
    let buf = "";
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (d) => {
      for (const ch of d.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return finish(buf);
        if (ch === "\u0003") return finish(null);
        if (ch === "\u007f") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    const finish = (v) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stderr.write("\n");
      resolve(v === null ? null : v.replace(/\s+/g, ""));
    };
    stdin.on("data", onData);
  });
}

/** Write {CLAUDE_CODE_OAUTH_TOKEN} to the secrets file, readable only by this user. */
export function saveToken(token, { env = process.env, platform = process.platform } = {}) {
  if (!validToken(token)) throw new Error(`that does not look like a subscription token (should start with ${PREFIX}); nothing saved`);
  return saveLocal("CLAUDE_CODE_OAUTH_TOKEN", token, { env, platform });
}

/** A Slack bot token (xoxb-...), from a Slack app installed to your workspace. */
export function validSlackToken(t) {
  return typeof t === "string" && /^xoxb-[A-Za-z0-9-]{20,}$/.test(t);
}

export function saveSlackToken(token, { env = process.env, platform = process.platform } = {}) {
  if (!validSlackToken(token)) throw new Error("that does not look like a Slack bot token (should start with xoxb-); nothing saved");
  return saveLocal("CREW_SLACK_TOKEN", token, { env, platform });
}
