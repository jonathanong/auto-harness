import type { AgentToServerMessage, AgentWireMessage } from "@auto-harness/shared";

import type { AgentTransport } from "./agent-transport.ts";

/**
 * In-process transport binding an agent to a ControlPlane-like message handler.
 * Local parity for API Gateway WebSocket (no network required).
 */
export function createLoopbackTransport(opts: {
  sendToServer: (msg: AgentToServerMessage) => void | Promise<void>;
}): AgentTransport & { deliver(msg: AgentWireMessage): void } {
  let handler: ((msg: AgentWireMessage) => void) | null = null;
  return {
    async send(msg) {
      await opts.sendToServer(msg);
    },
    onMessage(h) {
      handler = h;
    },
    close() {
      handler = null;
    },
    deliver(msg) {
      handler?.(msg);
    },
  };
}
