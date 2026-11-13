# Session monitoring (design)

## Why

Crew sees only the headless jobs it starts (`.crew/workers/*.json`). Interactive Claude Code
sessions (role sessions such as trade and ops, or any session opened in a crew repo) are invisible to
it unless one runs `crew lease on` by hand, and the lease then stops *all* dev for 2 hours. JK's
work breaks "all the time", and one cause is a session and a dev worker changing the same files
without either knowing. He also wants to see what is open on each machine, next to the workers.

## Goals

1. Every interactive Claude Code session working in a crew repo shows up, on the machine it runs on,
   in `crew workers` / `crew sessions` and on the Slack board, with:
   - the machine;
   - the folder;
   - how long it has been open;
   - when it was last active;
   - how many files it has edited.
2. A dev build waits while a live session has edited a file that build will change. Builds that
   don't touch those files still run (the same rule the overlap guard already applies to open PRs and
   running workers).
3. Closed, crashed or long-quiet sessions drop off on their own.

## Non-goals

- Controlling sessions: stopping, messaging, or reading their transcripts.
- Seeing sessions on other machines. Each machine sees its own sessions, as with workers today.
- Replacing `crew lease`. It stays for "keep dev away completely".

## Anti-goals (a failure even if it works)

- A hook that slows a session down, prints into it, or makes it fail. Hooks must be quick, silent
  and always exit 0.
- Dev starved forever because a session sits open for days holding files. A quiet session lets go.
- Crew's own headless runs (dev, implementer, reviewer, pm) showing up as sessions.

## Approaches

| | What | Trade-off |
|---|---|---|
| A | Show only | Visibility, but collisions continue |
| **B (chosen)** | Show, and sessions' edited files hold off overlapping builds | More to build; targets the actual collision without stopping all dev |
| C | Show, and any open session takes the lease | Simplest; dev would almost never run, since sessions stay open for hours (5 at once on 2026-11-13) |

JK asked for session monitoring after A, B and C were laid out, without naming one. B was my
recommendation, so this design builds B, shipped in two parts: part 1 is A, and part 2 adds the
overlap hold. Each part is its own PR.

## Design

### Part 1: sessions are recorded and shown

**Hooks shipped by the plugin.** Add `hooks/hooks.json` to the plugin. Every hook runs
`node "${CLAUDE_PLUGIN_ROOT}/bin/crew" session-hook <event>`, which reads the hook's JSON from stdin
(`session_id`, `cwd`, `source`, `tool_name`, `tool_input`).

| Event | Effect |
|---|---|
| `SessionStart` (startup, resume, clear, compact) | Create or refresh the session file. A resume keeps the same `session_id`, so the file and its files list carry over |
| `UserPromptSubmit` | Refresh `updated` |
| `PostToolUse` matching `Edit\|Write\|MultiEdit\|NotebookEdit` | Add the edited path to `files` and refresh `updated` |
| `SessionEnd` | Delete the session file |

**Rules for the hook command:**
- Find the crew repo by walking up from `cwd` to a folder with `.claude/crew.json`. When `cwd` is a
  git worktree, map it to the main checkout with `git rev-parse --git-common-dir`. If no crew repo is
  found, exit 0 at once.
- Exit 0 at once when `CREW_AGENT=1` is set. Nothing sets it today. Add it in `claudeEnv()`
  (`lib/pm.mjs`), which every crew-launched `claude` already goes through: pm, the canary, and dev
  and review via `agentEnv()`. That way crew's own runs never record themselves. Codex does not load
  Claude plugins, so it needs nothing. *(Builder check; my call.)*
- Never exit non-zero, and swallow every error. Errors go to `.crew/logs/session-hook.log`. The
  only output is from `SessionStart`: a `hookSpecificOutput.additionalContext` line,
  `crew session id: <id>`, so the model in that session knows its own id for `/crew:handoff`. Every
  other event prints nothing. *(Builder check; my call: two sessions can share one folder, as two
  claude-trading-team sessions did on 2026-11-13, so clearing "the session in this folder" would
  hit the wrong one.)*
