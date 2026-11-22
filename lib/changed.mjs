// Something crew just did may change what the Slack board shows: a label, a PR, a worker's phase.
// `crew watch` subscribes and redraws the board a few seconds later, so the board follows crew's
// own moves at once instead of on the next 10-minute tick. Bursts collapse into one redraw, and a
// change that lands mid-redraw gets one more redraw after it.
let listener = null;
let delayMs = 3000;
let timer = null;
let running = false;
let again = false;

/** Redraw with `fn` after each change. Returns the unsubscribe. */
export function onBoardChange(fn, ms = 3000) {
  listener = fn;
  delayMs = ms;
  return () => {
    listener = null;
    clearTimeout(timer);
    timer = null;
    again = false;
  };
}

export function boardChanged() {
  if (!listener) return;
  if (running) { again = true; return; }
  if (timer) return;
  timer = setTimeout(fire, delayMs);
  timer.unref?.();
}

async function fire() {
  timer = null;
  const fn = listener;
  if (!fn) return;
  running = true;
  try { await fn(); } catch { /* the listener logs its own errors */ }
  running = false;
  if (again) { again = false; boardChanged(); }
}

const WRITES = { issue: ["edit", "close", "reopen", "create"], pr: ["create", "merge", "close", "ready", "reopen"] };

/** Does this gh call change what the board shows? */
export const changesBoard = (args) => WRITES[args[0]]?.includes(args[1]) ?? false;
