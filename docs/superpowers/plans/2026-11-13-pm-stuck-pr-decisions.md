# PM Decides Stuck PRs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an agent PR runs out of review rounds, crew runs the PM once and acts on its answer (go again with direction, merge, or send to JK) instead of labelling `needs-jk`.

**Architecture:** `escalate()` in `lib/dispatch.mjs` queues a PM decision (`e.pm_pending`) instead of `needs-jk` when allowed. The next dispatch plans a `decide` job that runs the PM headless and async (new `lib/decide.mjs`, same `claude -p` pattern as `lib/pm.mjs`, no tools, JSON answer). crew enforces every limit in code and does the GitHub actions itself.

**Tech Stack:** Node >= 20 ESM, `node:test`, `gh` CLI, `claude -p`.

**Spec:** `docs/superpowers/specs/2026-11-13-pm-stuck-pr-decisions-design.md`

## Global Constraints

- `stuck: "pm" | "owner"`, default `"pm"`. `"owner"` = today's behaviour, byte for byte.
- `caps.pm_agains: 2`, `caps.pm_issue_budget_usd: 30` (must be >= `caps.issue_budget_usd`).
- The PM never merges: protected-path PRs, PR-gate `never-auto-merge` PRs, drafts, PRs with any check not SUCCESS/SKIPPED/NEUTRAL (pending or none counts as not passing). Checked in crew code, not in the prompt only.
- The PM never closes issues or PRs.
- PM run: no tools (`--tools ""`), `--max-turns 3`, `--max-budget-usd 2`, all GitHub text inside `<data>` marked untrusted.
- Merge command: `gh pr merge <n> --repo <repo> --merge --delete-branch --match-head-commit <sha>` (same as `mergeClean`).
- PR comments start with `PM: `. No em dashes in any user-facing text.
- Version 0.9.0 in `package.json` and `.claude-plugin/plugin.json`.

## Review Focus

- PR head moves between the PM reading it and crew merging: merge must be refused (`--match-head-commit` and a re-view), issue goes to `needs-jk`. Test in Task 4.
- PM answers "merge" for a draft or red-CI PR (prompt ignored): crew refuses and sends to `needs-jk`. Test in Task 4.
- Issue on `needs-jk` or relabelled by JK while `pm_pending` is set: the decide job must skip it. Test in Task 3.
- `stuck: "owner"` repo: no PM run, no new ledger fields touched. Test in Task 3.
- PM run fails twice (timeout, bad JSON, auth): issue goes to `needs-jk` with the error, `pm_pending` cleared, cost still charged. Test in Task 4.

---

### Task 1: Config keys

**Files:**
- Modify: `lib/config.mjs` (DEFAULTS, TOP_KEYS, validation near line 177-205)
- Test: `test/config.test.mjs`

**Interfaces:**
- Produces: `config.stuck` (`"pm"|"owner"`), `config.caps.pm_agains` (int), `config.caps.pm_issue_budget_usd` (number).

- [ ] **Step 1: Write failing test** `"stuck and PM caps: defaults, validation"`: `normalize({repo:"a/b", owner_login:"x"})` gives `stuck === "pm"`, `caps.pm_agains === 2`, `caps.pm_issue_budget_usd === 30`; validation reports a problem for `stuck: "boss"`, for `caps.pm_agains: 1.5`, and for `caps: {issue_budget_usd: 20, pm_issue_budget_usd: 10}`.
- [ ] **Step 2: Run** `node --test test/config.test.mjs`; expect FAIL.
- [ ] **Step 3: Implement.** Add `stuck: "pm"` to DEFAULTS and TOP_KEYS; add the two caps; add `pm_agains` to the integer-cap list; error text `"stuck" must be "pm" (the PM decides stuck PRs) or "owner" (they go to needs-jk)` and `"caps.pm_issue_budget_usd" must not be below "caps.issue_budget_usd"`.
- [ ] **Step 4: Run** `node --test test/config.test.mjs`; expect PASS.
- [ ] **Step 5: Commit** `config: stuck and PM caps`.

### Task 2: PM decision runner (`lib/decide.mjs`)

**Files:**
- Create: `lib/decide.mjs`
- Reuses from `lib/pm.mjs` (already exported, no change): `readAgentFile`, `extractJson`, `claudeEnv`, `HEADLESS_ARGS`, `PM_AGENT_FILE`
- Test: `test/decide.test.mjs`

**Interfaces:**
- Produces:
  - `DECISION_SCHEMA_TEXT: string`
  - `buildDecisionPrompt(data: object, allowed: string[], problems?: string[]|null): string`
  - `validateDecision(o: object, allowed: string[]): string[]` (problems; empty = ok)
  - `async runDecision({ data, allowed, cwd, runStream, env, agentFile? }): Promise<{ decision: {decision, reason, direction?, owner_question?}, cost: number }>`; throws `Error` with `.cost` after 2 bad answers or a failed run.
- `allowed` is a subset of `["again","merge","owner"]`; `"owner"` is always included.

