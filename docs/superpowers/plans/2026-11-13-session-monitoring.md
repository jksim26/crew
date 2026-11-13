# Session Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Interactive Claude Code sessions in a crew repo are recorded through plugin hooks and shown
next to the dev workers (part 1, PR 1). A live session's edited files then hold off overlapping dev
builds (part 2, PR 2).

**Architecture:** The plugin ships `hooks/hooks.json`, which calls `crew session-hook <event>`. The
new `lib/sessions.mjs` maps the hook's `cwd` to the main checkout and keeps
`.crew/sessions/<id>.json`. It also answers `liveSessions()` for the CLI, the Slack board and the
dispatch overlap guard.

**Tech Stack:** Node 20+ ESM, `node:test`, Claude Code plugin hooks, no npm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-13-session-monitoring-design.md`

## Global Constraints

- No npm dependencies. Node 20+. macOS and Windows.
- The hook never exits non-zero and never throws to the caller. Its only stdout is the
  `SessionStart` additional-context JSON. Errors go to `.crew/logs/session-hook.log`.
- The hook exits at once when `env.CREW_AGENT === "1"` or no crew repo is found.
- `session_quiet_min`: an optional integer from 10 to 1440, default 120.
- Sessions are this-host only. Other hosts' files are never returned and never deleted.
- Only edited files count (Edit, Write, MultiEdit, NotebookEdit), never reads.
- Version bumps: PR 1 goes to 0.8.20 and PR 2 to 0.8.21 (after the worktree-cleanup PR's 0.8.19), in
  both `.claude-plugin/plugin.json` and `package.json`.
- Branches: PR 1 is `feat/session-monitoring`. PR 2 is `feat/session-holds`, cut from `main` after
  PR 1 merges. Use git worktrees, never `main`.

## Review Focus

- **Two sessions in one folder** (two claude-trading-team sessions on 2026-11-13). Each keeps its
  own file and its own files list, and clearing one leaves the other.
- **A resumed session** (`SessionStart` with `source: "resume"`). It keeps its `started` time and
  files list, and refreshes `updated`.
- **An edit outside the repo** (`file_path` under `/tmp` or another repo). It is not added to
  `files`, but `updated` is still refreshed.
- **A session started in a git worktree of the repo** (for example under `.claude/worktrees/`). It is
  recorded under the main checkout's `.crew/`, with paths relative to the worktree root.
- **Malformed or empty stdin.** The hook exits 0, prints nothing and writes one log line.

---

## Part 1: PR `feat/session-monitoring` (0.8.20)

### Task 1: The session store and `CREW_AGENT`

**Files:**
- Create: `lib/sessions.mjs`
- Modify: `lib/pm.mjs` (`claudeEnv`: set `e.CREW_AGENT = "1"`)
- Modify: `lib/config.mjs` (add `session_quiet_min` to the known keys and its validation, next to
  `parallel`)
- Test: `test/sessions.test.mjs`, `test/config.test.mjs`

**Interfaces:**
- Produces, all in `lib/sessions.mjs`:
  - `sessionsDir(root) -> string`: `<root>/.crew/sessions`.
  - `findCrewRoot(cwd) -> string | null`: walks up from `cwd` to the first folder containing
    `.claude/crew.json`, then returns `mainCheckout(thatFolder)`.
  - `recordSessionEvent({ event, input, env = process.env, now = new Date(), run = realRun }) -> { root: string|null, id: string|null, action: "skip"|"written"|"deleted" }`
    - `event` is one of `SessionStart`, `UserPromptSubmit`, `PostToolUse` or `SessionEnd`.
    - `input` is the parsed hook JSON.
    - The worktree root comes from `git rev-parse --show-toplevel` in `input.cwd`.
    - The edited path is `input.tool_input.file_path ?? input.tool_input.notebook_path`, stored
      relative to the worktree root with `/` separators, or dropped when it lies outside.
    - `worktree` is the worktree root when it differs from the crew root, else `null`.
  - `liveSessions(root, { now = Date.now(), quietMin = 120 } = {}) -> Session[]`: this host's files
    with `updated` within `quietMin`, sorted by `started`. It deletes this host's older files. It
    never returns or deletes other hosts' files.
  - `clearSessions(root, id = null) -> number`: deletes one session's file, or all of this host's
    when `id` is null. Returns the count.
  - `Session` is `{ id, host, machine, cwd, worktree, started, updated, files: string[] }`.
- Consumes: `mainCheckout` (`lib/config.mjs`), `readJson` and `writeJson` (`lib/state.mjs`),
  `thisMachine` (`lib/machine.mjs`), `run` (`lib/exec.mjs`).

- [ ] **Step 1: Write the failing tests** in `test/sessions.test.mjs`. Use a temp repo folder with
  `.claude/crew.json`, and a `run` stub that answers `git rev-parse --show-toplevel` with the
  folder.
  - `recordSessionEvent: skips non-crew folders`: a `cwd` of `os.tmpdir()` gives `action: "skip"`,
    and no `.crew/sessions` folder is created.
  - `recordSessionEvent: skips crew's own runs`: `env.CREW_AGENT = "1"` gives `action: "skip"`.
  - `recordSessionEvent: start, edit, resume, end`:
    - `SessionStart` writes the file with `files: []`.
    - `PostToolUse` Edit with `file_path` `<repo>/lib/a.mjs`, sent twice, gives `files: ["lib/a.mjs"]`.
    - `SessionStart` with `source:"resume"` keeps `started` and `files`.
    - `SessionEnd` deletes the file, with `action: "deleted"`.
  - `recordSessionEvent: an edit outside the repo refreshes but adds nothing`: a `file_path` of
    `/tmp/x` leaves `files` as `[]` and gives a newer `updated`.
  - `recordSessionEvent: two sessions in one folder stay apart`: ids `a` and `b` each keep their
    own `files`.
  - `recordSessionEvent: a worktree session lands in the main checkout`: `cwd` is a folder whose
    `.git` is a file pointing at the main repo's `.git/worktrees/x`, as `mainCheckout` expects. The
    file is under the main root's `.crew/sessions`, and `worktree` is that folder.
  - `liveSessions: expires quiet sessions on this host only`:
    - this host, `updated` 3 h ago: removed from disk;
    - this host, 5 min ago: returned;
    - `host: "other"`, 3 h ago: still on disk and not returned.
  - `clearSessions: one or all`: `clearSessions(root, "a")` returns 1 and `b` remains, then
    `clearSessions(root)` returns 1.
  - In `test/config.test.mjs`: `session_quiet_min` 9 and 1441 are rejected with a message naming
    the key, and 120 is accepted.
  - In `test/sessions.test.mjs`: `claudeEnv sets CREW_AGENT`, meaning
    `claudeEnv({}).CREW_AGENT === "1"`.

