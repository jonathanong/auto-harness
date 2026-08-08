import type { HostToServerMessage, HostWireMessage } from "@auto-harness/shared";

import type { DaemonTransport } from "./daemon-transport.ts";

/**
 * In-process transport binding an agent to a ControlPlane-like message handler.
 * Local parity for API Gateway WebSocket (no network required).
 */
export function createLoopbackTransport(opts: {
  sendToServer: (msg: HostToServerMessage) => void | Promise<void>;
}): DaemonTransport & { deliver(msg: HostWireMessage): void } {
  let handler: ((msg: HostWireMessage) => void) | null = null;
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
