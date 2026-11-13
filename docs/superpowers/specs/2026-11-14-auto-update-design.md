# Crew auto-update (design)

## Why

On 2026-11-13 the Mac was found running crew from two different, wrong places:

- **Scheduled jobs** (`crew watch` and the rest) run `~/code/crew/bin/crew`, the folder people and
  sessions work in. `crew schedule install` writes the path of whatever copy ran it
  (`CREW_BIN` in `lib/schedule.mjs`). That checkout had been switched to an unmerged branch
  (`feat/pm-stuck-decisions`, 0.9.0) by another session, so the unattended dev runner was running
  unreviewed code.
- **The Claude Code plugin** (skills, agents, the new session hooks) was a cached copy, 0.6.2 from
  8 Nov. It only changes when someone runs `claude plugin update crew@crew`, and nobody did. Its
  marketplace source is the directory `~/code/crew`, so an update would also install whatever
  branch is checked out there.

Nothing updates either copy on its own, so the machines drift apart and away from `main`. JK wants
merged changes to reach both machines (PC and Mac) on their own, by default.

## Goals

1. Each machine runs crew from a **runner-only copy** that is always a commit of `origin/main`.
   No person or session works in it.
2. Scheduled jobs and the plugin come from that same copy, so they are always the same version.
3. Merged changes are applied **automatically, by default**, at a safe moment, and only after they
   pass a health check. A change that fails is not applied. One whose post-switch check fails is
   rolled back on its own. *(Builder check, my call: "after the switch" means the post-switch check
   in step 5, which loads every crew module through `crew --version`. There is no probation window
   watching later job runs: telling a code fault from a project fault there is a project of its
   own, and the test run before the switch already covers what CI covers.)*
4. One Slack line per machine per version change (or failure), so JK can see both machines agree.
5. Auto-update can be switched off per machine (`crew update off`).

## Non-goals

- Updating Claude Code, node, git or gh themselves.
- Release channels (stable/beta) or staged rollout between machines. Every merge already bumps the
  version and passes CI, and there are only two machines.
