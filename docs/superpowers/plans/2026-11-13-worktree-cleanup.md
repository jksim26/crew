# Worktree Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At the start of every dispatch, remove the worktrees, temp folders and branches left by
crew runs that died, without touching a live run's worktree.

**Architecture:** A worker records its worktree path in its worker file before creating the
worktree. A new `cleanOrphans()` in `lib/worktrees.mjs` reads `git worktree list --porcelain` for
this repo and removes every crew worktree that no live worker owns. `runDispatch` calls it under the
dispatch lock, and `crew stop` reuses it with an empty keep-list.

**Tech Stack:** Node 20+ ESM, `node:test`, no npm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-13-worktree-cleanup-design.md`

## Global Constraints

- No npm dependencies. Node 20+. Must work on macOS and Windows (paths via `node:path`).
- Only this repo's worktrees (from `git worktree list`). Never scan `os.tmpdir()` directly.
- Never remove a worktree a live worker on this host records as `wt`.
- Every PR that changes `lib/`, `bin/`, `skills/`, `agents/` or `.claude-plugin/` bumps the version
  in both `.claude-plugin/plugin.json` and `package.json`. This PR goes from 0.8.18 to 0.8.19.
- The branch is `feat/worktree-cleanup`. Work in a git worktree, never on `main`.

## Review Focus

- A worktree whose folder is already gone (git shows `prunable`, as on the Mac on 2026-11-13). Its
  branch must still be deleted, and nothing should throw.
- A worker on another host in the same `.crew/` (a shared drive). Its `wt` is not on this machine,
  so it must never count as a keep and never cause an error.
- Windows paths in porcelain output (`C:/Users/.../crew-dev-x/wt`). The pattern match and
  `path.dirname` must work on them.
- A git failure (`git worktree list` not ok). Cleanup does nothing, and dispatch carries on.
- A temp folder newer than the cleaning process's start. It must be kept, because another tick may
  be creating it.

---

### Task 1: `cleanOrphans` and worker `wt` recording

**Files:**
- Create: `lib/worktrees.mjs`
- Modify: `lib/dispatch.mjs` (`work()`: right after `tempHooks(config)`, before `git worktree add`;
  `runDispatch`: right after the lease check)
- Modify: `lib/stop.mjs` (replace the worktree/branch loop with `cleanOrphans`)
- Test: `test/worktrees.test.mjs`, plus the existing `test/stop.test.mjs` must still pass

**Interfaces:**
- Produces:
  `cleanOrphans({ root, run, keep = null, since = null, statMtime = (p) => fs.statSync(p).mtimeMs }) -> { worktrees: number, branches: number }`
  - `keep`: a `Set` of worktree paths to keep. `null` means "every `wt` of `liveWorkers(root)` whose
    `host === os.hostname()`".
  - `since`: an epoch ms. A temp folder with an mtime at or after it is kept. `null` means no age
    check (used by `crew stop`).
  - It removes crew worktrees whose path matches `/crew-(dev|review)-/` and that are not kept:
    - `git worktree remove --force <path>`;
    - `fs.rmSync(dirname(path), {recursive, force})` when the basename of `dirname` matches
      `/^crew-(dev|review)-/`;
    - `git branch -D <branch>` for that worktree's `branch refs/heads/...` line.

    Then it runs `git worktree prune`, and after that deletes any `crew-work/*`, `crew-sync/*` or
    `crew-review/*` branch that no remaining worktree has checked out.
  - A path that `statMtime` can't read (the folder is gone) counts as old.
- Consumes: `liveWorkers` and `beatWorker` from `lib/state.mjs`.

- [ ] **Step 1: Write the failing tests** in `test/worktrees.test.mjs`. Use the `run` stub pattern
  from `test/stop.test.mjs`. The porcelain fixture has 5 entries: the main checkout,
  `/tmp/crew-dev-live/wt` (branch `crew-work/7-1`), `/tmp/crew-dev-dead/wt` (branch `crew-work/8-1`),
  `/tmp/crew-review-gone/wt` (branch `crew-review/2026-11-13`, with a `prunable` line) and
  `/tmp/other/wt`.
  - `cleanOrphans: keeps a live worker's worktree`: with `keep = new Set(["/tmp/crew-dev-live/wt"])`,
    no call contains `remove --force /tmp/crew-dev-live/wt` and none contains `branch -D crew-work/7-1`.
  - `cleanOrphans: removes a dead run's worktree, temp folder and branch`: the calls include
    `git worktree remove --force /tmp/crew-dev-dead/wt` and `git branch -D crew-work/8-1`, and the
    returned `worktrees` is 2 (dead and gone).
  - `cleanOrphans: a prunable worktree still loses its branch`: the calls include
    `git branch -D crew-review/2026-11-13`.
  - `cleanOrphans: never touches a non-crew worktree`: no call mentions `/tmp/other`.
  - `cleanOrphans: keeps a temp folder newer than since`: with `since: 1000` and
    `statMtime = () => 2000`, nothing is removed.
  - `cleanOrphans: git list failure is a no-op`: `run` returns `{ok:false}` for `worktree list`, and
    the result is `{worktrees:0, branches:0}` with no remove call.
  - `cleanOrphans: Windows paths`: porcelain `worktree C:/Users/jk/AppData/Local/Temp/crew-dev-x/wt`
    is removed when not kept.
  - `cleanOrphans: default keep reads this host's live workers`: write `.crew/workers/7.json` with
    `{issue:7, host: os.hostname(), pid: process.pid, wt: "/tmp/crew-dev-live/wt"}`, plus
    `9.json` with `{issue:9, host:"other-host", pid:1, wt:"/tmp/crew-dev-dead/wt"}`. Called with no
    `keep`, live is kept and dead is removed.

- [ ] **Step 2: Run** `node --test test/worktrees.test.mjs`. Expected: FAIL, because
  `lib/worktrees.mjs` is not found.

- [ ] **Step 3: Implement `cleanOrphans`** in `lib/worktrees.mjs` as specified in Interfaces. Parse
  the porcelain output into blocks separated by blank lines, reading the `worktree`, `branch` and
  `prunable` lines.

- [ ] **Step 4: Run** `node --test test/worktrees.test.mjs`. Expected: PASS.

- [ ] **Step 5: Wire it in.**
  - `work()`: call `beatWorker(root, n, { wt, tmp })` right after `const wt = ...`, before `git worktree add`.
  - `runDispatch`: after the lease check and only when `!dryRun`, call
    `const c = cleanOrphans({ root, run, since: Date.now() - process.uptime() * 1000 })`. Then
    `if (c.worktrees || c.branches) logLine(root, { action: "cleanup", ...c })`.
  - `stopBatch`: replace its loop and branch deletion with
    `out.worktrees = cleanOrphans({ root, run, keep: new Set() }).worktrees`.

  Also add one test to `test/dispatch.test.mjs`, following its existing `runDispatch` stub: a dry
  run makes no `worktree remove` call, and a non-dry run with a dead `crew-dev-` worktree in the
  porcelain output makes one.

- [ ] **Step 6: Run** `npm test`. Expected: all tests pass, including `test/stop.test.mjs` unchanged.

- [ ] **Step 7: Docs and version.**
  - Add one sentence to the README "Rolling workers" paragraph: each tick also removes the worktrees
    and branches of runs that died.
  - Bump both version files to 0.8.19.
  - Run `node scripts/check-version.mjs`. Expected: `version 0.8.19`.

- [ ] **Step 8: Commit.**

```bash
git add lib/worktrees.mjs lib/dispatch.mjs lib/stop.mjs test/worktrees.test.mjs test/dispatch.test.mjs README.md package.json .claude-plugin/plugin.json docs/superpowers
git commit -m "dispatch: remove worktrees left by dead runs each tick (0.8.19)"
```
