import type { HostToServerMessage, HostWireMessage } from "@auto-harness/shared";
import WebSocket from "ws";

import type { AgentTransport } from "./agent-loop.ts";

type WsTransportOptions = {
  /** e.g. ws://127.0.0.1:7420/ws */
  url: string;
  /** Optional hostId query hint */
  hostId?: string;
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
    options.hostId !== undefined
      ? `${options.url}${options.url.includes("?") ? "&" : "?"}hostId=${encodeURIComponent(options.hostId)}`
      : options.url;

  let handler: ((msg: HostWireMessage) => void) | null = null;
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
      const msg = JSON.parse(String(raw)) as HostWireMessage | { type: string };
      if (
        msg.type === "session:assign" ||
        msg.type === "session:cancel" ||
        msg.type === "host:drain"
      ) {
        handler?.(msg as HostWireMessage);
      }
    } catch {
      // ignore non-JSON
    }
  });

  return {
    ready,
    async send(msg: HostToServerMessage) {
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
