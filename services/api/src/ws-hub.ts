/* eslint-disable max-lines -- WebSocket ingress validation and ownership are one boundary. */
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import {
  isValidCliResumeRef,
  isSessionStatus,
  type HostToServerMessage,
  type HostWireMessage,
} from "@auto-harness/shared";
import { WebSocketServer, type WebSocket } from "ws";

import type { AuthService, Principal } from "./auth.ts";
import type { ControlPlane } from "./control-plane.ts";

const MAX_WS_FRAME_BYTES = 128 * 1024;
const MAX_WS_MESSAGES_PER_SECOND = 100;
const MAX_LOG_CHUNK_BYTES = 32 * 1024;

function boundedText(candidate: unknown, max = 512): candidate is string {
  return typeof candidate === "string" && candidate.length > 0 && candidate.length <= max;
}

function optionalText(candidate: unknown, max = 512): boolean {
  return candidate === undefined || (typeof candidate === "string" && candidate.length <= max);
}

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
      const handleConnection = (
        socket: WebSocket,
        req: IncomingMessage,
        principal: Principal | null,
      ) => {
        if (auth?.mode === "required" && !principal) {
          socket.close(1008, "authentication required");
          return;
        }
        let boundHostId: string | null = null;
        let boundConnectionId: string | null = null;
        let windowStartedAt = Date.now();
        let messageCount = 0;
        let accepting = true;
        let pendingRegistration: { hostId: string; closed: boolean } | null = null;

        const handleMessage = async (msg: HostToServerMessage): Promise<void> => {
          if (!accepting) return;
          if (
            boundHostId &&
            boundConnectionId &&
            plane.state.hostConnection.get(boundHostId) !== boundConnectionId
          ) {
            accepting = false;
            socket.close(1008, "stale host connection");
            return;
          }
          if (!isAllowedMessage(plane, msg, boundHostId, principal, auth?.mode === "required")) {
            accepting = false;
            socket.close(1008, "message not authorized");
            return;
          }
          const registration =
            msg.type === "host:register" ? { hostId: msg.hostId, closed: false } : null;
          if (registration) pendingRegistration = registration;
          const result = await plane.handleHostMessageDurable(
            msg,
            boundConnectionId ?? undefined,
            msg.type === "host:register",
          );
          if (!result.ok) {
            if (registration && pendingRegistration === registration) pendingRegistration = null;
            if (socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify({ type: "error", message: result.error ?? "error" }));
            }
            return;
          }
          if (msg.type === "host:register") {
            if (pendingRegistration === registration) pendingRegistration = null;
            // A durable registration can finish after the peer has gone away.
            // Do not publish the dead socket; release the lease and let the
            // normal disconnect path mark its inventory offline/requeue work.
            if (registration?.closed || socket.readyState !== socket.OPEN) {
              const connectionId = result.connectionId;
              if (connectionId) await plane.disconnectHostDurable(connectionId);
              return;
            }
            // Do not overwrite a live socket until the control plane accepted the claim.
            boundHostId = msg.hostId;
            boundConnectionId = result.connectionId ?? null;
            hostSockets.set(msg.hostId, socket);
            socket.send(
              JSON.stringify({
                type: "host:registered",
                hostId: msg.hostId,
                connectionId: boundConnectionId,
              }),
            );
          } else if (
            msg.type === "session:ack" &&
            result.sessionAcknowledged === msg.sessionId &&
            socket.readyState === socket.OPEN
          ) {
            // The client must not equate a successful WebSocket write with a
            // server acknowledgement. This reply is emitted only after the
            // fenced, durable acknowledgement transaction has committed.
            socket.send(JSON.stringify({ type: "session:acknowledged", sessionId: msg.sessionId }));
          }
        };
        // The ws EventEmitter does not await async listeners. Keep host messages in wire
        // order so a keepalive or status cannot race an in-flight durable registration.
        // Store a recovered tail so one failed durable operation cannot block later frames.
        let messageTail: Promise<void> = Promise.resolve();
        socket.on("message", (raw) => {
          if (!accepting || socket.readyState !== socket.OPEN) return;
          const now = Date.now();
          if (now - windowStartedAt >= 1000) {
            windowStartedAt = now;
            messageCount = 0;
          }
          if (++messageCount > MAX_WS_MESSAGES_PER_SECOND) {
            accepting = false;
            socket.close(1008, "message rate exceeded");
            return;
          }
          const msg = parseHostMessage(raw);
          if (!msg) {
            accepting = false;
            socket.close(1008, "invalid message");
            return;
          }
          messageTail = messageTail
            .then(() => handleMessage(msg))
            .catch(() => {
              accepting = false;
              socket.close(1011, "message handling failed");
            });
        });
        socket.on("close", () => {
          if (pendingRegistration) pendingRegistration.closed = true;
          if (boundHostId && hostSockets.get(boundHostId) === socket) {
            hostSockets.delete(boundHostId);
            if (boundConnectionId) void plane.disconnectHostDurable(boundConnectionId);
          }
        });
      };

      const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
        if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") {
          socket.destroy();
          return;
        }
        const principal = authenticateSocket(req, auth);
        if (auth?.mode === "required" && !principal) {
          socket.write(
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
          );
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, req, principal));
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
  const bearer = req.headers.authorization;
  const token = bearer?.startsWith("Bearer ") ? bearer.slice("Bearer ".length) : null;
  return token ? auth.authenticateApiKey(token) : null;
}

