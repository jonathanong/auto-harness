import type { AgentToServerMessage, AgentWireMessage } from "@auto-harness/shared";
import WebSocket from "ws";

import type { AgentTransport } from "./agent-loop.ts";

type WsTransportOptions = {
  /** e.g. ws://127.0.0.1:7420/ws */
  url: string;
  /** Optional agentId query hint */
  agentId?: string;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (err: Error) => void;
};

/**
 * Agent transport over WebSocket (local API /ws or API Gateway).
 */
export function createWsTransport(options: WsTransportOptions): AgentTransport & {
  ready: Promise<void>;
} {
  const url =
    options.agentId !== undefined
      ? `${options.url}${options.url.includes("?") ? "&" : "?"}agentId=${encodeURIComponent(options.agentId)}`
      : options.url;

  let handler: ((msg: AgentWireMessage) => void) | null = null;
  let openResolve: (() => void) | null = null;
  let openReject: ((err: Error) => void) | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    openResolve = resolve;
    openReject = reject;
  });

  const socket = new WebSocket(url);

  socket.on("open", () => {
    options.onOpen?.();
    openResolve?.();
  });
  socket.on("error", (err) => {
    const e = err instanceof Error ? err : new Error(String(err));
    options.onError?.(e);
    openReject?.(e);
  });
  socket.on("close", () => {
    options.onClose?.();
  });
  socket.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw)) as AgentWireMessage | { type: string };
      if (
        msg.type === "session:assign" ||
        msg.type === "session:cancel" ||
        msg.type === "agent:drain"
      ) {
        handler?.(msg as AgentWireMessage);
      }
    } catch {
      // ignore non-JSON
    }
  });

  return {
    ready,
    async send(msg: AgentToServerMessage) {
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("WebSocket not open");
      }
      socket.send(JSON.stringify(msg));
    },
    onMessage(h) {
      handler = h;
    },
    close() {
      handler = null;
      socket.close();
    },
  };
}
