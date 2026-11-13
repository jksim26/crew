# Crew Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each machine runs crew (scheduled jobs and the plugin) from a runner-only clone on
`origin/main`. An hourly `crew update` moves it forward on its own, at a safe moment, after testing
the new version first, with rollback and one Slack line per change.

**Architecture:**
- `lib/update.mjs` owns the runner clone, its state file, the off switch, the `updating` marker, the
  update run and rollback.
- `lib/schedule.mjs` learns to find this machine's crew jobs, re-point them at the runner clone, and
  plan the machine-level `update` job.
- The CLI gets `crew update [setup|status|on|off|now|retry|rollback]`. `crew doctor` gets three
  checks.

**Tech Stack:** Node 20+ ESM, `node:test`, git, `claude plugin` CLI, launchd and Task Scheduler. No
npm dependencies.

**Spec:** `docs/superpowers/specs/2026-11-14-auto-update-design.md`

## Global Constraints

- No npm dependencies. Node 20+. macOS and Windows.
- Never touch a working checkout (`~/code/crew` or any project). The only `git reset --hard` is in
  the runner clone, in rollback.
- Runner home:
  - macOS/Linux: `${XDG_DATA_HOME:-~/.local/share}/crew`.
  - Windows: `%LOCALAPPDATA%\crew` (fallback `~/AppData/Local/crew`).
  - Inside it: the runner clone `runtime/`, the state file `update.json`, the marker `updating`, and
    the log `logs/update.log`.
- The off switch is the machine-local setting `CREW_AUTO_UPDATE` (`readLocal`/`saveLocal`). The
  value `"off"` means off; anything else, including unset, means on.
- The update job runs every 60 minutes: label `dev.crew.update` on macOS, task `\crew\update` on
  Windows.
- A sha is bad only after a failing test or a failing/wrong `--version`. Other errors are temporary:
  post after 3 in a row, and once more on recovery.
- The test timeout is 10 minutes. The marker is honoured for 5 minutes.
- Version goes from 0.8.21 to 0.8.22 in `.claude-plugin/plugin.json` and `package.json`. Branch:
  `feat/auto-update` (worktree `../crew-wt-update`).

## Review Focus

- **The runner clone is dirty or not on `main`** (someone edited it). The update must stop with one
  alert and never reset or stash.
- **Two `crew update` runs overlap** (a slow test run plus the next hourly start). Only one may
  switch; the other exits quietly.
- **A project folder from a job no longer exists** (a deleted repo whose job is still installed).
  The safe-moment check and Slack lookup skip it without failing the run.
- **`claude` is missing from the job's PATH.** The code switch still succeeds, the plugin is marked
  pending, and the next run retries.
- **Windows paths with spaces** in the runner path (`C:\Users\J K\AppData\Local\crew\runtime`). The
  re-pointed task line must keep its quoting.

---

### Task 1: Runner home, state, off switch and the `updating` marker

**Files:**
- Create: `lib/update.mjs`
- Modify: `lib/watch.mjs` (start of `runWatch`), `lib/dispatch.mjs` (start of `runDispatch`, before
  the lock)
- Test: `test/update.test.mjs`, plus one case each in `test/slack-watch.test.mjs` and
  `test/dispatch.test.mjs`

**Interfaces (Produces, all in `lib/update.mjs`):**
- `updateHome(env = process.env, platform = process.platform) -> string`
- `runnerDir(env, platform) -> string`: `<home>/runtime`
- `readUpdateState(env, platform) -> { current: string|null, previous: string|null, bad: string[], last_check: string|null, last_result: string|null, temp_failures: number, plugin_pending: boolean }`,
  with those defaults when the file is missing.
- `writeUpdateState(state, env, platform) -> void` (atomic, via `writeJson`)
- `autoUpdateOn(env, platform) -> boolean`, and
  `setAutoUpdate(on: boolean, { env, platform }) -> void`