- Keep it fast. Write a small JSON file with the same temp-file-and-rename write the worker files
  use, and make no `gh` or network call. Target under 150 ms on the Mac.

**The session file** is `.crew/sessions/<session_id>.json`, in the main checkout's `.crew/`:

```json
{ "id": "3e84…", "host": "Mac", "machine": "mac", "cwd": "/Users/jksim/code/crew",
  "worktree": null, "started": "…", "updated": "…", "files": ["lib/state.mjs"] }
```

- `files` are repo-relative paths (relative to the worktree root when the session is in a worktree),
  deduplicated. Only edited files count; reads don't.
- `machine` is the crew machine name (`crew machine set`), or null.

**Liveness.** `liveSessions(root)` returns only the session files on this host whose `updated` is
within `session_quiet_min` (default 120, the same as the lease). It deletes older files on this host
as it goes. Files from another host are neither returned nor deleted. They can only exist if a repo
folder sits on a shared or synced drive (for example the PC share mounted at `/Volumes/sim`), and
that host owns them. So `crew sessions`, the board and the part 2 holds are all this-host only.
*(Builder check; my call.)* A crash with no `SessionEnd` therefore expires after 2 quiet hours. No pid is recorded: the
hook's parent chain differs per platform and per app, so it is not a reliable handle.

**Where sessions show.**
- `crew sessions [--json]` lists them.
- `crew sessions clear [<id>|--all]` deletes them, so you can let go of held files without closing a
  session.
- `crew workers` prints a Sessions block after the workers.
- The Slack board and the canvas markdown get a section after Workers. One line per session:
  `🧑‍💻 *Sessions* (2) · open on this machine`
  `• mac · crew · open 42m · active 3m ago · 4 files`
- Include the sessions in `boardHash`, with the same 10-minute bucket as workers, so a session
  opening or closing refreshes the board.

### Part 2: sessions hold their edited files

- In dispatch planning, add each live session (from `liveSessions`) to the overlap `holders` as
  `{ label: "session on mac (crew)", issue: null, files }`. `overlapWith` already skips exempt files
  and reports the hit.
- The skipped reason reads like the PR one: `waits for a session on mac (both change lib/state.mjs)`.
- A session with no edited files holds nothing.
- Sessions in the main checkout and sessions in their own git worktree both hold. A worktree
  session's edits sit on a branch that will become a PR, and a PR already holds its files today, so a
  build that starts first would conflict with it later. The `worktree` field is shown on the board
  only. *(Builder check; my call.)*
- The hold ends when the session closes, goes quiet for `session_quiet_min`, or is cleared with
  `crew sessions clear`.
- `/crew:handoff` adds one step: after the lease, run `crew sessions clear <this session>` so the
  files are freed even if the app keeps the session open.
- The README overlap-guard paragraph gets one sentence on sessions.

### Config

`"session_quiet_min": 120` (optional, a whole number from 10 to 1440), validated in `config.mjs`
like the other settings.

### Tests (node --test)

- The hook ignores non-crew folders and `CREW_AGENT=1`.
- The hook maps a worktree back to the main checkout.
- The hook dedupes files and writes atomically.
- `SessionEnd` deletes the file.
- `liveSessions` expires files older than `session_quiet_min`, and neither returns nor deletes other
  hosts' files.
- `claudeEnv()` sets `CREW_AGENT=1`.
- `SessionStart` prints the id as additional context, and other events print nothing.
- Board lines and the board hash include sessions.
- Overlap: a session edit blocks an overlapping build, does not block a non-overlapping one, and
  exempt files don't count.

## Constraints

- No npm dependencies. Node 20+, macOS and Windows.
- Hook commands must work from the plugin cache path on both platforms, with
  `${CLAUDE_PLUGIN_ROOT}` quoted.
- The state is machine-local, as with workers. A PC-run dispatch does not see Mac sessions.

## Left to the builder

- The function and module names (for example `lib/sessions.mjs`).
- The exact board wording within the shape above.
- How to fake hook stdin in tests.
- Whether `crew workers --json` nests sessions or keeps them separate.
