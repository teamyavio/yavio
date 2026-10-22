/**
 * Let a timer not keep the process alive: Node's `unref()`, a no-op where
 * the handle is a number (browsers, some runtimes). Every timer the SDK
 * sets — flush interval, fetch timeout, backoff, drain, shutdown and signal
 * deadlines — goes through it (#148).
 */
export function unref(timer: ReturnType<typeof setTimeout>): void {
  if (timer && typeof timer === "object" && "unref" in timer) timer.unref();
}
