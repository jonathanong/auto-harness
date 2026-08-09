import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { HostToServerMessage, HostWireMessage } from "@auto-harness/shared";
import { WebSocketServer, type WebSocket } from "ws";

import type { AuthService, Principal } from "./auth.ts";
import type { ControlPlane } from "./control-plane.ts";

const MAX_WS_FRAME_BYTES = 128 * 1024;
const MAX_WS_MESSAGES_PER_SECOND = 100;
const MAX_LOG_CHUNK_BYTES = 32 * 1024;

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
    if (sock && sock.readyState === sock.OPEN) sock.send(JSON.stringify(msg));
  };
}

/** Local WebSocket hub with the same identity/ownership boundaries as API Gateway. */
export function createPlaneWsBridge(): {
  hostSockets: HostSocketMap;
  onHostMessage: (hostId: string, msg: HostWireMessage) => void;
  attach(server: HttpServer, plane: ControlPlane, auth?: AuthService): WsHub;
} {
  const hostSockets: HostSocketMap = new Map();
  const onHostMessage = createWsDelivery(hostSockets);
  return {
    hostSockets,
    onHostMessage,
    attach(server, plane, auth) {
      const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_FRAME_BYTES });
      wss.on("connection", (socket, req) => {
        const principal = authenticateSocket(req, auth);
        if (auth?.mode === "required" && !principal) {
          socket.close(1008, "authentication required");
          return;
        }
        let boundHostId: string | null = null;
        let windowStartedAt = Date.now();
        let messageCount = 0;

        socket.on("message", (raw) => {
          const now = Date.now();
          if (now - windowStartedAt >= 1000) {
            windowStartedAt = now;
            messageCount = 0;
          }
          if (++messageCount > MAX_WS_MESSAGES_PER_SECOND) {
            socket.close(1008, "message rate exceeded");
            return;
          }
          const msg = parseHostMessage(raw);
          if (!msg) {
            socket.close(1008, "invalid message");
            return;
          }
          if (!isAllowedMessage(plane, msg, boundHostId, principal, auth?.mode === "required")) {
            socket.close(1008, "message not authorized");
            return;
          }
          const result = plane.handleHostMessage(msg);
          if (!result.ok) {
            socket.send(JSON.stringify({ type: "error", message: result.error ?? "error" }));
            return;
          }
          if (msg.type === "host:register") {
            // Do not overwrite a live socket until the control plane accepted the claim.
            boundHostId = msg.hostId;
            hostSockets.set(msg.hostId, socket);
            socket.send(JSON.stringify({ type: "host:registered", hostId: msg.hostId }));
          }
        });
        socket.on("close", () => {
          if (boundHostId && hostSockets.get(boundHostId) === socket) {
            hostSockets.delete(boundHostId);
            const connectionId = plane.state.hostConnection.get(boundHostId);
            if (connectionId) plane.disconnectHost(connectionId);
          }
        });
      });

      const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
        if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") {
          socket.destroy();
          return;
        }
        if (auth?.mode === "required" && !authenticateSocket(req, auth)) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      };
      server.on("upgrade", onUpgrade);
      return {
        hostCount: () => hostSockets.size,
        close: () => {
          server.off("upgrade", onUpgrade);
          for (const sock of hostSockets.values()) sock.close();
          hostSockets.clear();
          wss.close();
        },
      };
    },
  };
}

function authenticateSocket(req: IncomingMessage, auth: AuthService | undefined): Principal | null {
  if (!auth) return null;
  const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
  return token ? auth.authenticateApiKey(token) : null;
}

function parseHostMessage(raw: unknown): HostToServerMessage | null {
  if (typeof raw !== "string" && !Buffer.isBuffer(raw)) return null;
  try {
    const value = JSON.parse(String(raw)) as Record<string, unknown>;
    if (!value || typeof value.type !== "string") return null;
    if (value.type === "host:register") {
      return typeof value.hostId === "string" &&
        Array.isArray(value.worktrees) &&
        Array.isArray(value.commandProfiles)
        ? (value as HostToServerMessage)
        : null;
    }
    if (value.type === "session:ack")
      return typeof value.sessionId === "string" ? (value as HostToServerMessage) : null;
    if (value.type === "session:status")
      return typeof value.sessionId === "string" && typeof value.status === "string"
        ? (value as HostToServerMessage)
        : null;
    if (value.type === "session:log") {
      return typeof value.sessionId === "string" &&
        typeof value.stream === "string" &&
        typeof value.content === "string" &&
        typeof value.timestamp === "string" &&
        typeof value.seq === "number" &&
        Buffer.byteLength(value.content) <= MAX_LOG_CHUNK_BYTES
        ? (value as HostToServerMessage)
        : null;
    }
    return value.type === "host:keepalive" && typeof value.hostId === "string"
      ? (value as HostToServerMessage)
      : null;
  } catch {
    return null;
  }
}

function isAllowedMessage(
  plane: ControlPlane,
  msg: HostToServerMessage,
  hostId: string | null,
  principal: Principal | null,
  authRequired: boolean,
): boolean {
  if (
    authRequired &&
    (!principal ||
      principal.kind !== "service-account" ||
      principal.role === "read-only" ||
      !principal.boundHostId)
  )
    return false;
  if (msg.type === "host:register")
    return !hostId && (!principal?.boundHostId || principal.boundHostId === msg.hostId);
  if (!hostId) return false;
  if (msg.type === "host:keepalive") return msg.hostId === hostId;
  const session = plane.getSession(msg.sessionId);
  return Boolean(session && session.hostId === hostId);
}

export function attachHostWsHub(server: HttpServer, plane: ControlPlane): WsHub {
  const bridge = createPlaneWsBridge();
  plane.setOnHostMessage(bridge.onHostMessage);
  return bridge.attach(server, plane);
}