- `markUpdating(env, platform, now = new Date()) -> void`, `clearUpdating(env, platform) -> void`,
  and `updatingNow(env, platform, now = Date.now()) -> boolean` (true when the marker exists and is
  under 5 minutes old)

- [ ] **Step 1: Write failing tests** in `test/update.test.mjs`, with `env = { XDG_DATA_HOME: tmp, LOCALAPPDATA: tmp }`:
  - `updateHome: per platform`:
    - `updateHome(env, "darwin")` is `path.join(tmp, "crew")`;
    - `updateHome({LOCALAPPDATA: "C:\\L"}, "win32")` is `path.join("C:\\L", "crew")`;
    - with an empty env on darwin, it ends with `path.join(".local", "share", "crew")`.
  - `update state: defaults, then round-trip`: a missing file gives
    `{current:null, previous:null, bad:[], last_check:null, last_result:null, temp_failures:0, plugin_pending:false}`,
    and a written state reads back equal.
  - `auto-update: on by default, off and on again`, using a temp secrets env (`XDG_CONFIG_HOME`).
  - `updating marker: honoured for 5 minutes`: true at +4 min, false at +6 min, false after
    `clearUpdating`.
  - In `test/slack-watch.test.mjs`: `watch: skips the tick while crew is updating`. With a fresh
    marker in `env`, `runWatch` returns `{ skipped: "crew is updating" }` and calls neither dispatch
    nor board.
  - In `test/dispatch.test.mjs`: `dispatch: skips while crew is updating`. The result `action` is
    `"updating"`, and no `gh` call is made.
- [ ] **Step 2: Run** `node --test test/update.test.mjs test/slack-watch.test.mjs test/dispatch.test.mjs`.
  Expected: FAIL (module missing, and new cases fail).
- [ ] **Step 3: Implement** the Interfaces. Add the early return to `runWatch` and `runDispatch`
  (dispatch returns through `done(root, { action: "updating", why: "crew is updating" })`).
- [ ] **Step 4: Run** `npm test`. Expected: all tests pass.
- [ ] **Step 5: Commit** `update: runner home, state, off switch and updating marker`.

### Task 2: Find, re-point and plan crew jobs

**Files:**
- Modify: `lib/schedule.mjs`
- Test: `test/schedule.test.mjs`

