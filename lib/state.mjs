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

// Several tick processes run workers at once, each holding its own copy of the ledger. A save merges:
// only the issues this copy changed since it was loaded (or last saved) are written, and day costs are
// added as deltas, so one worker never overwrites another's bookkeeping.
const snapshots = new WeakMap();
const snap = (l) => ({ days: { ...l.days }, issues: Object.fromEntries(Object.entries(l.issues).map(([k, v]) => [k, JSON.stringify(v)])) });

export function loadLedger(root) {
  const raw = readJson(ledgerFile(root), {});
  const l = { days: raw.days ?? {}, issues: raw.issues ?? {} };
  snapshots.set(l, snap(l));
  return l;
}

export function saveLedger(root, l) {
  const base = snapshots.get(l);
  if (!base) return writeJson(ledgerFile(root), l); // a ledger built by hand: plain overwrite
  withFileLock(root, "ledger", () => {
    const raw = readJson(ledgerFile(root), {});
    const disk = { days: raw.days ?? {}, issues: raw.issues ?? {} };
    for (const [k, v] of Object.entries(l.issues)) if (base.issues[k] !== JSON.stringify(v)) disk.issues[k] = v;
    for (const [d, v] of Object.entries(l.days)) {
      const delta = v - (base.days[d] ?? 0);
      if (delta) disk.days[d] = round((disk.days[d] ?? 0) + delta);
    }
    writeJson(ledgerFile(root), disk);
    // Pick up issues other workers added and the day totals, and remember this as the new base. Our own
    // entry objects are never replaced: a running job holds a reference to its entry.
    for (const [k, v] of Object.entries(disk.issues)) if (!(k in l.issues)) l.issues[k] = v;
    l.days = { ...disk.days };
    snapshots.set(l, snap(l));
  });
}

/** A short cross-process lock (mkdir is atomic everywhere). Stale after 30 s. */
export function withFileLock(root, name, fn, { staleMs = 30_000, waitMs = 20_000 } = {}) {
  const dir = path.join(crewDir(root), `${name}.lock.d`);
  fs.mkdirSync(crewDir(root), { recursive: true });
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let age = 0;
      try { age = Date.now() - fs.statSync(dir).mtimeMs; } catch { continue; }
      if (age > staleMs) { fs.rmSync(dir, { recursive: true, force: true }); continue; }
      if (Date.now() > until) throw new Error(`timed out waiting for the ${name} lock`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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

// ---- workers (one file per running job: what the board shows, and what keeps two runs apart) ----
export const workersDir = (root) => path.join(crewDir(root), "workers");
const workerFile = (root, n) => path.join(workersDir(root), `${n}.json`);

/** Live workers on this machine; files left by a dead process are removed. */
export function liveWorkers(root, isAlive = alive) {
  let names = [];
  try { names = fs.readdirSync(workersDir(root)).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const f of names) {
    const w = readJson(path.join(workersDir(root), f), null);
    if (!w) continue;
    if (w.host === os.hostname() && w.pid && !isAlive(w.pid)) { fs.rmSync(path.join(workersDir(root), f), { force: true }); continue; }
    out.push(w);
  }
  return out.sort((a, b) => Date.parse(a.started) - Date.parse(b.started));
}

export function beginWorker(root, n, info, now = new Date()) {
  writeJson(workerFile(root, n), { issue: n, pid: process.pid, host: os.hostname(), started: now.toISOString(), updated: now.toISOString(), phase: "starting", ...info });
}
export function beatWorker(root, n, patch) {
  const cur = readJson(workerFile(root, n), null);
  if (cur) writeJson(workerFile(root, n), { ...cur, ...patch, updated: new Date().toISOString() });
}
export function endWorker(root, n) {
  fs.rmSync(workerFile(root, n), { force: true });
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
