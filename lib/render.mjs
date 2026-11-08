// Turn collected data + the PM's status object into STATUS.md and the brief. Deterministic.

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
/** STATUS.md is read by bots and phones: drop markdown links to their text. */
export const plain = (s) => oneLine(s).replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

/** Open, non-draft PRs are the owner's review queue, oldest first. */
export function reviewQueue(data) {
  return data.open_prs.filter((p) => !p.draft).sort((a, b) => b.age_days - a.age_days);
}

export function localStamp(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ` +
    `UTC${sign}${pad(Math.floor(Math.abs(off) / 60))}${Math.abs(off) % 60 ? ":" + pad(Math.abs(off) % 60) : ""}`;
}

export function renderStatus({ data, status, briefRel, cost }) {
  const q = reviewQueue(data);
  const drafts = data.open_prs.filter((p) => p.draft).length;
  const review = q.length
    ? `${q.length} PR${q.length > 1 ? "s" : ""} waiting on you, oldest #${q[0].number} (${q[0].age_days}d)`
    : "nothing waiting on you";
  const top = status.decisions[0]?.question;
  return [
    `AS OF: ${localStamp(data.generated_at)} · ${data.repo} · brief: ${briefRel}`,
    `DELIVERED: ${plain(status.status_delivered)}`,
    `REVIEW: ${review}${drafts ? ` · ${drafts} draft${drafts > 1 ? "s" : ""}` : ""}`,
    `BLOCKED/DECIDE: ${status.blocked.length} blocked, ${status.decisions.length} decision${status.decisions.length === 1 ? "" : "s"}${top ? ` · ${plain(top)}` : ""}`,
    `NEXT: ${plain(status.status_next)} · brief ≈$${cost.toFixed(2)} API-equiv. (subscription)`,
  ].join("\n") + "\n";
}

export function renderBrief({ data, status, mode }) {
  const date = data.generated_at.slice(0, 10);
  const out = [];
  out.push(mode === "weekly" ? `# Week in review · ${date}` : `# Brief · ${date}`, "");
  out.push(`*${data.repo} · since ${localStamp(data.since)} · written by the crew PM*`, "");
  out.push(status.headline.trim(), "");
  out.push("## What happened", "", status.what_happened.trim(), "");
  if (mode === "weekly" && status.week_in_review) out.push("## The week", "", status.week_in_review.trim(), "");

  out.push("## Blocked", "");
  if (!status.blocked.length) out.push("Nothing is blocked.", "");
  else {
    for (const b of status.blocked) out.push(`- **${oneLine(b.what)}**: ${oneLine(b.why)} To unblock: ${oneLine(b.unblock)}`);
    out.push("");
  }

  out.push("## Decisions for you", "");
  if (!status.decisions.length) out.push("None today.", "");
  else {
    status.decisions.forEach((d, i) =>
      out.push(`${i + 1}. **${oneLine(d.question)}**`, `   My recommendation: ${oneLine(d.recommendation)}`, `   Cost of waiting: ${oneLine(d.cost_of_waiting)}`));
    out.push("");
  }

  out.push("## Next", "", status.next.trim(), "");
  out.push("## The number", "", `**${oneLine(status.number.label)}: ${oneLine(status.number.value)}**. ${oneLine(status.number.why)}`, "");

  const q = reviewQueue(data);
  if (q.length) {
    out.push("## Your review queue", "", "| PR | Age | Review |", "|---|---|---|");
    for (const p of q.slice(0, 10))
      out.push(`| [#${p.number} ${p.title.replace(/\|/g, "\\|")}](${p.url}) | ${p.age_days}d | ${p.review_decision ? p.review_decision.toLowerCase().replace(/_/g, " ") : "none yet"} |`);
    out.push("");
  }
  if (data.errors.length) out.push("<details><summary>Data the PM could not see</summary>", "", ...data.errors.map((e) => `- ${e}`), "", "</details>", "");
  return out.join("\n");
}
