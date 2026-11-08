// Deliver files to GitHub: as a PR on a crew/* branch, or as a commit on the default branch.
// Works in a throwaway worktree, so the owner's checkout is never touched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run as realRun } from "./exec.mjs";
import { gh } from "./gh.mjs";

function git(run, args, cwd) {
  const r = run("git", args, { cwd, timeoutMs: 120_000 });
  if (!r.ok) throw new Error(`git ${args[0]} failed: ${String(r.stderr || r.stdout).trim().split("\n")[0]}`);
  return r.stdout;
}

/**
 * @param {{root, config, files: {rel:string, text:string}[], branch:string, title:string, body:string, mode:"pr"|"commit", run?}} o
 * @returns {{url:string|null, branch:string, changed:boolean}}
 */
export function deliverFiles({ root, config, files, branch, title, body, mode = "pr", run = realRun }) {
  const base = config.default_branch;
  git(run, ["fetch", "--quiet", "origin", base], root);
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "crew-deliver-"));
  fs.rmSync(wt, { recursive: true, force: true }); // git wants to create it
  const local = mode === "pr" ? branch : `crew/tmp-${Date.now()}`;
  git(run, ["worktree", "add", "--quiet", "-B", local, wt, `origin/${base}`], root);
  try {
    for (const f of files) {
      const p = path.join(wt, ...f.rel.split("/"));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, f.text, "utf8");
    }
    git(run, ["add", "--", ...files.map((f) => f.rel)], wt);
    const staged = run("git", ["diff", "--cached", "--quiet"], { cwd: wt });
    if (staged.ok) return { url: null, branch, changed: false }; // nothing changed
    git(run, ["commit", "--quiet", "-m", title], wt);
    if (mode === "commit") {
      git(run, ["push", "--quiet", "origin", `HEAD:refs/heads/${base}`], wt);
      return { url: null, branch: base, changed: true };
    }
    git(run, ["push", "--quiet", "--force", "origin", `HEAD:refs/heads/${branch}`], wt);
    const existing = JSON.parse(gh(run, ["pr", "list", "--repo", config.repo, "--head", branch, "--state", "open", "--json", "url"]) || "[]");
    if (existing.length) return { url: existing[0].url, branch, changed: true };
    const url = gh(run, ["pr", "create", "--repo", config.repo, "--base", base, "--head", branch, "--title", title, "--body-file", "-"], { input: body }).trim().split("\n").pop();
    return { url, branch, changed: true };
  } finally {
    run("git", ["worktree", "remove", "--force", wt], { cwd: root });
    run("git", ["branch", "-D", local], { cwd: root });
  }
}
