// Overlap guard: a new build never starts on files another open agent PR (or running build) already
// changes, and never before the issues it depends on are closed. The waiting build starts on a later
// tick from the merged default branch, so it needs no conflict round. No model is involved.
//
// A PR holds its files until it merges or closes, not just while a worker runs on it: a build started
// while the other PR waits for review would still start from the old file.

/** Files every PR touches with an established merge policy; they never make two jobs overlap. */
export const OVERLAP_EXEMPT = ["PROGRESS.md", "LEARNINGS.md", "crew-log/", "wiki/log.md"];

const PATH_RE = /(?:^|[\s`'"(\[<])((?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,8})(?=[\s`'")\]>:,;.!?]|$)/g;
const WRITES_RE = /^\s*(?:[-*]\s*)?\**writes\**\s*:\s*(.+)$/gim;
const DEPENDS_RE = /\b(?:depends[\s_-]+on|blocked[\s_-]+by)\s*:?\s*((?:#\d+(?:\s*(?:,|and|&)?\s*)?)+)/gi;

/**
 * The files an issue says it will change. A `Writes:` line (comma or space separated) is the
 * explicit scope and wins; otherwise every repo-relative path cited in the body. This is an estimate:
 * an issue that names no file predicts nothing, and the dispatcher logs that it ran unguarded.
 */
export function predictFiles(body) {
  const text = String(body ?? "");
  const explicit = [...text.matchAll(WRITES_RE)].flatMap((m) => m[1].split(/[\s,]+/)).map(clean).filter(Boolean);
  if (explicit.length) return [...new Set(explicit)];
  return [...new Set([...text.matchAll(PATH_RE)].map((m) => clean(m[1])).filter(Boolean))];
}

function clean(p) {
  const s = String(p).replace(/^[`'"(<\[]+|[`'")>\],;:.]+$/g, "").replace(/:\d+(?:-\d+)?$/, "").replace(/^\.\//, "").replace(/\\/g, "/");
  return /\//.test(s) || /\.[A-Za-z0-9]{1,8}$/.test(s) ? s : null;
}

/** Issue numbers this issue waits for (`Depends on #12, #13`, `blocked by #9`). */
export function dependsOn(body) {
  const out = new Set();
  for (const m of String(body ?? "").matchAll(DEPENDS_RE)) for (const n of m[1].matchAll(/#(\d+)/g)) out.add(Number(n[1]));
  return [...out];
}

export function isExempt(file, extra = []) {
  return [...OVERLAP_EXEMPT, ...extra].some((x) => (x.endsWith("/") ? file.startsWith(x) || file.includes(`/${x}`) : file === x));
}

/**
 * The first holder whose files intersect `files` (exempt files ignored), or null.
 * holders: [{ label, issue, files }]. A holder for the same issue (its own older PR) never blocks it.
 */
export function overlapWith(files, holders, { issue = null, exempt = [] } = {}) {
  const mine = new Set(files.filter((f) => !isExempt(f, exempt)));
  if (!mine.size) return null;
  for (const h of holders) {
    if (issue != null && h.issue === issue) continue;
    const hit = (h.files ?? []).filter((f) => mine.has(f));
    if (hit.length) return { ...h, hit };
  }
  return null;
}
