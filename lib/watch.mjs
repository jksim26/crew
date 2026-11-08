// `crew watch`: the every-10-minutes job. No model unless there is real work:
//   1. dispatch, inside dispatch_hours only (plain checks first; the dev worker wakes only for a
//      ready issue or a review to fix)
//   2. refresh the pinned Slack board if any label changed
//   3. one Slack news line when something happened (the same line is not repeated within 6 hours)
import { runDispatch } from "./dispatch.mjs";
import { syncBoard, postNews, dispatchNews } from "./slack.mjs";
import { readState, writeState } from "./brief.mjs";
import { logLine } from "./state.mjs";
import { inDispatchHours } from "./config.mjs";

const REPEAT_MS = 6 * 3600_000;

export async function runWatch({ root, config, env = process.env, now = new Date(), dispatch = runDispatch, board = syncBoard, news = postNews, fetchImpl = globalThis.fetch, dryRun = false }) {
  const out = { dispatch: null, board: null, news: null };
  // Outside dispatch_hours only the board is refreshed: the dev worker leaves the subscription to
  // whatever else the machine runs at those times.
  out.dispatch = inDispatchHours(config, now)
    ? await dispatch({ root, config, env, now, dryRun })
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