- Updating project repos (that is `crew sync`'s job, unchanged).

## Anti-goals (a failure even if it works)

- An update that leaves a machine unable to run crew.
- Swapping code while a dev worker or a dispatch run is in progress.
- Touching `~/code/crew` (or any working checkout) in any way.
- A Slack line on every check. Only actual changes and failures post.

## Approaches

| | What | Trade-off |
|---|---|---|
| **A (chosen)** | A runner-only git clone per machine. Jobs and the plugin marketplace point at it; a scheduled `crew update` fast-forwards it | One-time setup per machine; relies only on git and the plugin commands crew already uses |
| B | Jobs run from the plugin's own cache via a launcher that finds the newest version; only `claude plugin update` updates | One copy, but depends on Claude Code's cache layout and on Claude Code fetching a private GitHub repo |
| C | Keep `~/code/crew` as the runner and force it to main | Rejected: people and sessions work there, so it would refuse to update or throw away work |

JK chose A on 2026-11-14, with three ideas borrowed from common auto-updaters: apply only at a
safe moment, test the new version before switching to it, and roll back automatically if it fails.

## Design

### The runner copy

- Location (my call):
  - macOS and Linux: `${XDG_DATA_HOME:-~/.local/share}/crew/runtime`.
  - Windows: `%LOCALAPPDATA%\crew\runtime`. Local, not roaming, so it never syncs between machines.
- It is a plain `git clone` of the crew repo (the `origin` URL comes from the copy running `setup`),
  on `main`.
- Machine-local state sits beside it in `crew/update.json`: `current` sha, `previous` sha,
  `bad` (a list of shas that failed their check), `last_check`, and `last_result`.

### `crew update setup` (one time per machine, run by JK)

1. Clone the runner copy, or reuse it if one is already there and clean on `main`.
2. Point the plugin at it:
   `claude plugin marketplace remove crew` (if needed), then
   `claude plugin marketplace add <runner copy>`, then `claude plugin install crew@crew`. The
   marketplace name stays `crew`, so `crew@crew` keeps working.
3. **Re-point existing crew jobs.** For every scheduled crew job on this machine (launchd plists
   `dev.crew.*`, Windows tasks under `\crew\`), rewrite only the crew program path to
   `<runner copy>/bin/crew`, and keep everything else (schedule, working folder, env, logs). The
   rewrite reuses `lib/schedule.mjs`'s own writers.
4. Install the machine-level `update` job: every 60 minutes (my call; it does nothing when up to
   date), label `dev.crew.update` or task `\crew\update`. It logs to `crew/logs/update.log` beside
   `update.json`.
5. Print what it changed. Re-running it is safe: finished steps are skipped.

From then on, `crew schedule install` always writes the runner copy's path when one exists, even
when run from `~/code/crew` or from the plugin cache, so a job never points at a working folder or a
versioned cache folder again.

### `crew update` (the scheduled run)

1. **Off switch:** if this machine says `crew update off` (a machine-local setting, like
   `crew machine set`), log "off" and stop.
2. **Fetch:** `git fetch origin main` in the runner copy. If `origin/main` equals `current`, or is
   in `bad`, stop quietly.
3. **Safe moment:** for every crew project on this machine (the working folders of its scheduled
   jobs), if any live worker file or a held `dispatch.lock` exists, stop and retry next hour. Log
   "waiting for <project> #<issue>". Nothing posts to Slack.
4. **Test the candidate first:**
   - Add a temporary git worktree of `origin/main` beside the runner copy.
   - Run `node bin/crew --version` there and check it prints the version in its `plugin.json`.
   - Run the crew test suite there (`node --test`, timeout 10 minutes).
   - Remove the worktree.
   - **Only a real failure marks the sha bad:** a failing test, or `--version` printing the wrong
     version or crashing. In that case, add the sha to `bad`, post one Slack line (`crew 0.8.22
     failed its check on mac: <first failing test or error>; staying on 0.8.21`) and stop.
   - **Anything else** (fetch error, `git worktree add` error, the 10-minute timeout) is temporary.
     Log it and retry next hour. Post one Slack line only after 3 temporary failures in a row, and
     one more when it recovers.
   - **A sha leaves `bad`** when a newer `origin/main` appears (only the newest commit is ever
     tried), or when JK runs `crew update retry`, which clears `bad` and runs now.
   *(Builder check; my call.)*
5. **Switch:**
   - Write the `updating` marker (see below), record `previous = current`, and fast-forward the
     runner copy to the tested sha. The runner copy must be clean and on `main`. If it isn't, crew
     never resets it: it posts one alert and stops.
   - Remove the marker. Run `node bin/crew --version` in the runner copy. If it doesn't print the
     new version, roll back.
6. **Plugin:** if the version changed, run `claude plugin marketplace update crew` and then
   `claude plugin update crew@crew`. A failure here does not roll back the runner (jobs are fine);
   it posts one line and is retried on the next run, because `last_result` records "plugin
   pending".
7. **Report:** one Slack line, for example `crew 0.8.21 → 0.8.22 on mac`, and the same line in the
   log.

**Rollback** (from step 5, or `crew update rollback` by hand): `git reset --hard <previous>` in the
runner copy only. This is the one place crew resets anything, and it is safe because nobody works
there. Then bring the plugin back to the same version:
1. Run `claude plugin marketplace update crew` and `claude plugin update crew@crew`.
2. Check the installed version with `claude plugin list`.
3. If it is still the newer one (the update command may not go down a version), run
   `claude plugin uninstall crew@crew` and then `claude plugin install crew@crew`. Crew's plugin has
   no user settings to lose. It is installed at user scope, so the reinstall leaves it enabled.

Then add the failed sha to `bad` and post one line. *(Builder check, my call: jobs and plugin must
never be left on different versions.)*

**Live sessions during a plugin swap (my call):** the plugin is updated even while Claude sessions
are open. JK keeps sessions open for hours, so waiting for none to be open would mean never
updating. An open session keeps the hooks of the version it started with. If that version's cache
folder is removed, its hook fails to start, which exits 1, and Claude Code doesn't treat exit 1 as
blocking. Sessions started after the swap get the new version. *(Builder check.)*

**The `updating` marker:** `crew/updating` with a timestamp. `crew watch` and `crew dispatch` skip
their tick while it exists and is under 5 minutes old, so no run starts mid-switch.

**Where Slack lines go:** the Slack channel of each crew project on this machine that has one,
de-duplicated by channel, using the existing news sender. With no Slack, only the log.

### Other commands

- `crew update status`: the runner copy's path, version and sha, `origin/main`'s version, the last
  result, the `bad` list, and whether auto-update is on.
- `crew update off` / `crew update on`: the per-machine switch.
- `crew update now`: run the steps above once, ignoring the hourly schedule but not the safe
  moment.
- `crew update retry`: clear `bad` and run now.
- **The `crew` people type:** inside Claude sessions, `crew` on PATH is the plugin's copy, so it
  follows the plugin and therefore the runner copy. A `crew` run by hand from `~/code/crew` stays
  whatever that checkout is, which is the point of a working folder. `crew doctor` warns when the
  `crew` being run is not the runner copy and the two versions differ. Setup doesn't change PATH.
  *(Builder check; my call.)*
- `crew doctor`: new checks. It warns when jobs point outside the runner copy, when the plugin
  marketplace isn't the runner copy, or when the runner copy is behind `origin/main` by more than a
  day.

## Constraints

- No npm dependencies. Node 20+, macOS and Windows.
- Uses the existing git, `gh`, `claude` and Slack plumbing (`lib/exec.mjs`, `lib/slack.mjs`
  news, `lib/schedule.mjs` writers, `lib/secrets.mjs` machine-local settings).
- The runner copy needs read access to the private repo with the same git credentials `crew sync`
  already uses.

## Left to the builder

- Module and function names (for example `lib/update.mjs`).
- How the job rewrite reads the existing plist or task definition.
- The exact wording of log lines.
- How tests fake git, `claude`, and the scheduler (follow the existing `run` stub pattern).