- [ ] **Step 2: Run** `node --test test/sessions.test.mjs test/config.test.mjs`. Expected: FAIL,
  because the module is missing and the config key is unknown.

- [ ] **Step 3: Implement** the Interfaces above in `lib/sessions.mjs`. Add the `claudeEnv` line,
  and the `session_quiet_min` key and validation in `lib/config.mjs` (integer, 10 to 1440, message
  `"session_quiet_min" must be an integer from 10 to 1440`).

- [ ] **Step 4: Run** `npm test`. Expected: all tests pass.

- [ ] **Step 5: Commit**: `git commit -m "sessions: store for interactive Claude sessions; crew runs marked CREW_AGENT"`

### Task 2: The hook command, `hooks.json`, and the `crew sessions` CLI

**Files:**
- Create: `hooks/hooks.json`
- Modify: `lib/cli.mjs` (the commands `session-hook`, `sessions`, and the `workers` output; the help text)
- Test: `test/sessions.test.mjs` (CLI cases through `main(argv, io)`, as `test/init-cli.test.mjs` does)

**Interfaces:**
- Consumes: Task 1's `recordSessionEvent`, `liveSessions`, `clearSessions` and `findCrewRoot`.
- Produces:
  - `crew session-hook <event>`. It reads all of stdin as JSON and calls `recordSessionEvent`. On
    `SessionStart` with a non-null id, it writes exactly
    `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"crew session id: <id>"}}`
    to stdout. It always returns 0. Any error is appended as one JSON line to
    `<root>/.crew/logs/session-hook.log` when a root is known, and otherwise dropped.
  - `crew sessions [--json]` prints one line per session:
    `<id8>\t<machine|host>\t<worktree basename or "main">\topen <m>m\tactive <m>m ago\t<n> files`.
    With none, it prints `no sessions open on this machine`.
  - `crew sessions clear <id>|--all`. Without either it throws `usage: crew sessions clear <id>|--all`.
  - `crew workers` prints a `sessions:` block with the same lines after the workers. `--json`
    prints `{ workers, sessions }`.
  - `quietMin` comes from `config.session_quiet_min ?? 120` everywhere.

