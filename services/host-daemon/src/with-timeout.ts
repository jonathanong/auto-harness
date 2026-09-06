/** Injectable timer seam shared by every `withTimeout` caller in this service. */
export type TimeoutTimers = Pick<typeof globalThis, "setTimeout" | "clearTimeout">;

/**
 * Race `promise` against a timeout, rejecting with `message` if it wins.
 *
 * Exists because a stalled outbound write (dead transport, wedged registration)
 * otherwise leaves its promise pending forever: nothing ever resolves or
 * rejects, so a caller `await`-ing it — and any `.catch` meant to log or react
 * to failure — never runs. Bounding the wait turns silent staleness into an
 * observable, timely rejection.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  timers: TimeoutTimers = globalThis,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = timers.setTimeout(() => reject(new Error(message)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) timers.clearTimeout(timer);
  }
}
