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
| **Slack** (optional) | A pinned board per project (ready / doing / in review / blocked / waiting for you) plus short news lines; any bot, e.g. Grok, can read it |

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

For scheduled runs, save a long-lived **subscription** token (not an API key) outside any repo:

```bash
claude setup-token      # prints a token starting sk-ant-oat, valid one year
crew token set          # hidden prompt (macOS dialog / Windows secure prompt); tests it with one tiny call
```

It lands in `~/.config/crew/secrets.json` (Windows: `%APPDATA%\crew\secrets.json`), readable only
by you. Costs crew prints (for example "≈$0.42 API-equiv.") are what the run would cost at API list
price; with this token they count against your plan's usage limits and nothing is billed per token.

## Daily use

| You want | Run |
|---|---|
| A brief now | `/crew:brief` in a session, or `crew brief` |
| The week in review | `crew brief --weekly` |
| Try a brief without touching the repo | `crew brief --weekly --dry-run --out /tmp/brief` |
| Something built | Open an issue, then label it `ready` yourself (only your label counts) |
| See what dev would take next | `crew queue next` |
| One dev run now | `crew dispatch` (or `--dry-run`) |
| Refresh the Slack board now | `crew board` |
| Name this machine | `crew machine set pc` |
| Keep dev away while you work | `crew lease on` … `crew lease off` |
| Close a session cleanly | `/crew:handoff` |
| Import an existing checklist | `crew queue import backlog.md --section "Queue" --dry-run` |

## Schedule it

```bash
crew schedule install sync --at 06:30                     # fast-forward main before runners use it
crew schedule install brief --at 19:00
crew schedule install brief-weekly --at 18:00 --weekday 0
crew schedule install watch --every 10                     # dispatch when there is work + refresh the Slack board
crew schedule status
crew schedule remove watch
```

**Several workers at once:** set `"parallel": 5` (with a `"wip_cap"` at least that high). Each run
then starts up to that many `ready` issues together, each in its own worktree, with the day's budget
shared out between them. Expect more merge conflicts when tasks touch the same files.

`watch` is the usual way to run dev. Every 10 minutes it does the plain checks (lock, lease,
budget, WIP cap, queue). It wakes the model only when an issue is `ready` or a review needs a fix.
It refreshes the Slack board when a label changed and posts one news line when something happened;
the same line is not repeated within 6 hours. `dispatch --at ...` still works for fixed times.

To keep the dev worker off the subscription while other jobs need it, set local-time windows:
`"dispatch_hours": ["14:00-19:45"]`. Outside them `watch` only refreshes the board.

- **macOS:** a launchd user agent in `~/Library/LaunchAgents`.
- **Windows:** a Task Scheduler task under `\crew\`, using S4U, Limited, `IgnoreNew` and an
  explicit execution limit.
- **Logs:** `.crew/logs/<job>.log`.
- **Preview first:** `--print` shows the file without installing it.

## Self-review (optional)

`crew review` runs the project's own review routine, on the machine that holds the live files. Point
it at the routine and say which commands it may run:

```json
"review": { "routine": "docs/self-review.md", "bash": ["${root}/.venv/bin/python scripts/"] }
```

- **What it can touch:** it reads the code at `main` plus the main checkout's live, gitignored files,
  and writes only its own report.
- **What it opens:** `crew/review-<date>` as the plan PR, which never merges itself. Its proposals are
  filed as `needs-jk` issues.
- **When it runs:** schedule it weekly (`crew schedule install review --at 16:00 --weekday 0`) or run
  it whenever you want a fresh plan.

## Slack (optional)

GitHub labels stay the truth; Slack is the window. One free workspace can hold many projects, one
channel each.

1. Create a Slack app (api.slack.com/apps, "From scratch") with the bot scopes `chat:write`, `channels:history` (for Slack commands),
   `pins:read` and `pins:write`, and install it to your workspace.
2. Invite it to the project channel (`/invite @your-app`) and copy the channel ID (channel name,
   then the bottom of the About tab).
3. Add `"slack": {"channel": "C0123ABCD"}` to `.claude/crew.json`.
4. Save the bot token on each machine that runs jobs: `crew token set --slack` (hidden prompt).
5. `crew board` posts and pins the board; `watch` keeps it current. Briefs post a short version.

`"board": false` or `"news": false` turns either half off.

## A new project in one command

Create the GitHub repo and the Slack channel (invite `@crew`), then on the central machine:

```bash
crew project add --repo owner/name --slack-channel C0123ABCD --roles ops
```

It does every remaining step:

1. Clones the repo next to the project you run it from, or into `--dir`.
2. Writes `.claude/crew.json`, copying machines, caps and Slack settings from that project.
3. Adds `.crew/` to `.gitignore` and pushes the setup commit.
4. Creates the labels and runs `crew doctor`.
5. Schedules sync, watch, brief and brief-weekly.
6. Pins the Slack board and says hello.

Re-running it is safe: steps that are already done are skipped.

**Windows without admin:** a job that Windows refuses to register as S4U falls back to a
"run while you are logged in" task, so no admin prompt is needed (`--logon auto`, the default).

## Commands from Slack

Add your Slack member ID (profile > ⋯ > Copy member ID) as a commander:

```json
"slack": { "channel": "C0123ABCD", "commanders": ["U0123ABCD"] }
```

The Slack app also needs the `channels:history` scope (reinstall it after adding the scope).

`crew watch` then reads `crew …` messages from commanders and replies in the thread:

- `crew help`
- `crew brief`, `crew brief weekly`
- `crew review`
- `crew board`
- `crew next`
- `crew doctor`
- `crew project add repo=owner/name channel=C0123 [dir=...] [roles=a,b]`

Only those commands run, each mapped to a fixed crew command line with no shell. Nothing from
Slack can label `ready`. A messenger bot that posts as you (for example Grok Bot's Slack app) can
drive the central machine this way without any open port or tunnel.

## Two machines: a central machine and helpers

```json
"machines": { "main": "pc", "helpers": ["mac"] }
```

Each machine names itself once with `crew machine set pc` (`main` is the central machine) (stored machine-locally, next to the
token). Then `crew queue labels` creates a `pc` and a `mac` label.

- **Unlabelled work** runs on the main machine.
- **An issue labelled `mac`** runs only on the Mac.
- **A machine with no name** takes no queued work, and `crew doctor` warns about it.

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
  "roles": ["trade", { "name": "ops", "memory": "docs/roles/ops.md" }],
  "slack": { "channel": "C0123ABCD", "board": true, "news": true },
  "machines": { "main": "pc", "helpers": ["mac"] }
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
- **Per-machine commands:** `test_cmd` and `protected_paths_cmd` can be one string or a per-OS
  object. Use this when the command differs per machine, for example a Python venv:

  ```json
  "test_cmd": { "darwin": "${root}/.venv/bin/python -m pytest -q",
                "win32":  "${root}\\.venv\\Scripts\\python.exe -m pytest -q" }
  ```

  `${root}` is replaced by the project's main checkout. The dev worker runs in a throwaway
  worktree, which has none of the untracked files such as `.venv`.
- **`.env` is blocked:** the dev worker is always denied reading or editing `.env` files. This is
  enforced by its permissions, not just by instructions.

## Develop

```bash
npm test                         # node --test, no dependencies
claude plugin validate --strict .
```

Background: [docs/research/](docs/research/) covers how others run agent teams and what we copied.
[docs/plan.md](docs/plan.md) is the build plan. MIT licensed.