export function parseHostMessage(raw: unknown): HostToServerMessage | null {
  if (typeof raw !== "string" && !Buffer.isBuffer(raw) && (!raw || typeof raw !== "object"))
    return null;
  try {
    const value =
      typeof raw === "string" || Buffer.isBuffer(raw) ? (JSON.parse(String(raw)) as unknown) : raw;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const message = value as Record<string, unknown>;
    if (!boundedText(message.type, 64)) return null;
    if (message.type === "host:register") {
      if (
        !boundedText(message.hostId) ||
        !Array.isArray(message.worktrees) ||
        message.worktrees.length > 1_000 ||
        !message.worktrees.every((candidate) => {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
          const worktree = candidate as Record<string, unknown>;
          return (
            boundedText(worktree.id) &&
            boundedText(worktree.name) &&
            boundedText(worktree.repositoryId) &&
            boundedText(worktree.path, 4_096) &&
            Array.isArray(worktree.labels) &&
            worktree.labels.length <= 100 &&
            worktree.labels.every((label) => boundedText(label, 128))
          );
        }) ||
        !Array.isArray(message.commandProfiles) ||
        message.commandProfiles.length > 1_000 ||
        !message.commandProfiles.every((profile) => boundedText(profile)) ||
        (message.runningSessions !== undefined &&
          (!Array.isArray(message.runningSessions) ||
            message.runningSessions.length > 1_000 ||
            !message.runningSessions.every((sessionId) => boundedText(sessionId))))
      ) {
        return null;
      }
      return message as HostToServerMessage;
    }
    if (message.type === "session:ack") {
      return boundedText(message.sessionId) ? (message as HostToServerMessage) : null;
    }
    if (message.type === "session:status") {
      const exitCode = message.exitCode;
      const validExitCode =
        exitCode === undefined ||
        exitCode === null ||
        (typeof exitCode === "number" && Number.isSafeInteger(exitCode));
      return boundedText(message.sessionId) &&
        isSessionStatus(message.status) &&
        validExitCode &&
        optionalText(message.errorCode, 128) &&
        optionalText(message.errorMessage, 4_096) &&
        (message.cliResumeRef === undefined || isValidCliResumeRef(message.cliResumeRef))
        ? (message as HostToServerMessage)
        : null;
    }
    if (message.type === "session:log") {
      const timestamp = message.timestamp;
      const stream = message.stream;
      return boundedText(message.sessionId) &&
        (stream === "stdout" || stream === "stderr" || stream === "system") &&
        typeof message.content === "string" &&
        Buffer.byteLength(message.content) <= MAX_LOG_CHUNK_BYTES &&
        boundedText(timestamp, 128) &&
        Number.isSafeInteger(message.seq) &&
        (message.seq as number) >= 0 &&
        Number.isFinite(Date.parse(timestamp))
        ? (message as HostToServerMessage)
        : null;
    }
    return message.type === "host:keepalive" &&
      boundedText(message.hostId) &&
      boundedText(message.at, 128) &&
      Number.isFinite(Date.parse(message.at))
      ? (message as HostToServerMessage)
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
    return (
      (!hostId || hostId === msg.hostId) &&
      (!principal?.boundHostId || principal.boundHostId === msg.hostId)
    );
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
