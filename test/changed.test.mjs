import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalize } from "../lib/config.mjs";
import { gh } from "../lib/gh.mjs";
import { beginWorker, beatWorker, endWorker } from "../lib/state.mjs";
import { runWatch } from "../lib/watch.mjs";
import { onBoardChange } from "../lib/changed.mjs";

const config = normalize({ repo: "jk/proj", owner_login: "jk", slack: { channel: "C0123ABCD" } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "crew-live-"));
const ok = () => ({ ok: true, stdout: "", stderr: "" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("live board: crew's label and PR writes redraw the board mid-tick, reads do not", async () => {
  const draws = [];
  await runWatch({
    root: tmp(), config, env: {}, liveMs: 5,
    dispatch: async () => {
      gh(ok, ["issue", "list", "--repo", "jk/proj"]);
      await sleep(30);
      assert.equal(draws.length, 0, "a read leaves the board alone");
      gh(ok, ["issue", "edit", "7", "--add-label", "doing"]);
      gh(ok, ["pr", "create", "--repo", "jk/proj"]);
      await sleep(30);
      assert.equal(draws.length, 1, "a burst of writes is one redraw, before the batch ends");
      return { action: "idle" };
    },
    board: async () => (draws.push("board"), { action: "updated" }),
    news: async () => ({ ok: true }),
  });
  assert.equal(draws.length, 2, "plus the end-of-tick redraw");
});

test("live board: worker phase changes redraw; a heartbeat without a phase does not", async () => {
  const root = tmp();
  let draws = 0;
  const stop = onBoardChange(async () => { draws++; }, 5);
  try {
    beginWorker(root, 3, { kind: "build" });
    await sleep(20);
    beatWorker(root, 3, { wt: "/x" });
    await sleep(20);
    assert.equal(draws, 1);
    beatWorker(root, 3, { phase: "running tests" });
    await sleep(20);
    endWorker(root, 3);
    await sleep(20);
    assert.equal(draws, 3);
  } finally { stop(); }
});

test("live board: a change during a redraw gets one more redraw after it", async () => {
  let draws = 0;
  let release;
  const stop = onBoardChange(async () => { draws++; if (draws === 1) await new Promise((r) => (release = r)); }, 5);
  try {
    gh(ok, ["issue", "close", "1"]);
    await sleep(20);
    gh(ok, ["issue", "edit", "2"]);
    gh(ok, ["issue", "edit", "3"]);
    release();
    await sleep(30);
    assert.equal(draws, 2);
  } finally { stop(); }
});

test("live board: nothing is redrawn after the tick ends or with the board off", async () => {
  let draws = 0;
  await runWatch({ root: tmp(), config, env: {}, liveMs: 5, dispatch: async () => ({ action: "idle" }), board: async () => (draws++, {}), news: async () => ({ ok: true }) });
  gh(ok, ["issue", "edit", "9"]);
  await sleep(20);
  assert.equal(draws, 1);
  const off = normalize({ repo: "jk/proj", owner_login: "jk", slack: { channel: "C0123ABCD", board: false } });
  await runWatch({ root: tmp(), config: off, env: {}, liveMs: 5,
    dispatch: async () => { gh(ok, ["issue", "edit", "9"]); await sleep(20); return { action: "idle" }; },
    board: async () => (draws++, {}), news: async () => ({ ok: true }) });
  assert.equal(draws, 2, "only the end-of-tick call, which syncBoard itself skips when the board is off");
});