**Interfaces:**
- Consumes: `runnerDir` and `updateHome` (Task 1).
- Produces (in `lib/schedule.mjs`):
  - `crewJobs({ platform = process.platform, run = realRun, home = os.homedir() }) -> Array<{ name: string, root: string, file: string }>`:
    - macOS: every `<home>/Library/LaunchAgents/dev.crew.*.plist`, with `root` from its
      `WorkingDirectory` string.
    - Windows: every task from `schtasks /Query /FO CSV /V` whose TaskName starts with `\crew\`,
      with `root` from the "Start In" column and `file` = `<root>/.crew/schedule/<name>.ps1`.
    - The `update` job is excluded.
  - `repointJob(job, bin, { platform, run }) -> { changed: boolean }`: in the job's file, replace the
    crew program path (macOS: the `<string>` right after the node `<string>` in `ProgramArguments`;
    Windows: the second quoted path in the `cmd.exe` argument line) with `bin`. Then reload it
    (macOS: `launchctl bootout` then `bootstrap`; Windows: run the `.ps1`). It is unchanged when the
    path already equals `bin`.
  - `effectiveBin(env = process.env, platform = process.platform) -> string`: `<runnerDir>/bin/crew`
    when that file exists, else `CREW_BIN`. `planJob` uses it as the default `bin` from now on.
  - `planUpdateJob({ env, platform, run }) -> plan`: the same shape as `planJob`; `every: 60`,
    `args: ["update"]`, working folder = `updateHome`, log `<home>/logs/update.log`, label
    `dev.crew.update` / task name `update`, Windows `instances: "IgnoreNew"`, limit 30 minutes.

- [ ] **Step 1: Write failing tests** in `test/schedule.test.mjs`:
  - `crewJobs: finds launchd jobs and their folders`: in a temp `home`, write two plists from
    `launchdPlist(...)` (`dev.crew.proj-watch` with root `/r/proj`, and `dev.crew.update`). Expect
    exactly `[{ name: "dev.crew.proj-watch", root: "/r/proj", file: <that plist> }]`.
  - `crewJobs: finds Windows tasks from schtasks CSV`: a fake `run` returns a CSV with `\crew\proj-watch`
    (Start In `C:\r\proj`) and `\Microsoft\other`. Expect one job, with
    `file = path.join("C:\\r\\proj", ".crew", "schedule", "proj-watch.ps1")`.
  - `repointJob: macOS swaps only the crew path and reloads`: from a plist with bin
    `/old/crew/bin/crew`, `repointJob(job, "/rt/bin/crew", {platform:"darwin", run})` leaves the file
    containing `<string>/rt/bin/crew</string>`, with node, args and WorkingDirectory unchanged, and
    the calls include `launchctl bootstrap`. A second call returns `{changed:false}`.
  - `repointJob: Windows keeps quoting with spaces`: start from the `windowsScript(...)` output with
    bin `C:\old\bin\crew`; after
    `repointJob(job, "C:\\Users\\J K\\AppData\\Local\\crew\\runtime\\bin\\crew", {platform:"win32", run})`
    the script contains `\"C:\\Users\\J K\\AppData\\Local\\crew\\runtime\\bin\\crew\" watch`, and
    `powershell ... -File <ps1>` was called.
  - `planUpdateJob: hourly, machine-level`: on darwin, `name === "dev.crew.update"`, the text
    contains `<integer>3600</integer>` and `<string>update</string>`, and `logFile` ends with
    `path.join("logs","update.log")`.
  - `effectiveBin: prefers the runner clone`: with `runtime/bin/crew` created under a temp
    `XDG_DATA_HOME`, it returns that path. Without it, it returns `CREW_BIN`.
