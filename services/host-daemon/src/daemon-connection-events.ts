import type { DaemonTransport } from "./daemon-transport-types.ts";

export function configureConnectionEvents(options: {
  transport: DaemonTransport;
  register: () => Promise<void>;
  onError: (error: unknown) => void;
  abortUnacknowledged: () => void;
  abortInflight: () => void;
  onRegistered?: () => void;
  abortAfterMs: number;
  timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
}): { stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const clear = (): void => {
    if (timer) options.timers.clearTimeout(timer);
    timer = undefined;
  };
  const stop = (): void => {
    stopped = true;
    clear();
  };
  options.transport.onConnected?.(() => {
    if (stopped) return;
    void options.register().catch(options.onError);
  });
  options.transport.onRegistered?.(() => {
    if (!stopped) {
      clear();
      options.onRegistered?.();
    }
  });
  options.transport.onDisconnected?.(() => {
    if (stopped) return;
    options.abortUnacknowledged();
    if (timer) return;
    timer = options.timers.setTimeout(() => {
      timer = undefined;
      options.abortInflight();
    }, options.abortAfterMs);
  });
  return { stop };
}
