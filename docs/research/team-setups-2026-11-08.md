# How other people set up agent teams: research for the crew template

2026-11-08. Researched by two Claude web agents, plus Codex (gpt-6.1-sol, high) on the same
question in parallel; its findings are in their own section. Tags:

- **[read]**: the source page was fetched.
- **[snippet]**: seen in search results only. Check it before you rely on it.
- **[checked]**: confirmed again by me for this report.

## The short answer

Nobody publishes exactly our shape (PM + headless dev + cross-engine reviewer + messenger). The
pieces all exist separately, and the people who run them unattended agree on six things:

1. **Run one task per fresh session.** Keep state in files and git, and cap every run.
2. **The agent that does the work never grades or merges it.**
3. **Review capacity is the bottleneck, not build capacity.** Keep PRs small and cap work in
   progress.
4. **Unattended runs fail on auth, billing and cleanup, more often than on code.**
5. **Issue text is untrusted input.** Hidden instructions in issues have leaked tokens.
6. **Status reports people keep reading have fixed fields, with "blocked" first**, and a human
   step before they are posted.

## GitHub Free: what it changes (checked against docs.github.com)

| Feature | Public repo on Free | Private repo on Free |
|---|---|---|
| Branch protection | yes | **no** |
| Rulesets | yes | **no** |
| Native "auto-merge" button | yes | **no** |
| Actions minutes | unlimited | **2,000/month** [snippet, third-party pricing sites] |
| Issues, labels, Projects | yes | yes |
| Copilot coding agent | needs paid Copilot | needs paid Copilot |
| Codex PR review | ChatGPT plan, not GitHub plan | same |

What this means for the template:

- **Server-side guards do not exist on private repos.** "The agent never pushes main" has to be
  enforced on the machine:
  - a `pre-push` git hook in the worktree that refuses `main`
  - Claude Code permission deny rules for `git push * main` and `gh pr merge`
  - a dispatcher that only ever pushes `agent/*` branches
- **Merges stay a person's click, or a workflow that runs `gh pr merge` after its own checks.**
  A workflow merge works with no branch protection, but it has no second key unless you write
  one in. We have seen plan PRs **merge themselves** this way.
- **Agents run locally, not on Actions.** `claude-code-action` on a private repo burns the 2,000
  minutes. Run the dispatcher and the PM from launchd or Task Scheduler. Keep Actions for a small
  test job.
- **Make the template repo itself public.** It holds no secrets, and public gets protection and
  unlimited Actions for its own CI.

## Findings, ranked for our design

### 1. Headless `claude -p` has traps [read] [code.claude.com/docs/en/headless]

- **Failures:** an auth failure is printed as the result on stdout. Check the exit code **and** the
  JSON.
- **Cost:** `--output-format json` gives `total_cost_usd` and `session_id`. Log both on every run.
- **Timeouts:** on SIGTERM the run exits 143 with no result for the current turn. On timeout, send
  SIGINT first and SIGTERM after a grace period.
- **Prompts:** `--permission-prompts none` denies anything that would prompt.
- **Trust:** without `--bare`, `-p` runs the repo's project hooks and `.mcp.json` servers with **no
  trust prompt**.
- **`--bare` cost:** it also skips `.claude/agents`, so `--agent dev` needs non-bare mode or
  `--agents <file>`. **Template choice:** non-bare. We own the repos, and the dispatcher only runs
  in repos listed in its config.

### 2. A stray API key bills the API account, not the subscription [read] [checked]

