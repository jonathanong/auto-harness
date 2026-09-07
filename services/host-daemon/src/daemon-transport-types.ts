import type { HostToServerMessage, HostWireMessage } from "@auto-harness/shared";

/** Transport contract only; excluded from runtime coverage alongside types.ts. */
export type SendOptions = {
  signal?: AbortSignal;
  /** A recovery marker is a log on the wire but must not be evicted. */
  nonDroppable?: boolean;
};

export type DaemonTransport = {
  send(msg: HostToServerMessage, options?: SendOptions): Promise<void>;
  onMessage(handler: (msg: HostWireMessage) => void): void;
  onConnected?(handler: () => void): void;
  onRegistered?(handler: () => void): void;
  onDisconnected?(handler: () => void): void;
  /** Current registration state, for an external liveness log -- not an event. */
  isRegistered?(): boolean;
  /** Outbound frames buffered but not yet delivered, for an external liveness log. */
  queuedCount?(): number;
  close(): void;
  /**
   * Abandon the current connection and let the transport's normal reconnect
   * ladder take over, even though nothing has observably failed yet (no
   * error, no close frame). A callback with no live connection to abandon is
   * a no-op — a reconnect is already in flight or about to be.
   *
   * Exists for a liveness watchdog that has stopped seeing evidence the
   * connection still works (no acknowledged keepalive, no registration ack):
   * an open-but-unresponsive socket produces none of the transport's own
   * failure signals on its own, so the decision to give up on it has to come
   * from outside.
   */
  forceReconnect?(reason: string): void;
};
