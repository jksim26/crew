// `crew watch`: the every-10-minutes job. No model unless there is real work:
//   0. owner commands from Slack (slack.commanders), answered in the thread
//   1. dispatch, inside dispatch_hours only (plain checks first; the dev worker wakes only for a
//      ready issue or a review to fix)
//   2. refresh the pinned Slack board if any label changed
//   3. one Slack news line when something happened (the same line is not repeated within 6 hours)
import { runDispatch } from "./dispatch.mjs";
import { syncBoard, postNews, dispatchNews, refreshCanvases } from "./slack.mjs";
import { readState, writeState } from "./brief.mjs";
import { logLine } from "./state.mjs";
import { inDispatchHours } from "./config.mjs";
import { runCommands } from "./commands.mjs";
import { updatingNow } from "./update.mjs";

const REPEAT_MS = 6 * 3600_000;

export async function runWatch({ root, config, env = process.env, now = new Date(), dispatch = runDispatch, board = syncBoard, news = postNews, canvases = refreshCanvases, commands = runCommands, fetchImpl = globalThis.fetch, dryRun = false }) {
  // crew update is swapping the runner's code: start nothing on it (at most 5 minutes).
  if (updatingNow(env)) return { skipped: "crew is updating" };
  const out = { dispatch: null, board: null, news: null, commands: null };
  // Owner commands first: a dev batch can run for an hour, and a command should not wait behind it.
  if (config.slack && !dryRun && config.slack.commanders?.length) {
    try {
      out.commands = await commands({ root, config, env, fetchImpl, now });
    } catch (e) {
      out.commands = { ran: 0, error: e.message };
      logLine(root, { action: "slack-commands", outcome: "error", detail: e.message });
    }
  }

  // The project's own canvases go before dispatch: a tick that starts dev workers waits on them for
  // up to an hour, and the canvases should not wait with it.
  if (config.slack?.canvases?.length && !dryRun) {
    try {
      out.canvases = await canvases({ root, config, env, now, fetchImpl });
    } catch (e) {
      out.canvases = [{ action: "error", why: e.message }];
      logLine(root, { action: "canvases", outcome: "error", detail: e.message });
    }
  }

  // Outside dispatch_hours only the board is refreshed: the dev worker leaves the subscription to
  // whatever else the machine runs at those times.
  // When runs start, refresh the board and say so at once: the batch itself can take an hour.
  const onStart = config.slack && !dryRun ? async (info) => {
    out.started = info;
    try { await board({ root, config, env, now, fetchImpl }); } catch (e) { logLine(root, { action: "board", outcome: "error", detail: e.message }); }
    const text = dispatchNews(info, config);
    if (text) await news({ config, text, env, fetchImpl });
  } : null;
  out.dispatch = inDispatchHours(config, now)
    ? await dispatch({ root, config, env, now, dryRun, onStart })
    : { action: "quiet", why: `outside dispatch_hours ${config.dispatch_hours.join(", ")}` };

  if (config.slack && !dryRun) {
    try {
      out.board = await board({ root, config, env, now, fetchImpl });
    } catch (e) {
      out.board = { action: "error", why: e.message };
      logLine(root, { action: "board", outcome: "error", detail: e.message });
    }
    const text = dispatchNews(out.dispatch, config);
    if (text) {
      const state = readState(root);
      const last = state.lastNews;
      if (last?.text === text && now - Date.parse(last.at) < REPEAT_MS) out.news = { ok: false, why: "same news already sent" };
      else {
        out.news = await news({ config, text, env, fetchImpl });
        if (out.news.ok) writeState(root, { ...readState(root), lastNews: { text, at: now.toISOString() } });
      }
    }
  }
  return out;
}
