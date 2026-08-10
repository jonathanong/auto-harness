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
  close(): void;
};
