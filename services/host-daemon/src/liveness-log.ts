import { countOpenFds } from "./fd-count.ts";

export type LivenessLogOptions = {
  /** How often to emit the liveness line (ms). Default 5 minutes. */
  intervalMs?: number;
  isRegistered: () => boolean;
  /** Epoch ms of the last successfully delivered keepalive, or undefined if none yet. */
  lastKeepaliveAckAtMs: () => number | undefined;
  queuedCount: () => number;
  log: (line: string) => void;
  nowMs?: () => number;
  countOpenFds?: () => number | undefined;
};

const DEFAULT_LIVENESS_LOG_INTERVAL_MS = 5 * 60_000;

export function formatLivenessLine(options: {
  registered: boolean;
  msSinceLastKeepaliveAck: number | undefined;
  queuedCount: number;
  openFds: number | undefined;
}): string {
  const heartbeat =
    options.msSinceLastKeepaliveAck === undefined
      ? "none yet"
      : `${options.msSinceLastKeepaliveAck}ms ago`;
  const fds = options.openFds === undefined ? "n/a" : String(options.openFds);
  return (
    `daemon liveness: registered=${options.registered} ` +
    `last keepalive ack=${heartbeat} queued=${options.queuedCount} open fds=${fds}`
  );
}

/** Emit a periodic log line so a wedged-but-not-crashed daemon stays visible in its own log. */
export function startLivenessLog(options: LivenessLogOptions): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_LIVENESS_LOG_INTERVAL_MS;
  const nowMs = options.nowMs ?? Date.now;
  const readFdCount = options.countOpenFds ?? countOpenFds;
  const timer = setInterval(() => {
    const lastAck = options.lastKeepaliveAckAtMs();
    options.log(
      formatLivenessLine({
        registered: options.isRegistered(),
        msSinceLastKeepaliveAck: lastAck === undefined ? undefined : nowMs() - lastAck,
        queuedCount: options.queuedCount(),
        openFds: readFdCount(),
      }),
    );
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