- [ ] **Step 1: Write the failing tests.**
  - `session-hook: prints the id on SessionStart only`: feed `SessionStart` JSON, and stdout parses
    to the exact shape above. `UserPromptSubmit` gives an empty stdout. Both return 0.
  - `session-hook: bad stdin exits 0 silently`: stdin `not json` returns 0 with empty stdout.
  - `sessions: lists and clears`: after two recorded sessions, `crew sessions` prints 2 lines and
    `crew sessions clear --all` leaves `no sessions open on this machine`.
  - `hooks.json is valid and covers the four events`: parse `hooks/hooks.json`.
    - Its keys are `SessionStart`, `UserPromptSubmit`, `PostToolUse` and `SessionEnd`.
    - The `PostToolUse` matcher is `Edit|Write|MultiEdit|NotebookEdit`.
    - Every command contains `"${CLAUDE_PLUGIN_ROOT}/bin/crew" session-hook`.
    - Every hook has `"timeout": 10`.

- [ ] **Step 2: Run** `node --test test/sessions.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement** the commands in `lib/cli.mjs` and write `hooks/hooks.json`, using the
  plugin hooks format: `{"hooks": {"<Event>": [{"matcher"?, "hooks": [{"type":"command","command":"node \"${CLAUDE_PLUGIN_ROOT}/bin/crew\" session-hook <Event>","timeout":10}]}]}}`.
  The `session-hook` branch must run before `projectContext()`, which throws outside a crew repo.

- [ ] **Step 4: Run** `npm test`. Expected: all tests pass.

- [ ] **Step 5: Manual check on the Mac.** Install the plugin from this branch
  (`claude plugin marketplace add <worktree path>`, then reinstall `crew@crew`). Open a new Claude
  session in `crew-sandbox`, edit one file, and run `crew sessions`. Expected: 1 line with
  `1 files`. Close the session, run `crew sessions` again, and expect
  `no sessions open on this machine`. Note how long the hook took
  (`.crew/logs/session-hook.log` stays empty, and the session shows no hook delay).

- [ ] **Step 6: Commit**: `git commit -m "sessions: plugin hooks and crew sessions command"`

### Task 3: Sessions on the Slack board

**Files:**
- Modify: `lib/slack.mjs` (`sessionLines`, `renderBoard`, `renderBoardMarkdown`, the `syncBoard` hash)
- Modify: `README.md` (a short "Sessions" paragraph under Daily use, plus the `crew sessions` row)
- Modify: `.claude-plugin/plugin.json`, `package.json` (0.8.20)
- Test: `test/slack-watch.test.mjs`

**Interfaces:**
- Consumes: `liveSessions` (Task 1).
- Produces:
  - `sessionLines(sessions, now = new Date()) -> string[]`. Each line is
    `• <machine|host> · <worktree basename or repo folder name> · open <m>m · active <m>m ago · <n> files`,
    and `["• none"]` when empty.
  - `renderBoard(config, cols, now, workers = [], sessions = [])` and
    `renderBoardMarkdown(config, cols, now, workers = [], sessions = [])`. These add the section
    `🧑‍💻 *Sessions* (<n>) · open on this machine` (markdown: `## 🧑‍💻 Sessions (<n>) · open on this machine`)
    right after Workers.
  - The `syncBoard` hash input gets
    `sessions: sessions.map((s) => [s.id, s.files.length, Math.floor((now - Date.parse(s.started)) / 600_000)])`.