- [ ] **Step 2: Run** `node --test test/schedule.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces. `planJob` gains `bin = effectiveBin(env, platform)` and
  passes it to both writers.
- [ ] **Step 4: Run** `npm test`. Expected: all tests pass.
- [ ] **Step 5: Commit** `schedule: find and re-point crew jobs; machine-level update job`.

### Task 3: The update run, plugin sync and rollback

**Files:**
- Modify: `lib/update.mjs`
- Test: `test/update.test.mjs`

**Interfaces:**
- Consumes: Task 1's state, marker and switch; Task 2's `crewJobs`; `liveWorkers` and `readJson`
  (`lib/state.mjs`); `loadConfig` (`lib/config.mjs`); `postNews` (`lib/slack.mjs`).
- Produces (in `lib/update.mjs`):
  - `runUpdate({ env, platform, run, now = new Date(), post = postNews, fetchImpl, jobs = crewJobs, machine = thisMachine(env) }) -> Promise<{ outcome: "off"|"current"|"bad"|"waiting"|"failed"|"temporary"|"updated"|"rolled-back"|"dirty"|"busy", from?: string, to?: string, detail?: string }>`:
    the spec's steps 1 to 7.
    - Only one run at a time: `withFileLock` on the home (busy means exit quietly).
    - The candidate is a temporary worktree from `git -C <runner> worktree add --detach <tmp> origin/main`.
    - The version comes from the candidate's `.claude-plugin/plugin.json`.
    - The test runs `node --test` with `cwd` set to the candidate, `timeoutMs: 600_000`.
  - `syncPlugin({ version, run }) -> { ok: boolean, detail: string }`:
    1. `claude plugin marketplace update crew`;
    2. `claude plugin update crew@crew`;
    3. read `claude plugin list --json`, find `id === "crew@crew"`;
    4. if its version is not `version`, run `claude plugin uninstall crew@crew` and
       `claude plugin install crew@crew`, then read the list again.
  - `rollbackUpdate({ env, platform, run, reason }) -> { ok: boolean, to: string|null }`:
    `git reset --hard <previous>` in the runner, then `syncPlugin`, add the failed sha to `bad`,
    swap current and previous.
  - `notify(text, { jobs, post, env, fetchImpl })`: posts to each distinct `slack.channel` among the
    projects whose config has `slack.news`. Projects whose folder or config is missing are skipped.
- Slack line copy (exact):
  - `crew <from> → <to> on <machine>`
  - `crew <to> failed its check on <machine>: <first line of the failure>; staying on <from>`
  - `crew <to> rolled back on <machine>: <reason>; back on <from>`
  - `crew update on <machine> keeps failing: <detail>` (after 3 temporary failures)
  - `crew update on <machine> is working again`
  - `crew runner on <machine> has local changes; not updating (see crew update status)`
  - `crew <to> on <machine>: plugin update pending (<detail>)`
  - `<machine>` falls back to `os.hostname()`.

- [ ] **Step 1: Write failing tests** with a fake `run` that models git (rev-parse, fetch, status,
  worktree add/remove, merge --ff-only, reset), `node` (`--version` prints the candidate version;
  `--test` passes or fails on demand) and `claude` (the plugin list JSON is settable):
  - `update: off does nothing`: `setAutoUpdate(false)`, giving outcome `"off"` and no git calls.
  - `update: current when origin/main is unchanged`: outcome `"current"`, no worktree add, no post.
  - `update: a bad sha is not retried`: origin sha in `bad`, giving `"bad"` with no test run.
  - `update: waits while a worker runs`: a project root with a live worker file on this host gives
    `"waiting"`, no switch, and no post.
  - `update: a dispatch lock held by a live pid waits` (same expectations).
  - `update: tests fail, so the sha is bad and one alert is sent`: `"failed"`, the sha is in `bad`,
    the runner is not moved, and there is one post matching
    `/^crew 0\.8\.23 failed its check on mac: .+; staying on 0\.8\.22$/`.
  - `update: success switches, syncs the plugin and posts once`: `"updated"`; `merge --ff-only` ran
    in the runner; `previous` is the old sha and `current` the new one; the plugin calls happened;
    and the posts equal `["crew 0.8.22 → 0.8.23 on mac"]`.
  - `update: post-switch --version mismatch rolls back`: `"rolled-back"`, `reset --hard <old>` ran,
    and the new sha is in `bad`.
  - `update: a dirty runner is never reset`: `git status --porcelain` is non-empty, giving
    `"dirty"`, no merge or reset, and one alert.
  - `update: temporary failures alert on the third, recovery once`: fetch fails three times (one post
    only on the third), then succeeds (one "working again" post).
  - `update: claude missing marks the plugin pending, next run retries`: the code switch succeeds,
    `plugin_pending` is true, and the next run with an unchanged origin calls `syncPlugin` again.
  - `update: two runs at once, the second is busy`: hold the home lock and expect `"busy"`.
  - `update: a deleted project folder is skipped`: a job whose root is missing gives no throw, and
    the run continues.
  - `syncPlugin: downgrade falls back to reinstall`: the list still shows the newer version after
    update, and the calls include `plugin uninstall crew@crew` then `plugin install crew@crew`.
  - `update: the marker exists only during the switch`: `updatingNow` is true when observed inside
    the fake `merge --ff-only` call, and false after the run.
- [ ] **Step 2: Run** `node --test test/update.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces, following the spec's step order exactly.
- [ ] **Step 4: Run** `npm test`. Expected: all tests pass.
- [ ] **Step 5: Commit** `update: test-first switch, plugin sync, rollback and Slack lines`.

### Task 4: `crew update` commands, setup, doctor, docs and version

