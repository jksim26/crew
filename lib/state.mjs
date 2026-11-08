// Machine-local run state under <repo>/.crew/: the ledger (costs, attempts), the lock, the lease, the log.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const crewDir = (root) => path.join(root, ".crew");

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

// ---- ledger -------------------------------------------------------------------------------
export const ledgerFile = (root) => path.join(crewDir(root), "ledger.json");

export function loadLedger(root) {
  const l = readJson(ledgerFile(root), {});
  return { days: l.days ?? {}, issues: l.issues ?? {} };
}
export const saveLedger = (root, l) => writeJson(ledgerFile(root), l);

export const dayKey = (now) => now.toISOString().slice(0, 10);

export function issueEntry(ledger, n) {
  return (ledger.issues[n] ??= { cost: 0, attempts: 0, fix_rounds: 0, branch: null, pr: null, last_push_at: null, review_keys: [] });
}

export function charge(ledger, n, cost, now) {
  const d = dayKey(now);
  ledger.days[d] = round((ledger.days[d] ?? 0) + cost);
  const e = issueEntry(ledger, n);
  e.cost = round(e.cost + cost);
}
const round = (x) => Math.round(x * 10000) / 10000;

// ---- lock ---------------------------------------------------------------------------------
const lockFile = (root) => path.join(crewDir(root), "dispatch.lock");

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** Take the lock or return null. A lock whose process is gone, or older than staleMs, is broken. */
export function acquireLock(root, { staleMs, now = Date.now() } = {}) {
  const file = lockFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date(now).toISOString() }));
      fs.closeSync(fd);
      return () => fs.rmSync(file, { force: true });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const cur = readJson(file, {});
      const age = now - Date.parse(cur.at ?? 0);
      const sameHost = cur.host === os.hostname();
      if ((sameHost && cur.pid && !alive(cur.pid)) || (staleMs && age > staleMs)) {
        fs.rmSync(file, { force: true });
        continue;
      }
      return null;
    }
  }
  return null;
}

// ---- lease (an interactive session asks the dispatcher to stay away) ----------------------
const leaseFile = (root) => path.join(crewDir(root), "lease");
export const LEASE_MS = 2 * 3600_000;

export function leaseHeld(root, now = Date.now()) {
  try {
    const st = fs.statSync(leaseFile(root));
    return now - st.mtimeMs < LEASE_MS;
  } catch {
    return false;
  }
}
export function takeLease(root, note = "") {
  fs.mkdirSync(crewDir(root), { recursive: true });
  fs.writeFileSync(leaseFile(root), `${new Date().toISOString()} ${note}\n`, "utf8");
}
export function releaseLease(root) {
  fs.rmSync(leaseFile(root), { force: true });
}

// ---- log ----------------------------------------------------------------------------------
export function logLine(root, entry) {
  fs.mkdirSync(crewDir(root), { recursive: true });
  fs.appendFileSync(path.join(crewDir(root), "dispatch.log"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf8");
}
