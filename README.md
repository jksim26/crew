# crew

A Claude Code plugin that gives a repo a small AI team. Sessions open, do one job, and close; the
team's memory lives in files and GitHub, not in long-running chats.

| Who | What they do |
|---|---|
| **PM** (reads only) | Writes a daily brief in plain language plus a 5-line `STATUS.md`; a Sunday week in review |
| **Dev** (headless) | Takes one `ready` GitHub issue, builds it in a throwaway worktree, commits locally, exits |
| **Dispatcher** (a plain script) | Decides if there is work, runs dev under hard caps, pushes `agent/*`, opens the PR |
| **Codex** | Reviews PRs; one automatic fix round, then the issue is `blocked` for you |
| **You** | Mark issues `ready`, merge PRs, make the calls the brief asks for |
| **Messenger** (e.g. a Grok routine) | Reads `STATUS.md` once a day and tells you |

Built for GitHub Free and a Claude subscription:

- **Runs on your own machines:** macOS launchd or Windows Task Scheduler, not GitHub Actions.
- **Bills your subscription, never an API key:** `ANTHROPIC_API_KEY` is always removed from agent
  runs.
- **Guards the default branch locally:** private repos on Free have no branch protection, so the
  guard lives on your machine.

## Install

```bash
claude plugin marketplace add jksim26/crew
claude plugin install crew@crew
```

The `crew` command is on the PATH inside Claude Code sessions. In a terminal or scheduler, run
`node <plugin-dir>/bin/crew` (Windows: `bin\crew.cmd`). Needs Node 20+, `gh`, `git` and `claude`.
There are no npm dependencies. On Windows, use the native `claude.exe`.

## Set up a project

```bash
crew init --roles trade,ops --protected "src/payments/*" --test-cmd "npm test"
echo ".crew/" >> .gitignore          # run state: ledger, lock, logs
crew doctor                           # read-only checks; exit 1 on any failure
crew queue labels                     # ready / doing / in-review / blocked / needs-jk
```

For scheduled runs, store a long-lived subscription token outside any repo:

- Create the token with `claude setup-token`.
- macOS: save it to `~/.config/crew/secrets.json` as `{"CLAUDE_CODE_OAUTH_TOKEN": "..."}` and set
  `chmod 600`.
- Windows: save the same file at `%APPDATA%\crew\secrets.json`.

## Daily use

| You want | Run |
|---|---|
| A brief now | `/crew:brief` in a session, or `crew brief` |
| The week in review | `crew brief --weekly` |
| Try a brief without touching the repo | `crew brief --weekly --dry-run --out /tmp/brief` |
| Something built | Open an issue, then label it `ready` yourself (only your label counts) |
| See what dev would take next | `crew queue next` |
| One dev run now | `crew dispatch` (or `--dry-run`) |
| Keep dev away while you work | `crew lease on` … `crew lease off` |
| Close a session cleanly | `/crew:handoff` |
| Import an existing checklist | `crew queue import backlog.md --section "Queue" --dry-run` |

## Schedule it

```bash
crew schedule install brief --at 19:00
crew schedule install brief-weekly --at 18:00 --weekday 0
crew schedule install dispatch --every 60
crew schedule status
crew schedule remove dispatch
```

- **macOS:** a launchd user agent in `~/Library/LaunchAgents`.
- **Windows:** a Task Scheduler task under `\crew\`, using S4U, Limited, `IgnoreNew` and an
  explicit execution limit.
- **Logs:** `.crew/logs/<job>.log`.
- **Preview first:** `--print` shows the file without installing it.

## What one `crew dispatch` run does

1. **Plain checks, with no model call:** the lock, your lease, the daily budget, the WIP cap
   (open `agent/*` PRs), and the queue.
2. **Fix rounds first:** if Codex left new findings on an agent PR since the last push, dev gets one
   fix round. A second set of findings moves the issue to `blocked`.
3. **Otherwise the next issue:** the oldest `ready` issue (or the lowest `priority:N`) whose `ready`
   label was applied by `owner_login`.
4. **Login check:** a canary call confirms the Claude login works.
5. **The dev run:** in a fresh worktree off `origin/<default>`:
   - Caps: `--max-turns`, `--max-budget-usd`, a wall-clock limit and an idle limit (SIGINT, then
     SIGTERM).
   - The agent can edit, test and `git commit`. It cannot push, run `gh`, use curl, or fetch the
     web.
   - A `pre-push` hook refuses anything outside `agent/*`.
6. **After the run, the dispatcher:**
   - appends to `PROGRESS.md` and `LEARNINGS.md`
   - checks the diff against the protected paths
   - pushes the branch and opens the PR. It's a draft if a protected path changed, the tests
     failed, the work is partial, or the run hit a cap.
   - comments `@codex review`
   - labels the issue `in-review`
7. **Bookkeeping:** cost and attempts go to `.crew/ledger.json`. Per-issue budgets and attempts
   carry across restarts.

## Project config: `.claude/crew.json`

```json
{
  "repo": "owner/name",
  "owner_login": "your-github-login",
  "default_branch": "main",
  "agent_branch_prefix": "agent/",
  "protected_paths": ["src/payments/*"],
  "protected_paths_cmd": null,
  "test_cmd": "npm test",
  "wip_cap": 2,
  "caps": { "max_turns": 60, "max_budget_usd": 5, "wall_min": 40, "idle_min": 10,
            "issue_budget_usd": 15, "issue_attempts": 2, "daily_budget_usd": 25 },
  "brief": { "sources": ["docs/log.md"], "deliver": "pr" },
  "roles": ["trade", { "name": "ops", "memory": "docs/roles/ops.md" }]
}
```

- **Caps:** they must be positive. `0` is refused rather than read as "unlimited". Unknown keys are
  reported as typos.
- **`protected_paths`:** globs where `*` spans directories. **`protected_paths_cmd`** replaces
  them: it gets the changed files on stdin and prints the ones that are protected.
- **`brief.deliver`:**
  - `pr` opens a `crew/brief-<date>` PR
  - `local` writes the files only
  - `commit` pushes straight to the default branch
- **Role memory files:** the default is `docs/handoff/<role>.md`.

## Develop

```bash
npm test                         # node --test, no dependencies
claude plugin validate --strict .
```

Background: [docs/research/](docs/research/) covers how others run agent teams and what we copied.
[docs/plan.md](docs/plan.md) is the build plan. MIT licensed.