**Files:**
- Modify: `lib/cli.mjs` (the `update` command, before `projectContext`, which it doesn't need; help
  text), `lib/doctor.mjs`, `README.md`, `.claude-plugin/plugin.json`, `package.json`
- Modify: `lib/update.mjs` (`setupUpdate`, `updateStatus`)
- Test: `test/update.test.mjs`, `test/doctor.test.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `setupUpdate({ env, platform, run, origin }) -> { steps: Array<{ step: string, done: "made"|"already" }> }`:
    1. clone `origin` (the running copy's `git remote get-url origin`) into the runner dir, or keep
       it when it is a clean clone on `main`, and throw a clear error when it is dirty or on another
       branch;
    2. `claude plugin marketplace remove crew` (ignore failure), then
       `claude plugin marketplace add <runner>`, then `claude plugin install crew@crew`;
    3. `repointJob(j, <runner>/bin/crew)` for every `crewJobs()` entry;
    4. `installJob(planUpdateJob(...))`;
    5. write the state with `current` = the runner HEAD.
  - `updateStatus({ env, platform, run }) -> string`: the lines `runner`, `version`, `sha`,
    `origin/main`, `last`, `bad`, `auto-update on|off`, `plugin pending: yes|no`.
  - CLI:
    - `crew update` and `crew update now` run `runUpdate` and print the outcome and detail. They
      exit 0 except on `"failed"`, `"rolled-back"` or `"dirty"`, which exit 1, so the scheduler
      shows a failure.
    - `crew update setup | status | on | off | retry | rollback`. `retry` clears `bad` and runs now.
  - `doctor` adds four checks, all `warn`, never `fail`:
    - `runner`: the jobs (from `crewJobs`) point outside the runner clone;
    - `plugin source`: `claude plugin marketplace list --json` shows `crew` not pointing at the
      runner;
    - `runner age`: `last_check` is older than 24 h, or the runner is behind `origin/main` with no
      update in 24 h;
    - `this crew`: the running copy is not the runner clone and its version differs from the
      runner's.

    Each says `run: crew update setup` when there is no runner.

- [ ] **Step 1: Write failing tests**:
  - `setupUpdate: fresh machine`: with a fake `run`, the steps are all `"made"`, the clone runs, the
    marketplace calls run in order, every job is re-pointed, and the update job is installed.
  - `setupUpdate: re-run is safe`: every step is `"already"` and nothing is re-installed.
  - `setupUpdate: refuses a dirty runner`: it throws `/runner .* has local changes/`.
  - `cli: update exits 1 when the check failed`.
  - `cli: update off/on`: status prints `auto-update off`, then `auto-update on`.
  - `doctor: warns when jobs run outside the runner`, with the detail containing
    `crew update setup`.
- [ ] **Step 2: Run** `node --test test/update.test.mjs test/doctor.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add a README section "Updates", 8 to 12 lines on what setup does, the
  hourly job, the off switch, the Slack lines, and `status`/`retry`/`rollback`. Bump the version to
  0.8.22.
- [ ] **Step 4: Run** `npm test` and `node scripts/check-version.mjs origin/main`. Expected: all
  tests pass, and `version 0.8.21 -> 0.8.22`.
- [ ] **Step 5: Manual check on the Mac** (no live changes):
  1. `node bin/crew update status` prints `runner` with "not set up" and `auto-update on`.
  2. `node bin/crew doctor` shows the three runner warnings, each saying `crew update setup`.
  3. `node -e 'import("./lib/schedule.mjs").then(m=>console.log(m.planUpdateJob({}).text))'`
     prints a plist with label `dev.crew.update`, `StartInterval` 3600 and args `update`.

  Do **not** run `crew update setup` on the Mac from the branch: it re-points the live jobs and the
  plugin. JK runs setup after merge.
- [ ] **Step 6: Commit** `update: crew update commands, setup and doctor checks (0.8.22)`.
