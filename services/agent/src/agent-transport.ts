import type { AgentToServerMessage, AgentWireMessage } from "@auto-harness/shared";

export type AgentTransport = {
  send(msg: AgentToServerMessage): Promise<void>;
  /** Register a handler for server→agent messages. */
  onMessage(handler: (msg: AgentWireMessage) => void): void;
  close(): void;
};
