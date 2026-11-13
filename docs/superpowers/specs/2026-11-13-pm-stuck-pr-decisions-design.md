# PM decides stuck PRs (design)

## Why

Today, when reviewers keep raising findings on an agent PR, crew runs 3 fix rounds, closes the PR,
rebuilds once from the open findings, runs 3 more fix rounds, and then labels the issue `needs-jk`
(`escalate()` in `lib/dispatch.mjs`). Every stuck PR lands on JK. JK decided on 2026-11-13 that
the PM should own this step: "they are called pm for a reason, so they will review the blocked,
give direction, and decide whether to go in again, or merge."

Success: a PR that runs out of review rounds is decided by the PM within one watch tick, and JK
only hears about it in the morning brief, unless it is one of the cases below that stay his.

## What JK decided

- The PM steps in exactly where `escalate()` would label `needs-jk` today (after the last build
  attempt's rounds run out, or the issue's spend reaches `caps.issue_budget_usd`). The earlier
  automatic close-and-rebuild step stays as it is.
- The PM has two moves of its own:
  1. **Go again**: it writes direction for the dev worker; the same PR gets a new set of fix rounds.
  2. **Merge**: it writes its reason on the PR; crew merges it.
- **Option B on what the PM may merge over:** any open finding, P1 included, on its own judgement.
- **Stays with JK** (crew checks these in code, never the PM):
  - the PR touches a protected path (`protected_paths` / `protected_paths_cmd`), i.e. money code
  - the project's PR gate marked the PR `never-auto-merge` (`fb.ownerOnly`)
  - closing or scrapping an issue or PR
  - **merging a PR whose own tests or CI fail** (JK, 2026-11-13: "no"): a draft PR (crew's tests
    failed or timed out, or the work is unfinished) or any failing check on the head commit. The PM
    still runs for these, but only "again" or "owner" are allowed; the prompt says why and the
    answer check refuses "merge". Pending or missing checks count as not passing.
- The PM may also choose a third answer, **send to JK**, whenever it judges the call is not its own.

## Goals, non-goals, anti-goals

- **Goal:** stuck-after-review PRs get a PM decision instead of `needs-jk`; JK sees every PM
  decision in the next brief and on the Slack board.
- **Non-goals:** the other `needs-jk` routes stay with JK for now: infra failures, merge-conflict
  rounds running out, "dev produced no changes", a stuck draft, an unparsable gate block, a PR that
  could not be opened. They can move to the PM later as a separate change.
- **Anti-goals:**
  - the PM merging a protected-path or `never-auto-merge` PR, by any route
  - the PM and the reviewers looping without end, or spend past the hard cap
  - the PM getting GitHub write access or any tool at all: it decides, crew acts
  - text inside an issue, PR or review steering the PM into a merge crew would not otherwise allow

## Approaches

1. **crew runs the PM once at the decision point and acts on its answer (chosen).** Same headless
   pattern as `lib/pm.mjs` (no tools, JSON answer, validated, one retry). crew enforces every limit.
2. **Give the PM agent `gh` access and let it act itself.** Rejected: breaks "agents decide, crew
   acts", and a prompt injected in a PR could make it close, label or merge things.
3. **Leave `needs-jk` and let the nightly 20:00 PM triage handle it.** Rejected: stuck work waits
   up to a day, and that triage has no way to make crew go again.

## The design

### Config

New keys in `crew.json`, defaults in `lib/config.mjs`:

- `stuck: "pm" | "owner"`, default `"pm"`. `"owner"` keeps today's behaviour exactly.
  `stuck: "pm"` lets crew merge on the PM's decision **independent of `merge`**: `merge: null`
  now means "no automatic codex-clean merge", not "crew never merges". JK wants every project's PM
  to have this power, so the default is on everywhere; the changelog and README must say so loudly.
- `caps.pm_agains: 2`: how many times the PM may send one issue back.
- `caps.pm_issue_budget_usd: 30`: hard stop. Once an issue's total spend (dev + PM runs) reaches
  this, it goes to JK with no PM run. Must be >= `caps.issue_budget_usd`.

`caps.issue_budget_usd` ($15) keeps its meaning for the automatic phase. After a PM "go again",
dev runs are budgeted against `pm_issue_budget_usd` instead.

### Flow in `escalate()`

When `escalate()` would set `needs-jk` for review rounds running out:

