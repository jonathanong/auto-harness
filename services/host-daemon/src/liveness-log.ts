import { countOpenFds } from "./fd-count.ts";

export type LivenessLogOptions = {
  /** How often to emit the liveness line (ms). Default 5 minutes. */
  intervalMs?: number;
  isRegistered: () => boolean;
  /**
   * Epoch ms of the last locally-sent keepalive that completed, or undefined
   * if none yet. This is send completion, not delivery: a wedged-but-open
   * socket can still advance this value. Protocol 2 re-arms the stall
   * watchdog on `host:keepalive-ack` instead; this line stays a coarse
   * "the daemon's own loop is still ticking" signal.
   */
  lastKeepaliveSentAtMs: () => number | undefined;
  queuedCount: () => number;
  log: (line: string) => void;
  nowMs?: () => number;
  countOpenFds?: () => number | undefined;
};

const DEFAULT_LIVENESS_LOG_INTERVAL_MS = 5 * 60_000;

export function formatLivenessLine(options: {
  registered: boolean;
  msSinceLastKeepaliveSent: number | undefined;
  queuedCount: number;
  openFds: number | undefined;
}): string {
  const keepalive =
    options.msSinceLastKeepaliveSent === undefined
      ? "none yet"
      : `${options.msSinceLastKeepaliveSent}ms ago`;
  const fds = options.openFds === undefined ? "n/a" : String(options.openFds);
  return (
    `daemon liveness: registered=${options.registered} ` +
    `last keepalive sent=${keepalive} queued=${options.queuedCount} open fds=${fds}`
  );
}

/** Emit a periodic log line so a wedged-but-not-crashed daemon stays visible in its own log. */
export function startLivenessLog(options: LivenessLogOptions): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_LIVENESS_LOG_INTERVAL_MS;
  const nowMs = options.nowMs ?? Date.now;
  const readFdCount = options.countOpenFds ?? countOpenFds;
  const timer = setInterval(() => {
    const lastSent = options.lastKeepaliveSentAtMs();
    options.log(
      formatLivenessLine({
        registered: options.isRegistered(),
        msSinceLastKeepaliveSent: lastSent === undefined ? undefined : nowMs() - lastSent,
        queuedCount: options.queuedCount(),
        openFds: readFdCount(),
      }),
    );
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
