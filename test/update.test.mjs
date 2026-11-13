import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  updateHome, runnerDir, readUpdateState, writeUpdateState, autoUpdateOn, setAutoUpdate,
  markUpdating, clearUpdating, updatingNow,
} from "../lib/update.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "crew-upd-"));
const envFor = (dir = tmp()) => ({ XDG_DATA_HOME: dir, LOCALAPPDATA: dir, XDG_CONFIG_HOME: path.join(dir, "cfg"), APPDATA: path.join(dir, "cfg") });

test("updateHome: per platform", () => {
  const dir = tmp();
  assert.equal(updateHome({ XDG_DATA_HOME: dir }, "darwin"), path.join(dir, "crew"));
  assert.equal(updateHome({ LOCALAPPDATA: "C:\\L" }, "win32"), path.join("C:\\L", "crew"));
  assert.ok(updateHome({}, "darwin").endsWith(path.join(".local", "share", "crew")));
  assert.equal(runnerDir({ XDG_DATA_HOME: dir }, "darwin"), path.join(dir, "crew", "runtime"));
});

test("update state: defaults, then round-trip", () => {
  const env = envFor();
  assert.deepEqual(readUpdateState(env, "darwin"), { current: null, previous: null, bad: [], last_check: null, last_result: null, temp_failures: 0, plugin_pending: false });
  const s = { current: "b", previous: "a", bad: ["x"], last_check: "2026-11-14T00:00:00.000Z", last_result: "updated", temp_failures: 1, plugin_pending: true };
  writeUpdateState(s, env, "darwin");
  assert.deepEqual(readUpdateState(env, "darwin"), s);
});

test("auto-update: on by default, off and on again", () => {
  const env = envFor();
  assert.equal(autoUpdateOn(env, "darwin"), true);
  setAutoUpdate(false, { env, platform: "darwin" });
  assert.equal(autoUpdateOn(env, "darwin"), false);
  setAutoUpdate(true, { env, platform: "darwin" });
  assert.equal(autoUpdateOn(env, "darwin"), true);
});

test("updating marker: honoured for 5 minutes", () => {
  const env = envFor();
  const t0 = new Date("2026-11-14T10:00:00Z");
  assert.equal(updatingNow(env, "darwin", t0.getTime()), false);
  markUpdating(env, "darwin", t0);
  assert.equal(updatingNow(env, "darwin", t0.getTime() + 4 * 60_000), true);
  assert.equal(updatingNow(env, "darwin", t0.getTime() + 6 * 60_000), false);
  clearUpdating(env, "darwin");
  assert.equal(updatingNow(env, "darwin", t0.getTime() + 60_000), false);
});