1. If `config.stuck !== "pm"` → today's behaviour.
2. If the PR is protected-path or owner-only, or `e.cost >= pm_issue_budget_usd` → `needs-jk`,
   with the reason saying why the PM could not take it.
   When `e.pm_agains >= caps.pm_agains`, the PM still gets one last run, but only "merge" or
   "owner" are allowed (the prompt says so and the answer check refuses "again"). Worst case per
   issue: 3 PM runs.
3. Otherwise queue a **PM decision** for the issue (`e.pm_pending = true`, label stays
   `in-review`) and log `{action: "pm-queued"}`.

The PM run itself is a job kind of its own (`kind: "decide"`) so it does not run inside dispatch
planning, which holds the lock. It takes one worker slot like a fix round.

### What the PM is given (all marked untrusted data)

- issue title and body
- PR number, URL, diff stat, and the diff itself capped at ~60 KB (truncated with a note)
- every open finding (from this PR) and carried findings from the closed earlier build
- history: builds, fix rounds per build, previous PM decisions and directions on this issue, spend
- the dev worker's last summaries (from the issue's crew log)
- CI state on the head commit
- how many "go again" moves it has left, and that protected / owner-only PRs are not its call

### What the PM returns

```json
{
  "decision": "again" | "merge" | "owner",
  "reason": "plain words for JK and the PR comment, <= 600 chars",
  "direction": "again only: what the dev should do and which findings to ignore and why, <= 2000 chars",
  "owner_question": "owner only: the one thing JK must decide, <= 300 chars"
}
```

Validated like `validateStatus`; one retry on a bad answer; a second bad answer or a failed run
→ `needs-jk` with the error, which is today's behaviour.

### Acting on the answer (crew, not the PM)

- **again:** `e.pm_agains += 1`, `e.fix_rounds = 0`, `e.pm_direction = direction`. Comment on the
  PR: "PM: going again. <reason>". The next dispatch runs a fix round on the same PR straight away
  (it must not wait for new reviewer comments: the findings that triggered the decision were already
  marked handled). The fix-round prompt gains a `<pm-direction>` block after the findings, telling the
  dev that the PM's direction wins where it disagrees with a reviewer. After that, normal review
  rounds resume; if they run out again, the PM decides again.
- **merge:** crew re-checks right before merging: not protected-path, not owner-only, PR still
  open and not a draft, every check on the head green (same rule as `mergeClean`), head commit
  unchanged since the PM read it, not `CONFLICTING`. If any of these fail, no merge: the issue
  goes to `needs-jk` with the reason. Then posts
  "PM: merging over N open finding(s). <reason>" and runs
  `gh pr merge --merge --delete-branch --match-head-commit <sha>`, same as `mergeClean`. The
  existing `reconcile()` then closes the issue. If GitHub refuses (branch protection, required
  checks), the issue goes to `needs-jk` with GitHub's error.
- **owner:** `needs-jk` with the PM's `owner_question` and reason as the label reason.

### Visibility

- Every decision is a log line (`pm-again`, `pm-merged`, `pm-owner`) in the issue's crew log, so
  the morning brief picks it up through `collect.mjs`.
- Slack event lines for the three outcomes next to `requeued` / `escalated` in `lib/slack.mjs`.
- PM run cost is added to the issue and the day like any run.

### Rules and docs that change

- `agents/pm.md`: the PM is still read-only, but it now decides stuck PRs; add the decision prompt
  rules (judge findings on merit, merge only when the PR does what the issue asked and the open
  findings are wrong, minor or out of scope; say when the call is JK's).
- `skills/rules/SKILL.md`: "agents never merge" becomes "agents never merge; crew merges on the
  PM's decision or `codex-clean`". PM row gains "decides stuck PRs".
- `README.md`: the stuck-PR flow, the new config keys.
- Version bump in `package.json` and changelog line, as with earlier releases.

## Calls I made (JK to check)

- **Closing/scrapping stays with JK.** JK did not say either way.
- When "again" moves are used up and the PR is also a draft or red, the PM's only answer is
  "owner", so crew skips the PM run and sends it to JK directly.
- Limits: 2 "go again" per issue, $30 per issue total. `stuck` defaults to `"pm"` for every repo.
- The PM sees the diff only through the prompt (no file tools), same as the brief run today.

## Left to the builder

- Exact prompt wording for the decision run, diff truncation, how the dev summaries are pulled.
- How the `decide` job fits the existing slot / worker / heartbeat code.
- Test layout (follow `test/` patterns for `escalate`, `mergeClean`, `pm.mjs`).
- Migration: issues already on `needs-jk` stay there; nothing is re-routed retroactively.
