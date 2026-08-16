/**
 * Process-level lifecycle wiring shared by the API and host-daemon entrypoints.
 *
 * Neither entrypoint previously logged an escaped rejection, and neither bounded its own
 * shutdown. Under Node's default an unhandled rejection exits the process with no record
 * of what threw, and a `stop()` that never settles leaves the process alive forever —
 * which, with `TimeoutStopSec` set high, means `systemctl stop` never returns.
 */

export type LifecycleLogger = (message: string, error?: unknown) => void;

const defaultLogger: LifecycleLogger = (message, error) => {
  if (error === undefined) console.error(message);
  else console.error(message, error);
};

/**
 * Record why the process is going down, then actually take it down.
 *
 * Registering an `unhandledRejection`/`uncaughtException` listener at all suppresses
 * Node's default behavior of crashing on either — that default *is* the termination this
 * module exists to preserve. A listener that only logs leaves the process alive and
 * continuing in whatever unknown state triggered the error, which is worse than a crash:
 * a supervisor (systemd's `Restart=always`, ECS, etc.) can recover from an exit; nothing
 * recovers from a process silently corrupting state it no longer understands. So log
 * synchronously, then exit — matching Node's own guidance that it is not safe to resume
 * normal operation after either event.
 */
export function installCrashLogging(
  options: {
    logger?: LifecycleLogger;
    process?: Pick<NodeJS.Process, "on" | "exit">;
  } = {},
): void {
  const log = options.logger ?? defaultLogger;
  const target = options.process ?? process;
  target.on("unhandledRejection", (reason) => {
    log("unhandled promise rejection", reason);
    target.exit(1);
  });
  target.on("uncaughtException", (error) => {
    log("uncaught exception", error);
    target.exit(1);
  });
}

export type ShutdownHandle = {
  /** Runs the shutdown sequence. Safe to call repeatedly; later calls await the first. */
  shutdown: () => Promise<void>;
  /** Detaches the signal listeners and cancels any pending forced exit. */
  dispose: () => void;
};

/**
 * Wire SIGINT/SIGTERM to `stop`, exactly once, with an upper bound.
 *
 * Three properties the previous hand-rolled handlers lacked:
 * re-entrancy (a second signal used to start a second concurrent `stop()`),
 * a `catch` (a rejecting `stop()` became an unhandled rejection *during* shutdown),
 * and a deadline (nothing forced the process down if `stop()` never settled).
 */
export function onShutdownSignal(
  stop: () => Promise<void>,
  options: {
    /** Upper bound on graceful shutdown before the process is forced down. */
    timeoutMs?: number;
    logger?: LifecycleLogger;
    process?: Pick<NodeJS.Process, "on" | "off" | "exit">;
    signals?: NodeJS.Signals[];
    setTimeout?: typeof globalThis.setTimeout;
    clearTimeout?: typeof globalThis.clearTimeout;
  } = {},
): ShutdownHandle {
  const log = options.logger ?? defaultLogger;
  const target = options.process ?? process;
  const signals = options.signals ?? (["SIGINT", "SIGTERM"] as NodeJS.Signals[]);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const schedule = options.setTimeout ?? setTimeout;
  const cancel = options.clearTimeout ?? clearTimeout;

  let running: Promise<void> | undefined;
  let forced: ReturnType<typeof setTimeout> | undefined;

  const shutdown = (): Promise<void> => {
    if (running) return running;
    forced = schedule(() => {
      log(`graceful shutdown exceeded ${timeoutMs}ms; exiting`);
      target.exit(1);
    }, timeoutMs);
    // Never hold the event loop open on behalf of the deadline itself.
    forced.unref?.();
    // Cancel the deadline only on success. A failed stop() still needs the deadline to
    // force the process down — cancelling it unconditionally (as a blanket .finally()
    // once did) disarmed the one guarantee that made the failure recoverable: the caller
    // in cli.ts resolves its own outer promise only after stop() succeeds, so on a
    // rejection the process must fall back to the timer, not the caller's resolve.
    running = stop()
      .then(() => {
        if (forced) cancel(forced);
        forced = undefined;
      })
      .catch((error: unknown) => {
        log("error during shutdown", error);
      });
    return running;
  };

  const onSignal = (): void => {
    void shutdown();
  };
  for (const signal of signals) target.on(signal, onSignal);

  return {
    shutdown,
    dispose: () => {
      for (const signal of signals) target.off(signal, onSignal);
      if (forced) cancel(forced);
      forced = undefined;
    },
  };
}
