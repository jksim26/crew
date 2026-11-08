# crew: build plan

**Status (2026-11-08, v0.2.0): phases 1-7 built.** Phase 8 (first adoption) and Phase 9 (messenger) are next.

Revised 2026-11-08 after [research/team-setups-2026-11-08.md](research/team-setups-2026-11-08.md).
This is a global "AI team" template, packaged as a Claude Code plugin. Its first adopter is a private project
(Phase 8). Each phase ships alone and waits for JK's go-ahead.

## Fixed decisions

| Topic | Decision |
|---|---|
| Packaging | Plugin + self-hosted marketplace in this repo. Installed per user on the Mac, then the PC. |
| Roles in the template | `pm` (reads only, writes the brief), `dev` (headless worker), `implementer` (dev's subagent) |
| Roles per project | Each project's own interactive roles (e.g. trade, ops) |
| Queue | GitHub issues. Labels `ready` / `doing` / `in-review` / `blocked` / `needs-jk`. |
| Reviewer | Codex: `@codex review` only, advisory, never an approval |
| Messenger | Grok reads `STATUS.md` + brief link once a day. Nothing else. |
| PM cadence | Daily brief, plus a Sunday week in review where decisions are asked |
| Runtime | Node ≥ 20, zero npm dependencies, plus `gh` and `claude`. No bash, so one script runs on macOS and Windows. |
| Billing | Claude subscription via `CLAUDE_CODE_OAUTH_TOKEN`; `ANTHROPIC_API_KEY` is always removed; never `--bare` |
| GitHub plan | Free. Project repos stay private: no branch protection or native auto-merge, so the guards live on the machine. Template repo public. |
| Where agents run | On JK's machines (launchd / Task Scheduler), never on GitHub Actions |

## Per-project config: `.claude/crew.json`

The project owns its policy and state; the plugin owns the machinery.

```json
{
  "repo": "owner/name",
  "owner_login": "your-login",
  "default_branch": "main",
  "agent_branch_prefix": "agent/",
  "protected_paths": ["src/payments/*", "..."],
  "protected_paths_cmd": null,
  "test_cmd": "...",
  "wip_cap": 2,
  "caps": { "max_turns": 60, "max_budget_usd": 5, "wall_min": 40, "idle_min": 10,
            "issue_budget_usd": 15, "issue_attempts": 2, "fix_rounds": 3, "daily_budget_usd": 25 },
  "brief": { "sources": ["wiki/log.md"], "deliver": "pr" },
  "roles": ["trade", "ops"]
}
```

Notes on the fields:

- **`protected_paths`** are the files a human must approve (e.g. payment or risk code).
  **`protected_paths_cmd`** lets a project run its own checker instead.
- **What protected paths trigger:** a hit in a dev PR makes it a draft labelled `needs-jk`. The
  dispatcher never refuses to *read* those files.
- **What happens to a brief** (`brief.deliver`):
  - `pr`: opens a markdown-only `crew/brief-<date>` PR
  - `local`: writes the files only
  - `commit`: for repos whose owner allows it

## Phases

### Phase 1: plugin skeleton and project config

- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`. The marketplace points at
  `./`, so `claude plugin marketplace add ~/code/crew` works locally before publishing.
- `skills/rules/SKILL.md`: the shared rules. A plugin's `CLAUDE.md` is not loaded, so they go
  in a skill:
  - sessions close
  - handoffs go through issues
  - the PM never builds
  - agents never merge
- `bin/crew.mjs`: one CLI with subcommands. Phase 1 ships `crew init` and `crew doctor`.
  - **`crew init`** writes `.claude/crew.json` from questions, or from flags.
  - **`crew doctor`** checks: Node version, `gh` auth and scopes, `claude` version, OAuth token
    present, `ANTHROPIC_API_KEY` absent, a valid config, and a repo that is reachable and matches
    `repo`.
- `lib/config.mjs`: load and validate `crew.json`, with clear errors.
- `test/`: `node --test`, fixtures only, no network.
- **Done:**
  - `claude plugin validate --strict` passes
  - the plugin installs from the local marketplace
  - `crew doctor` runs against a real project, reading only
  - tests are green

### Phase 2: PM brief

- **`agents/pm.md`:** `tools: Read, Grep, Glob`, no Edit, Write or Bash. The model never touches
  git or GitHub.
- **`crew brief [--weekly] [--out DIR] [--dry-run]`:**
  1. **Collect, with no model.** Merged and open PRs since the last brief, issues by label, review
     comments, `git log`, and the configured sources. Output: `collect.json`.
  2. **Skip** if nothing has changed since the last brief. The model is never woken just to say "no
     news".
  3. **Run the PM:** `claude -p --agent pm --output-format json --max-turns 30` on `collect.json`.
     It returns strict JSON (`status.json`). The schema is validated, with one retry, then it fails
     loudly.
  4. **Render** `STATUS.md` (5 fixed lines: AS OF · DELIVERED · REVIEW · BLOCKED/DECIDE · NEXT/COST)
     and `docs/briefs/<date>.md` (the five brief sections, written as prose to JK) from that JSON.
  5. **Deliver** as `brief.deliver` says. `--dry-run` writes to `--out` only.
- **`commands/brief.md`** (`/brief`): the same collect step plus an interactive answer, for "brief
  me" or "why is X blocked".
- **Done:** one weekly-mode brief generated for a real project with `--dry-run --out` to a temp
  folder. **JK reads it and approves the tone** before anything is scheduled.

**Built (2026-11-08):**

- **Already in place:** `crew collect`, `crew brief`, `agents/pm.md` and `/crew:brief`.
- **Headless PM:** it runs with **no tools** (`--tools ""`) and works only from the collected data.
  The prompt goes in on stdin, to avoid the Windows argument-length limit. `--strict-mcp-config`
  keeps MCP warnings off stdout.
- **Delivery:** `pr` and `commit` delivery move to Phase 3, next to the queue's GitHub-write code.
  `local` and `--dry-run` work now.
- **First dry run on a real project:** a weekly brief in about 50 s, $0.41 at list price.

### Phase 3: queue on GitHub issues (+ brief `pr` delivery)

- `crew queue labels` creates the label set, idempotently.
- `crew queue next` returns the top eligible issue:
  - It must carry the `ready` label, applied **by `owner_login`**. Checked through the issue timeline
    API.
  - Order: oldest first, or by a `priority:N` label.
- `crew queue set <n> <state>` moves an issue between states and comments the reason.
- **Prompt hygiene:** HTML comments and hidden markdown are stripped from the issue body before
  it goes into any prompt.
- `crew queue import <checklist.md>` is a generic helper. Each unchecked `- [ ]` item becomes an
  issue with its body copied verbatim. Shown first with `--dry-run`.
- **Done:** tests, plus a live run against a throwaway public test repo.

### Phase 4: dev dispatcher

`agents/dev.md` (headless, decides and briefs `implementer`) plus `crew dispatch`.

**Plain checks, all before any model call; a failure exits with a log line:**

- Lock file free, and no interactive session holds the repo lease.
- Under the daily budget.
- Fewer than `wip_cap` open `agent/*` PRs.
- A `ready` issue exists.
- The per-issue attempt and budget ledger still allows another try.

**Then:**

1. Run the canary (`claude -p "ok"` with a 1-turn cap). On failure: stop and alert.
2. Fresh worktree off `origin/<default_branch>`. Install a `pre-push` hook there that refuses any
   push to `default_branch`.
3. Run `claude -p --agent dev --max-turns N --max-budget-usd B --output-format json
   --permission-prompts none --allowedTools …`, under these rules:
   - **Environment:** `ANTHROPIC_API_KEY` removed and `CLAUDE_CODE_OAUTH_TOKEN` set.
   - **Deny rules:** `git push * main`, `gh pr merge`, `gh api` writes to settings.
   - **Stopping:** wall-clock and idle watchdog. SIGINT first, SIGTERM after 30 s.
4. **After the run:**
   - Check the result JSON as well as the exit code.
   - Check the diff against `protected_paths`. On a hit: draft PR and `needs-jk`.
   - Comment `@codex review` on the PR, and nothing else.
   - Record cost and attempts in `.crew/ledger.json`.
   - Append to `PROGRESS.md` and, if there is a lesson, `LEARNINGS.md`.
   - Regenerate `STATUS.md`.
   - Remove the worktree and release the lock. This step always runs.
5. **Fix rounds:** one, for new Codex findings on the same issue. After that the issue goes to
   `blocked`, with a "what JK must do" comment.

Idempotent per (issue, head SHA). Checks are read for the head SHA only. Log:
`.crew/dispatch.log`.

- **Builder identity:** the PRs are opened by the builder account. Decision pending: a separate
  machine account, or JK's own.
- **Done:** tests with a fake `claude` binary (timeout, auth failure, cap hit, protected-path hit).
  Then one real run on the throwaway test repo.

### Phase 5: session hygiene

- **`/handoff`** (`commands/handoff.md`):
  1. write open questions and decisions to the role's memory file
  2. open `ready`-candidate issues as **drafts**, labelled `needs-jk`, never `ready`
  3. compact and exit
- **`rules`:** sessions open, work, close; "a session that can't do a task files an issue and
  says so in one line".

### Phase 6: schedulers

- **`crew schedule install`:**
  - **macOS:** generates a launchd plist under `~/Library/LaunchAgents`. It sets
    `CLAUDE_CODE_OAUTH_TOKEN` from the local secret file, never from the repo.
  - **Windows:** generates and registers a Task Scheduler task with S4U, Limited, `IgnoreNew` and
    an explicit `ExecutionTimeLimit` (the default is 72 h).
- `crew schedule status` and `crew schedule remove`.
- **Done:** the scheduled job fires on the Mac with the session logged out, and is shown to work.

### Phase 7: publish

- Public GitHub repo `crew`, with JK's approval. Its CI runs `plugin validate --strict` and
  `node --test`.
- Version pinned in `plugin.json`. Every release bumps it, and the CI fails if it hasn't.
- Install on the Mac and the PC from the GitHub marketplace. Record the plugin version and the
  Claude Code version in every run log.

### Phase 8: first adoption

The first project adopts crew on its own branch: its `.claude/crew.json` (protected paths, roles,
log sources), migration of its existing task list with `crew queue import`, retiring any older
agent routine it replaces, and its schedules. The adoption notes are kept with that project.

### Phase 9: Grok

- One daily Grok routine. It reads `STATUS.md` and the latest brief link from each adopted repo
  through the GitHub connector, then sends one message.
- **Private repos:** the connector needs read access to them.

## Still open (JK)

1. Template repo public on GitHub? This matters at Phase 7. Recommendation: yes.
2. Builder identity: a separate free GitHub machine account, or JK's account? This matters at
   Phase 4. Recommendation: a machine account, because then the builder's token can never merge.
