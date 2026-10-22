/**
 * Let a timer not keep the process alive: Node's `unref()`, a no-op where
 * the handle is a number (browsers, some runtimes). Every timer the SDK
 * sets — flush interval, fetch timeout, backoff, drain, shutdown and signal
 * deadlines — goes through it (#148).
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
}

/**
 * Await `work` for at most `ms`: resolves when `work` settles or when the
 * deadline fires, whichever comes first — the work goes on in the
 * background. The timer is unref'd and cleared once the race is over. One
 * implementation for the transport's drain and shutdown deadlines and the
 * registry's bounded waits (#148 review round 2).
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
    unref(timer);
  });
  try {
    await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    if (release) options.waiters?.delete(release);
  }
}
