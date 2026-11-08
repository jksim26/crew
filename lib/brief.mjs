// `crew brief`: collect -> skip if unchanged -> PM -> render -> deliver.
import fs from "node:fs";
import path from "node:path";
import { run as realRun } from "./exec.mjs";
import { collect } from "./collect.mjs";
import { runPM } from "./pm.mjs";
import { renderBrief, renderStatus } from "./render.mjs";
import { deliverFiles } from "./deliver.mjs";

export const STATE_REL = path.join(".crew", "state.json");

export function readState(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, STATE_REL), "utf8"));
  } catch {
    return {};
  }
}

export function writeState(root, state) {
  const file = path.join(root, STATE_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

/**
 * @returns {{skipped:boolean, reason?:string, briefFile?:string, statusFile?:string, cost?:number, attempts?:number}}
 */
export function runBrief({ root, config, mode = "daily", dryRun = false, out = null, force = false, now = new Date(), run = realRun, env = process.env, deliver = deliverFiles }) {
  if (dryRun && !out) throw new Error("--dry-run needs --out <dir>");

  const state = readState(root);
  const data = collect({ root, config, mode, now, lastBriefAt: state.lastBrief?.at ?? null, run });

  if (!force && mode === "daily" && state.lastBrief?.fingerprint === data.fingerprint)
    return { skipped: true, reason: "nothing changed since the last brief" };

  const { status, cost, attempts } = runPM({ data, mode, cwd: root, run, env });

  const date = data.generated_at.slice(0, 10);
  const briefRel = path.posix.join("docs", "briefs", `${date}${mode === "weekly" ? "-weekly" : ""}.md`);
  const briefText = renderBrief({ data, status, mode });
  const statusText = renderStatus({ data, status, briefRel, cost });
  const remote = !dryRun && config.brief.deliver !== "local";
  const base = dryRun ? path.resolve(out) : root;
  let briefFile = path.join(base, ...briefRel.split("/"));
  let statusFile = path.join(base, "STATUS.md");
  let url = null;
  if (remote) {
    const d = deliver({
      root, config, run, mode: config.brief.deliver,
      files: [{ rel: briefRel, text: briefText }, { rel: "STATUS.md", text: statusText }],
      branch: `crew/brief-${date}${mode === "weekly" ? "-weekly" : ""}`,
      title: `crew: ${mode === "weekly" ? "week in review" : "brief"} ${date}`,
      body: `${status.headline}\n\nWritten by the crew PM from repo activity since ${data.since}. Only \`${briefRel}\` and \`STATUS.md\` change.`,
    });
    url = d.url;
    briefFile = d.url ?? `${config.repo}@${d.branch}:${briefRel}`;
    statusFile = `${config.repo}@${d.branch}:STATUS.md`;
  } else {
    write(briefFile, briefText);
    write(statusFile, statusText);
  }

  // Audit trail: exactly what the PM saw and said.
  const auditDir = dryRun ? path.join(base, ".crew") : path.join(root, ".crew", "briefs");
  write(path.join(auditDir, `${date}-${mode}.collect.json`), JSON.stringify(data, null, 2) + "\n");
  write(path.join(auditDir, `${date}-${mode}.status.json`), JSON.stringify({ status, cost, attempts }, null, 2) + "\n");

  if (!dryRun) writeState(root, { ...state, lastBrief: { at: data.generated_at, fingerprint: data.fingerprint, mode, file: briefRel } });
  return { skipped: false, briefFile, statusFile, cost, attempts, url, status };
}
