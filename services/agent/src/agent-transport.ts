import type { HostToServerMessage, HostWireMessage } from "@auto-harness/shared";

export type AgentTransport = {
  send(msg: HostToServerMessage): Promise<void>;
  /** Register a handler for server→agent messages. */
  onMessage(handler: (msg: HostWireMessage) => void): void;
  close(): void;
};
