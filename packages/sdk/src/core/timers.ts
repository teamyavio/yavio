/**
 * Let a timer not keep the process alive: Node's `unref()`, a no-op where
 * the handle is a number (browsers, some runtimes). Every timer the SDK
 * sets — flush interval, fetch timeout, backoff, cut and signal deadlines,
 * every bounded wait — goes through it (#148); the one exception is the
 * deadline of a transport's own drain or shutdown while it runs
 * (`raceDeadline`'s `keepAlive`, #164).
 */
export function unref(timer: ReturnType<typeof setTimeout>): void {
  if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
}

export interface RaceDeadlineOptions {
  /** Runs when the deadline fires before `work` settled, before the race resolves. */
  onTimeout?: () => void;
  /**
   * A set the deadline's resolver joins for the duration of the race:
   * whoever resolves the set's members ends the wait early (the registry's
   * signal-cycle timer and its test reset, see shared.ts).
   */
  waiters?: Set<() => void>;
  /**
   * Keep the process alive until the race is over: the deadline timer is
   * left ref'd — and cleared, as always, once `work` settles, the deadline
   * fires or a waiter ends the race — so it holds the event loop for at
   * most `ms`. For a transport's own drain and shutdown (#164): their work
   * waits on unref'd timers between attempts (the backoff, `Retry-After`),
   * and with nothing else alive — the app's server closed — Node exited in
   * that gap, `shutdown()` never resolved and the batch was lost.
   */
  keepAlive?: boolean;
}

/**
 * Await `work` for at most `ms`: resolves when `work` settles or when the
 * deadline fires, whichever comes first — the work goes on in the
 * background. The timer is unref'd (unless `keepAlive`) and cleared once
 * the race is over. One implementation for the transport's drain and
 * shutdown deadlines and the registry's bounded waits (#148 review round
 * 2).
 */
export async function raceDeadline(
  work: Promise<unknown>,
  ms: number,
  options: RaceDeadlineOptions = {},
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let release: (() => void) | undefined;
  const deadline = new Promise<void>((resolve) => {
    release = resolve;
    options.waiters?.add(resolve);
    timer = setTimeout(() => {
      options.onTimeout?.();
      resolve();
    }, ms);
    if (!options.keepAlive) unref(timer);
  });
  try {
    await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    if (release) options.waiters?.delete(release);
  }
}
