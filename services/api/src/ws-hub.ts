import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { AgentToServerMessage, AgentWireMessage } from "@auto-harness/shared";
import { WebSocketServer, type WebSocket } from "ws";

import type { ControlPlane } from "./control-plane.ts";

export type WsHub = {
  agentCount(): number;
  close(): void;
};

type AgentSocketMap = Map<string, WebSocket>;

export function createWsDelivery(
  agentSockets: Map<string, WebSocket>,
): (agentId: string, msg: AgentWireMessage) => void {
  return (agentId, msg) => {
    const sock = agentSockets.get(agentId);
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
  agentSockets: AgentSocketMap;
  onAgentMessage: (agentId: string, msg: AgentWireMessage) => void;
  attach(server: HttpServer, plane: ControlPlane): WsHub;
} {
  const agentSockets: AgentSocketMap = new Map();
  const onAgentMessage = createWsDelivery(agentSockets);

  return {
    agentSockets,
    onAgentMessage,
    attach(server, plane) {
      const wss = new WebSocketServer({ noServer: true });

      wss.on("connection", (socket) => {
        let boundAgentId: string | null = null;

        socket.on("message", (raw) => {
          let msg: AgentToServerMessage;
          try {
            msg = JSON.parse(String(raw)) as AgentToServerMessage;
          } catch {
            socket.send(JSON.stringify({ type: "error", message: "invalid JSON" }));
            return;
          }
          if (msg.type === "agent:register") {
            boundAgentId = msg.agentId;
            agentSockets.set(msg.agentId, socket);
          }
          const result = plane.handleAgentMessage(msg);
          if (!result.ok) {
            socket.send(JSON.stringify({ type: "error", message: result.error ?? "error" }));
          } else if (msg.type === "agent:register") {
            socket.send(JSON.stringify({ type: "agent:registered", agentId: msg.agentId }));
          }
        });

        socket.on("close", () => {
          if (boundAgentId && agentSockets.get(boundAgentId) === socket) {
            agentSockets.delete(boundAgentId);
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
        agentCount: () => agentSockets.size,
        close: () => {
          server.off("upgrade", onUpgrade);
          for (const s of agentSockets.values()) {
            s.close();
          }
          agentSockets.clear();
          wss.close();
        },
      };
    },
  };
}

export function attachAgentWsHub(server: HttpServer, plane: ControlPlane): WsHub {
  const bridge = createPlaneWsBridge();
  plane.setOnAgentMessage(bridge.onAgentMessage);
  return bridge.attach(server, plane);
}