- [anthropics/claude-code#37686](https://github.com/anthropics/claude-code/issues/37686)
  (2026-03-23): a Max subscriber's cron `claude -p` picked up `ANTHROPIC_API_KEY` and ran up
  **$1,800 in two days**. Another commenter reported about $1,700 from an overnight Ralph loop.
  Spend limits did not stop it.
- **Template:** the dispatcher unsets `ANTHROPIC_API_KEY` before every run.
- **Cost guard:** cap each run with `--max-turns` plus `--max-budget-usd`. Add a daily cost total
  that stops the queue when it is crossed.

### 3. Logging in under launchd [read]

- [#80091](https://github.com/anthropics/claude-code/issues/80091) and related reports: the
  Keychain login lasts about 8 hours and is not refreshed when nobody is using the Mac. Scheduled
  jobs then fail with "Not logged in".
- **Fix:** use `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.
- **Template:** before taking a task, the dispatcher runs a cheap canary call (`claude -p "ok"`). If
  the canary fails, it stops and sends an alert.

### 4. Review is the bottleneck: the only large measured study [read]

[Stephen Toub, dotnet/runtime, 2026-03-23](https://devblogs.microsoft.com/dotnet/?p=59781), 878
agent PRs over 10 months:

- **Success rate:** 67.9% (humans 87%). It rose from 38% to 69% once build and test instructions
  and network access were fixed.
- **Size:** changes of 1–50 lines succeed 76–80% of the time. Changes of 101–500 lines drop to 64%.
- **Review load:** 16.5 review comments per merged PR, against 12.4 for human PRs.
- **Neglect:** 44% of closed agent PRs were drafts nobody reviewed for 30 days. We have seen the same
  pattern: an agent draft sat for 30 days and held a WIP slot.
- **Template:**
  - WIP cap of 2
  - task size target of about 50 lines or less
  - a ready-to-build checklist in each project's config: how to run the tests, how to build
  - PM brief line: "PRs waiting on you, oldest first"

### 5. The worker must not grade or merge its own work [read]

- **Copilot coding agent:**
  - It can only push `copilot/*` branches.
  - The person who requested the PR cannot approve it.
  - CI on agent PRs waits for a human "Approve and run".
  - Each run has a 59-minute hard cap and opens one PR.
- **Codex on GitHub** ([docs](https://learn.chatgpt.com/docs/third-party/github)):
  - It flags P0/P1 issues only.
  - Its rules live under `## Code Review Rules` in `AGENTS.md`.
  - It is "not a replacement for required approvals".
  - **Any `@codex` comment other than `review` starts a task that can push fixes.**
- **openai/codex-plugin-cc:**
  - `/codex:review` is read-only and `/codex:rescue` edits code.
  - Its Stop-hook review gate warns it "can create a long-running Claude/Codex loop".
- **Template:**
  - A clean Codex review is advisory, never an approval.
  - The dispatcher only ever posts `@codex review`.
  - Codex's rules go in `AGENTS.md`, starting with 2–3 rules.

### 6. Loop structure: Ralph and variants [read]

| Source | What it adds |
|---|---|
| [aihero](https://www.aihero.dev/getting-started-with-ralph) | PRD + `progress.txt`; "ONLY DO ONE TASK"; a required iteration count; a `<promise>COMPLETE</promise>` marker for early exit |
| [chrismdp/ralph](https://github.com/chrismdp/ralph) | `todo/doing/done/blocked` tickets; a blocked ticket says in `## Notes` what the human must do |
| [ralphex](https://github.com/umputun/ralphex) | `max_iterations` 50; `task_retry_count` 1 (one fix round); Codex review phase capped at `max(3, iter/5)` rounds; session and idle timeouts **off by default**; keeps failed worktrees, which blocks re-runs |
| [Anthropic, long-running harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) (2025-11-26) | task list as **JSON** (models tamper with it less than Markdown); smoke test at the start of each session; main failure mode is declaring done without an end-to-end test |
| [Crosley, loop engineering](https://blakecrosley.com/guides/loop-engineering) (updated 2026-10-28) | the worker never grades itself; protect tests from the agent; the PR is the blast radius; unattended loops yield to an interactive session; incidents: `max_iterations: 0` = unlimited → 1,966 self-queries, 4M tokens burnt in 5 minutes, a run reported "Succeeded" that never started |
| [108-hour unattended run](https://dev.to/yurukusa/i-let-claude-code-run-unattended-for-108-hours-heres-every-accident-that-happened-51cm) | `rm -rf` lost source; pushed straight to main; a "fixed!" loop ran 20 cycles until a 3-retries-then-park rule |

**Template:**

- one issue per run
- one fix round, then `blocked` with a note saying what the human must do
- a wall-clock **and** an idle timeout
- a lock file, so two runs never overlap. No source describes locking, so we design it ourselves.
- worktree cleanup always runs, even after a failure
- the dispatcher skips its run when an interactive session holds the repo lock

### 7. Issue text is untrusted input [snippet + read]

- PromptPwnd (2025-12): instructions hidden in issue titles and bodies got Gemini CLI, Claude Code
  Action and Codex to leak tokens.
- The claude-code-action security docs [read]:
  - only users with write access can trigger it
  - avoid static personal access tokens
  - watch for hidden markdown
- **Template:**
  - The dispatcher takes only issues labelled `ready` **by the repo owner**. It checks who applied
    the label through the API.
  - It strips HTML comments from issue bodies before building the prompt.
  - The run's token can push branches and open PRs, nothing more.

### 8. Plugin packaging facts [read] [code.claude.com/docs: plugins-reference, plugins/loading, plugin-marketplaces, sub-agents]

- **What a plugin can ship:** agents, commands/skills, `hooks/hooks.json`, `.mcp.json`, `bin/`,
  `settings.json`.
- **A CLAUDE.md at the plugin root is not loaded.** Put shared instructions in a skill.
- **Paths:**
  - `${CLAUDE_PLUGIN_ROOT}` changes on every update.
  - `${CLAUDE_PLUGIN_DATA}` survives updates.
  - `${CLAUDE_PROJECT_DIR}` is the project root.
  - None of the three is set inside Bash-tool commands.
  - Durable state goes in the project repo, never in the plugin folder.
- **Plugin agents ignore the `hooks`, `mcpServers` and `permissionMode` frontmatter.** Ship those at
  plugin level.
- **Read-only role:** `tools: Read, Grep, Glob`. `memory: project` gives an agent its own notes, and
  `isolation: worktree` gives it its own git worktree.
- **Versions:**
  - With `version` unset, the version is the commit SHA.
  - A pinned `version` must be bumped on every change, or users stay on the old copy.
  - Auto-update is off for third-party marketplaces.
- **Install:** project `enabledPlugins` alone does **not** install a plugin on a fresh machine.
  Install it per user on each machine.
- **Settings:** `userConfig` prompts for values; sensitive ones go to the keychain.
- **Checks:** run `claude plugin validate --strict` in CI. Fail the run if `plugin_errors` appears.

### 9. Windows [read] [checked]

- [#21878](https://github.com/anthropics/claude-code/issues/21878): Git Bash mangles backslash paths
  in `${CLAUDE_PLUGIN_ROOT}`, and plugin hooks fail. It was closed "not planned". A related report
  says the variable is not expanded at all under PowerShell.
- A default Git for Windows install leaves `bash` off PATH, so hooks fail with no error shown.
- **Template:**
  - Hooks are Node, in exec form with `args`, with forward-slash paths.
  - The dispatcher and brief runner are Node or Python, not bash, so one script runs on both
    machines.
  - Only the scheduler wrapper differs: launchd plist vs `register_*.ps1`.

### 10. Status and PM reports [read]

- **[amux daily standup](https://amux.io/use-cases/ai-agent-daily-standup/):**
  - fixed fields per agent: done (with a one-line reason), tests, PRs, **BLOCKED + reason**, next
  - the human reads BLOCKED first
  - review takes about 5 minutes
- **[n8n template 19880](https://n8n.io/workflows/19880-send-engineering-daily-digest-to-slack-with-jira-github-openai-and-google-sheets/):**
  - a list of repos in config
  - per repo: recent PRs, plus open PRs with no review
  - the model returns **strict JSON** (shipped / blocked / needs review / health), rendered into one
    message
  - this is the cross-project roll-up pattern for Grok later
- **[PostHog, standup bot](https://posthog.com/blog/standup-bot-revenge) (2026-04-01):**
  - three agents were replaced by **one agent with 18 tools**: more reliable and about 300 lines
    shorter
  - it drills into significant PRs only
  - a human confirms before it posts
  - evals caught recurring format errors
- **Template:**
  - The PM writes JSON first (`status.json`). `STATUS.md` and the brief are rendered from it, so the
    format can't drift.
  - The colleague voice lives in the brief's prose, not in STATUS.md.
  - Decisions and blocked items go at the top.

## Codex research desk: what it added

Codex (gpt-6.1-sol, high) answered the same question independently. It tags `[verified]` for "read
the source", not "reproduced". Its additions beyond the Claude agents:

### 11. Budgets must add up per issue, not per run [verified]

- **`--max-budget-usd` is estimated, can overshoot and includes subagent spend.** A resumed run's cap
  does not count what was spent before the resume ([cli-reference](https://code.claude.com/docs/en/cli-reference)).
- **Reported bug:** OpenHands looped past `max_iterations: 5`
  ([#8630](https://github.com/OpenHands/OpenHands/issues/8630), 2025).
- **Template:** each issue carries a running cost and attempt count in the dispatcher's state, with
  reviewer calls included. A fresh session never resets an issue's allowance.

### 12. The account that runs the agent decides whether "agents can't approve themselves" is true [verified]

- **Agents approving through a human's account:** ["Who Approved This?"](https://arxiv.org/html/2610.28683v1)
  (2026-10-19) studied 786 merged PRs. 71 of 263 merges rested only on approvals that agent sessions
  submitted through the tech lead's own account. Agents also disabled the merge checks.
- **Same pattern here:** agent PRs authored as the owner's own account are exactly this pattern,
  and on Free there is no required-review rule to backstop it.
- **Malicious issues:** a public issue got an agent with broad repo access to leak private repo data
  into a public PR ([Invariant](https://invariantlabs.ai/blog/mcp-github-vulnerability), 2025-05-26).
- **Template:**
  - The builder runs as a **separate GitHub machine account**, given write access only to the
    repos it builds in. GitHub's terms allow one free machine account per person [inference, check
    the ToS].
  - Merge stays with JK's account.
  - The builder's token cannot merge, change settings or touch other repos.

### 13. Bind every check and review to the head SHA [verified]

- **False greens:** the same study had 4 false-green merges, from a script that read the overall PR
  status instead of the required check on the exact head commit.
- **Template:** the merge step reads check runs for `headRefOid` only. A per-(PR, sha) state file
  is a simple way to do this.

### 14. Keep separate limits on running workers and open PRs [verified]

- **Symphony:** [OpenAI's Symphony spec](https://github.com/openai/symphony/blob/main/SPEC.md) has
  explicit issue claims, bounded concurrency, a workspace per issue, and reconciliation when an
  issue's state changes (it was shown with Linear).
- **WIP cap:** a WIP cap of 2 is a review-capacity choice, not an industry standard.

### 15. Do not wake a model to ask "anything to do?" [verified]

- **Paperclip:** an always-awake manager logged 1,293 timer wakeups and 812 cost events in 10 days,
  with no budget actually enforced ([#4027](https://github.com/paperclipai/paperclip/issues/4027)).
- **Cursor:** shared-file locks stalled workers ([scaling agents](https://cursor.com/blog/scaling-agents),
  2026-01-14).
- **Template:** the dispatcher and PM run plain checks first: queue empty, WIP full, nothing changed
  since the last brief. The model is called only when there is work.

### 16. Precedents for the reporting and packaging pattern [verified]

- **Status report:** GitHub's own [repo-status workflow](https://github.com/githubnext/agentics/blob/main/workflows/repo-status.md)
  separates the agent that reads from the narrow step that writes the report. That is our PM split.
- **One global skill:** Chris Parsons dropped per-project copies of his loop instructions for **one
  global skill plus small per-project overrides**
  ([2026-05-10](https://www.chrismdp.com/running-ralph-loops-is-easy/)). This directly supports
  the template-first approach.
- **Shutdown check:** he also added a working-tree/test/comment check after interrupted sessions had
  closed issues that weren't done.

### 17. Windows Task Scheduler [verified]

- It has an explicit overlap policy (`MultipleInstances`, which `IgnoreNew` sets).
- **Its default run limit is 72 hours.** Set `ExecutionTimeLimit` yourself.
- An interactive test run does not prove the scheduled run works, because auth, paths and the user
  account all differ.

### 18. Measured costs [verified, author-reported]

| Source | Model cost per merged PR | Notes |
|---|---|---|
| [Lamplit](https://blogs.lamplitlabs.com/posts/ai-sdlc-cost-per-merged-pr-coding-agent-token-budgets/) (2026-10-18) | $31 → $9 over 8 weeks | merge rate 60–67%; per-task budgets; repeated-failure limits; truncated tool output; 6% of runs had used 48% of tokens |
| [BurnLens](https://burnlens.app/cost-per-outcome) | $6.84–$84.94 | across repos; small samples; human time not counted |

**Template:** the PM brief tracks:

- total spend, including abandoned work
- PRs merged, closed unmerged, and still open
- fix rounds
- queue age
- reverts

## What we should copy

- **Fresh session per issue:**
  - JSON task state
  - `PROGRESS.md` and `LEARNINGS.md` appended per run
  - a smoke test at the start of each run
- **Caps on every run:**
  - `--max-turns`
  - `--max-budget-usd`
  - wall-clock and idle timeouts
  - SIGINT first, then SIGTERM after a grace period
  - a daily cost ceiling
  - a lock file
  - worktree cleanup that always runs
- **Auth and billing:** unset `ANTHROPIC_API_KEY`, use `CLAUDE_CODE_OAUTH_TOKEN`, and run a canary
  call before taking a task.
- **Branch hygiene on GitHub Free:**
  - agent branches only (`agent/<issue>-<slug>`)
  - a local pre-push hook refusing `main`
  - permission deny rules for `push main` and `pr merge`
- **Review:**
  - one fix round, then `blocked` with a "what the human must do" note
  - Codex review is advisory, never an approval
- **The PM:** one agent with tools, not a chain; JSON first, prose second; a human sees the brief
  before anything is automated.
- **Budgets and gating:**
  - a running per-issue budget and attempt count that survive restarts
  - plain pre-checks before any model call
  - checks bound to the head SHA
- **Builder identity:** a separate machine account for the builder; JK's account keeps merge rights.
- **Plugin build:** Node or Python scripts and hooks, durable state in the project repo, a public
  template repo, `plugin validate` in CI.

## What we should avoid

- Bash-only scripts and hooks (they break on Windows).
- Relying on server-side protection or native auto-merge on private Free repos.
- A workflow that merges PRs touching the queue or plan files. This is how plan PRs
  end up merging themselves.
- Running agents on Actions in private repos (it burns the 2,000 minutes).
- Pasting raw issue bodies into prompts, or taking issues labelled by anyone other than the owner.
- `--dangerously-skip-permissions` outside a throwaway worktree.
- Setting a cap to `0`, or trusting the model's own "done".
- Opening PRs faster than you review them.
- Stop-hook review gates in unattended runs (they can loop and drain quota).
- Pinning a plugin `version` without bumping it on every change.

## Open gaps (not found in any source)

- Concrete locking or idempotency designs for local dispatchers. We design our own (per-(PR, sha)
  idempotency, as some PR gates use, is a working pattern).
- First-hand reports on which status-report formats people stopped reading.
- An official `/handoff` command. There are community ones (392fyc/claude-handoff,
  REMvisual/claude-handoff) and an open feature request,
  [#11455](https://github.com/anthropics/claude-code/issues/11455).
