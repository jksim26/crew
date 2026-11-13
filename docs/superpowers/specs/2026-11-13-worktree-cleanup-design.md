# Worktree cleanup for dead runs (short design)

## Why

On 2026-11-13 the Mac ran out of disk space and then went down without a clean shutdown.
Every crew run makes a git worktree in the temp folder (`crew-dev-*`, `crew-review-*`). For
books-reading-app each one holds a full `backend-rs` Rust build (the main checkout's build folder is
3.3 GB). A run cleans up its worktree in a `finally` block. A run that is killed (a reboot, the
"no space left" crash, a timeout kill) never reaches that block, so its worktree and branch stay
until someone runs `crew stop`. Two worktrees were left behind that night.

## Goal

Each `crew watch` tick removes the worktrees, branches and temp folders left by runs that are no
longer alive, so a killed run can't hold disk space past the next tick.

- **Non-goals:** a free-space check before runs, and sharing one Rust build folder between workers.
  Both are separate changes.
- **Anti-goal:** removing a worktree a live run is still using, in this repo or any other repo on
  the machine.

## Approaches

1. **Clean up at the start of each dispatch, under the dispatch lock (chosen).** This reuses the
   loop that `crew stop` already has, but keeps every worktree a live worker owns.
2. **Clean up only at boot (launchd/Task Scheduler at login).** This misses runs that die while the
   machine stays up, such as the "no space left" crash.
3. **Move worktrees out of the temp folder into `.crew/wt/`.** It's easier to find them, but this
   changes every run path and still needs the same cleanup.

## Design

- **Record the worktree before making it.** In `work()`, write the worktree path into the worker
  file (`beatWorker(root, n, { wt, tmp })`) *before* `git worktree add`. A worker's worktree is
  then never unrecorded. `syncPlain` is short and holds no worker file; it runs inside the same tick
  process, so cleanup must skip any worktree whose temp folder is younger than the tick's own start.
- **Clean up in `runDispatch`, right after taking the lock and before planning.** List
  `git worktree list --porcelain` for this repo only. A worktree is an orphan when all of these
  hold:
  - its path matches `crew-(dev|review)-`;
  - no live worker on this host records it as `wt`;
  - its temp folder is older than this process's start.

  Review runs hold the same lock for their whole run, so none can be running while the lock is
  held. For each orphan:
  - `git worktree remove --force`;
  - delete its temp folder (the `crew-dev-XXXX` parent);
  - delete its `crew-work/*`, `crew-sync/*` or `crew-review/*` branch;
  - then run `git worktree prune` once.
- **Only this repo's worktrees.** Never scan the temp folder directly: other repos' crew runs share
  it.
- **Log it:** `logLine({ action: "cleanup", worktrees: n, branches: m })` when anything was
  removed. No Slack line.
- **Factor the loop out of `stop.mjs`** into one function that both use. `crew stop` keeps its
  "remove everything" behaviour by passing an empty keep-list.
- **Tests (node --test):**
  - a live worker's worktree is kept;
  - a dead worker's worktree, temp folder and branch are removed;
  - a worktree of another repo is never touched;
  - `crew stop` still removes all of them.

## Left to the builder

The function's name and file, and how to fake `git worktree list` in tests (follow the existing
`run` stub pattern).
