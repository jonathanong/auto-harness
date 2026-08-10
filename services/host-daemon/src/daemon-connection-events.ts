import type { DaemonTransport } from "./daemon-transport-types.ts";

export function configureConnectionEvents(options: {
  transport: DaemonTransport;
  register: () => Promise<void>;
  onError: (error: unknown) => void;
  abortUnacknowledged: () => void;
  abortInflight: () => void;
  abortAfterMs: number;
  timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
}): { stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    if (timer) options.timers.clearTimeout(timer);
    timer = undefined;
  };
  options.transport.onConnected?.(() => {
    void options.register().catch(options.onError);
  });
  options.transport.onRegistered?.(clear);
  options.transport.onDisconnected?.(() => {
    options.abortUnacknowledged();
    if (timer) return;
    timer = options.timers.setTimeout(() => {
      timer = undefined;
      options.abortInflight();
    }, options.abortAfterMs);
  });
  return { stop: clear };
}