- [ ] **Step 1: Write failing tests:**
  - `validateDecision` accepts `{decision:"merge", reason:"r"}` with allowed `["again","merge","owner"]`; refuses `"merge"` when allowed is `["again","owner"]` (problem mentions `not allowed`); requires `direction` for `"again"` (<= 2000 chars), `owner_question` for `"owner"` (<= 300), `reason` always (<= 600).
  - `buildDecisionPrompt` contains every allowed decision name, does not list a refused one as an option, contains `<data>` and the word `untrusted`, and includes `problems` when given.
  - `runDecision` with a fake `runStream` returning `{code:0, stdout: JSON.stringify({type:"result", subtype:"success", is_error:false, result: JSON.stringify({decision:"again", reason:"r", direction:"d"}), total_cost_usd:0.3})}` resolves with that decision and `cost 0.3`; args include `--tools` `""` and `--max-budget-usd` `2`; first answer invalid then valid = 2 calls, cost summed; two invalid answers reject with `err.cost` set.
- [ ] **Step 2: Run** `node --test test/decide.test.mjs`; expect FAIL.
- [ ] **Step 3: Implement.** Same agent-file and args construction as `callClaude` in `lib/pm.mjs`, but via `runStream(cmd, args, {cwd, env: claudeEnv(env), input, wallMs: 10*60_000, idleMs: 10*60_000})` so it does not block other workers. Prompt rules (wording is the builder's): judge findings on merit; "merge" only when the PR does what the issue asked and the open findings are wrong, minor or out of scope; "again" direction must say which findings to fix and which to ignore and why; "owner" when the call is a product, money or scope decision; when only some moves are allowed, say why (no go-agains left / tests or CI failing).
- [ ] **Step 4: Run** `node --test test/decide.test.mjs`; expect PASS.
- [ ] **Step 5: Commit** `decide: headless PM decision runner`.

### Task 3: Route stuck PRs to the PM

**Files:**
- Modify: `lib/dispatch.mjs` (`escalate` ~708, fix-round planning ~473-511, job planning/execution ~590-612)
- Test: `test/dispatch.test.mjs`

**Interfaces:**
- Consumes: Task 1 config.
- Produces:
  - `escalate({ root, config, ledger, run, n, pr, findings, p })` where `p` is the PR object from the `open` list (fields `isDraft, statusCheckRollup, files, headRefOid`).
  - `mergeAllowed(config, p, run): string|null` exported: `null` when the PM may merge, else the reason (`"draft"`, `"checks not green"`, `"protected path: <files>"`).
  - Ledger fields on the issue entry: `pm_pending: {pr, findings, allowed}` | null, `pm_agains: number`, `pm_direction: string|null`, `pm_fix: findings[]|null`.
  - Job `{kind: "decide", issue, pr: p, branch, fix: null, sync: null}`.

- [ ] **Step 1: Write failing tests** (extend the `world()` fake; `claude` calls stay the canary):
  - `"stuck pm: rounds run out on the last attempt -> PM decision queued, not needs-jk"`: ledger `{attempts:2, fix_rounds:3, cost:5}`, a new P1 review → result action `"pm-queued"`; no `--add-label needs-jk` call; `ledger.issues[1].pm_pending.pr === 12`; `allowed` deep-equals `["again","merge","owner"]` for a green, non-draft PR with `statusCheckRollup:[{conclusion:"SUCCESS"}]`.
  - same with `isDraft:true` → `allowed` `["again","owner"]`; with `pm_agains:2` and green → `["merge","owner"]`; with `pm_agains:2` and draft → action `"escalated"`, needs-jk, no `pm_pending`.
  - `e.cost >= 30` → `"escalated"`, reason mentions `$30`.
  - protected file in `p.files` (`lib/secret/x`) → `allowed` excludes `"merge"`.
  - `stuck: "owner"` config → exactly today's `"escalated"` path; entry has no `pm_pending` key.
  - next dispatch with `pm_pending` set → one job of kind `decide` (assert via `runStream` call whose args contain `--tools`), no fix round; an issue in the `needs-jk` list with `pm_pending` → no decide job.
  - `issue_budget_usd` cap no longer escalates mid-PM-phase: entry `{pm_agains:1, cost:16}` with a new finding and `fix_rounds:0` → fix round runs (budget cap is `pm_issue_budget_usd` once `pm_agains > 0`).
- [ ] **Step 2: Run** `node --test test/dispatch.test.mjs`; expect the new tests FAIL.
- [ ] **Step 3: Implement.**
  - `mergeAllowed`: draft → `"draft"`; any check conclusion/state not in SUCCESS/SKIPPED/NEUTRAL, or zero checks → `"checks not green"`; `protectedHits` non-empty → `"protected path: …"`.
  - `escalate`: keep the requeue branch unchanged. In the `needs-jk` branch, when `config.stuck === "pm"`: cost >= `pm_issue_budget_usd` → needs-jk (reason names the cap); compute `allowed` = `again` if `pm_agains < caps.pm_agains`, `merge` if `mergeAllowed` is null, always `owner`; if allowed is only `["owner"]` → needs-jk with the reasons; else set `pm_pending`, save, return `done(root, {action:"pm-queued", issue:n, pr})`.
  - Fix-round planning: the budget check uses `e.pm_agains ? caps.pm_issue_budget_usd : caps.issue_budget_usd`; the `fix_rounds` cap check is unchanged. Before reading feedback, an entry with `pm_pending` (not in ownerQueue, not busy) becomes a `decide` job; an entry with `pm_fix` becomes a fix job with `fix: e.pm_fix` even when there are no fresh findings.
  - `work()`: the per-run budget line uses the same cap switch.
- [ ] **Step 4: Run** `node --test`; expect all PASS.
- [ ] **Step 5: Commit** `dispatch: queue a PM decision when review rounds run out`.

### Task 4: Run the decision and act on it

**Files:**
- Modify: `lib/dispatch.mjs` (new `decideJob`, wired where jobs run; `buildTaskPrompt`)
- Test: `test/dispatch.test.mjs`

**Interfaces:**
- Consumes: `runDecision` (Task 2), `mergeAllowed`, ledger fields (Task 3).
- Produces: `async decideJob({ root, config, run, runStream, env, now, ledger, n, p }): Promise<logEntry>` with `action` one of `"pm-again" | "pm-merged" | "pm-owner" | "failed"`; `buildTaskPrompt({..., pmDirection})` adds a `<pm-direction>` block.

- [ ] **Step 1: Write failing tests** (`runStream` fake returns the decision JSON when `args` include `--tools`):
  - again: comment on PR 12 starting `PM: going again.`; ledger `pm_agains` +1, `fix_rounds` 0, `pm_direction` set, `pm_fix` = pending findings, `pm_pending` null; next dispatch runs a fix round whose prompt matches `/<pm-direction>[\s\S]*<\/pm-direction>/` and says the PM's direction wins over a reviewer; after that round `pm_fix` is null.
  - merge on a green PR: re-views the PR, comments `PM: merging over 1 open finding(s).`, calls `gh pr merge 12 --repo jk/proj --merge --delete-branch --match-head-commit sha12`, action `"pm-merged"`.
  - merge but re-view shows a new `headRefOid` → no merge call, needs-jk, reason mentions `changed`.
  - merge returned while `allowed` lacked it (draft) → no merge call, needs-jk (validation already refuses; this asserts crew's re-check via `mergeAllowed` too).
  - merge refused by GitHub (`gh pr merge` returns `ok:false`, stderr `required status check`) → needs-jk with that error.
  - owner: needs-jk, reason contains `owner_question`.
  - run fails twice → needs-jk with the error; `pm_pending` null; cost charged to issue and day.
  - every outcome charges the PM cost via `charge(ledger, n, cost, now)` and appends a line to the issue's crew log.
- [ ] **Step 2: Run** `node --test test/dispatch.test.mjs`; expect FAIL.
- [ ] **Step 3: Implement `decideJob`.** Data passed to the PM: issue title/body, PR number/url, `gh pr diff <n>` capped at 60_000 chars (note when cut), diff stat from `p.files`, `pm_pending.findings`, `e.carry`, `{builds, attempts, fix_rounds, pm_agains, cost}`, prior `pm_direction`, last 3 dev summaries from the issue's crew log, check states, moves left. Wrap in try/finally that clears `pm_pending` and saves the ledger. Wire `decide` jobs into the same `beginWorker` / `Promise.all` path as other jobs.
- [ ] **Step 4: Run** `node --test`; expect all PASS.
- [ ] **Step 5: Commit** `dispatch: act on the PM's decision`.

### Task 5: Slack lines, rules, docs, version

**Files:**
- Modify: `lib/slack.mjs` (`dispatchNews` ~494), `agents/pm.md`, `skills/rules/SKILL.md`, `README.md` (role table line 11, stuck flow ~269, config ~313), `package.json`, `.claude-plugin/plugin.json`
- Test: `test/slack-watch.test.mjs`

- [ ] **Step 1: Write failing test**: `dispatchNews` renders `pm-queued` ("the PM is deciding"), `pm-again` (contains "PM sent"), `pm-merged` (contains "PM merged"), `pm-owner` (contains "needs-jk").
- [ ] **Step 2: Run** `node --test test/slack-watch.test.mjs`; expect FAIL.
- [ ] **Step 3: Implement** the four cases next to `requeued`/`escalated`. Docs: `agents/pm.md` keeps "reads only, never acts" but adds a "Deciding a stuck PR" section (what it may decide, what is JK's); rules skill: "Agents never merge; crew merges on the PM's decision or `codex-clean`", PM row adds "decides stuck PRs"; README: new flow, `stuck` and the two caps, and a loud note that `stuck: "pm"` (the default) lets crew merge even when `merge` is null. Bump both versions to 0.9.0.
- [ ] **Step 4: Run** `node --test`; expect all PASS.
- [ ] **Step 5: Commit** `PM decides stuck PRs (0.9.0)`.
