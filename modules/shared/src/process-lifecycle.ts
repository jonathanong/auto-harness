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
 * Record why the process is going down before it does. These handlers deliberately do not
 * swallow the failure: an unhandled rejection still terminates, because continuing from
 * unknown state is worse than restarting under a supervisor.
 */
export function installCrashLogging(
  options: {
    logger?: LifecycleLogger;
    process?: Pick<NodeJS.Process, "on">;
  } = {},
): void {
  const log = options.logger ?? defaultLogger;
  const target = options.process ?? process;
  target.on("unhandledRejection", (reason) => {
    log("unhandled promise rejection", reason);
  });
  target.on("uncaughtException", (error) => {
    log("uncaught exception", error);
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
    running = stop()
      .catch((error: unknown) => {
        log("error during shutdown", error);
      })
      .finally(() => {
        if (forced) cancel(forced);
        forced = undefined;
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