- [ ] **Step 1: Write the failing tests.**
  - `board: sessions section after workers`: `renderBoard` with one session contains
    `🧑‍💻 *Sessions* (1)`, the section sits after the Workers section, and the line contains
    `· 2 files`.
  - `board: no sessions shows none`.
  - `board: a session opening changes the hash`: `syncBoard` with a stubbed Slack is skipped as
    "board unchanged" on the second call with the same state, and posts again after a session file
    is written.

- [ ] **Step 2: Run** `node --test test/slack-watch.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement** as in Interfaces. Pass `liveSessions(root, { quietMin })` from
  `syncBoard` into both renderers.

- [ ] **Step 4: Run** `npm test`. Expected: all tests pass. Bump both version files to 0.8.20, then
  run `node scripts/check-version.mjs`. Expected: `version 0.8.20`.

- [ ] **Step 5: Commit and open PR 1**:
  `git commit -m "board: show open sessions next to workers (0.8.20)"`. The PR body links the spec,
  ends with the attribution line, and states that part 2 follows.

## Part 2: PR `feat/session-holds` (0.8.21)

### Task 4: Live sessions hold their edited files

**Files:**
- Modify: `lib/dispatch.mjs` (the `holders` array in `runDispatch`)
- Modify: `skills/handoff/SKILL.md` (a new step after "Release the lease")
- Modify: `README.md` (one sentence in the Overlap guard paragraph)
- Modify: `.claude-plugin/plugin.json`, `package.json` (0.8.21)
- Test: `test/dispatch.test.mjs`

**Interfaces:**
- Consumes: `liveSessions` (Task 1), and the existing `overlapWith`/`guard` in `runDispatch`.
- Produces: each live session becomes a holder
  `{ label: \`a session on ${s.machine ?? s.host}${s.worktree ? \` (${path.basename(s.worktree)})\` : ""}\`, issue: null, files: s.files }`,
  appended to `holders` only when `s.files.length`.

- [ ] **Step 1: Write the failing tests** in `test/dispatch.test.mjs`, using its existing dry-run
  `runDispatch` stub with one `ready` issue whose body has `Writes: lib/a.mjs`.
  - `overlap: a live session's edit holds an overlapping build`: write a session file with
    `files: ["lib/a.mjs"]`. The dry run's `skipped` reason matches
    `/waits for a session on .* \(both change lib\/a\.mjs\)/`.
  - `overlap: a session on other files does not hold`: with `files: ["lib/b.mjs"]` the issue is
    planned.
  - `overlap: exempt files never hold`: with `files: ["PROGRESS.md"]` the issue is planned.
  - `overlap: a quiet session no longer holds`: with `updated` 3 h ago the issue is planned.

- [ ] **Step 2: Run** `node --test test/dispatch.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement** the holders line. Then add a new step 5 to the handoff skill (renumber
  the steps after it): "**Free this session's files:** run `crew sessions clear <id>`, using the
  `crew session id` given at session start. Dev builds that touch the files you edited wait until
  you do, or until the session closes or goes quiet for 2 hours." Add the README sentence: "A live
  interactive session also holds the files it has edited (see `crew sessions`) until it closes, goes
  quiet for `session_quiet_min` (default 120 minutes) or runs `crew sessions clear`."

- [ ] **Step 4: Run** `npm test`. Expected: all tests pass. Bump both version files to 0.8.21, then
  run `node scripts/check-version.mjs`. Expected: `version 0.8.21`.

- [ ] **Step 5: Commit and open PR 2**:
  `git commit -m "dispatch: live sessions hold the files they edited (0.8.21)"`.
