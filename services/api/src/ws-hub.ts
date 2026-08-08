import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { HostToServerMessage, HostWireMessage } from "@auto-harness/shared";
import { WebSocketServer, type WebSocket } from "ws";

import type { ControlPlane } from "./control-plane.ts";

export type WsHub = {
  hostCount(): number;
  close(): void;
};

type HostSocketMap = Map<string, WebSocket>;

export function createWsDelivery(
  hostSockets: Map<string, WebSocket>,
): (hostId: string, msg: HostWireMessage) => void {
  return (hostId, msg) => {
    const sock = hostSockets.get(hostId);
    if (sock && sock.readyState === sock.OPEN) {
      sock.send(JSON.stringify(msg));
    }
  };
}

/**
 * Local WebSocket hub (parity for API Gateway agent channel).
 * Path: /ws
 */
export function createPlaneWsBridge(): {
  hostSockets: HostSocketMap;
  onHostMessage: (hostId: string, msg: HostWireMessage) => void;
  attach(server: HttpServer, plane: ControlPlane): WsHub;
} {
  const hostSockets: HostSocketMap = new Map();
  const onHostMessage = createWsDelivery(hostSockets);

  return {
    hostSockets,
    onHostMessage,
    attach(server, plane) {
      const wss = new WebSocketServer({ noServer: true });

      wss.on("connection", (socket) => {
        let boundHostId: string | null = null;

        socket.on("message", (raw) => {
          let msg: HostToServerMessage;
          try {
            msg = JSON.parse(String(raw)) as HostToServerMessage;
          } catch {
            socket.send(JSON.stringify({ type: "error", message: "invalid JSON" }));
            return;
          }
          if (msg.type === "host:register") {
            boundHostId = msg.hostId;
            hostSockets.set(msg.hostId, socket);
          }
          const result = plane.handleHostMessage(msg);
          if (!result.ok) {
            socket.send(JSON.stringify({ type: "error", message: result.error ?? "error" }));
          } else if (msg.type === "host:register") {
            socket.send(JSON.stringify({ type: "host:registered", hostId: msg.hostId }));
          }
        });

        socket.on("close", () => {
          if (boundHostId && hostSockets.get(boundHostId) === socket) {
            hostSockets.delete(boundHostId);
          }
        });
      });

      const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (pathname !== "/ws") {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit("connection", ws, req);
        });
      };
      server.on("upgrade", onUpgrade);

      return {
        hostCount: () => hostSockets.size,
        close: () => {
          server.off("upgrade", onUpgrade);
          for (const s of hostSockets.values()) {
            s.close();
          }
          hostSockets.clear();
          wss.close();
        },
      };
    },
  };
}

export function attachHostWsHub(server: HttpServer, plane: ControlPlane): WsHub {
  const bridge = createPlaneWsBridge();
  plane.setOnHostMessage(bridge.onHostMessage);
  return bridge.attach(server, plane);
}
