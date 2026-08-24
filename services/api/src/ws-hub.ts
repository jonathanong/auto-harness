/* eslint-disable max-lines -- WebSocket ingress validation and ownership are one boundary. */
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import {
  HOST_CAPABILITIES,
  isHostRuntimeReport,
  isHostCapability,
  isHostRunningAttempt,
  isValidCliResumeRef,
  isSessionStatus,
  principalHas,
  type HostToServerMessage,
  type HostWireMessage,
} from "@auto-harness/shared";
import { WebSocketServer, type WebSocket } from "ws";

import type { AuthService, Principal } from "./auth.ts";
import type { ControlPlane } from "./control-plane.ts";
import { handleHostLogBatchDurable, MAX_DURABLE_LOG_BATCH_SIZE } from "./control-plane-messages.ts";
import type { RateLimitEvent } from "./rate-limit.ts";
import { validateUsage } from "./usage.ts";

const MAX_WS_FRAME_BYTES = 128 * 1024;
const MAX_WS_MESSAGES_PER_SECOND = 100;
const MAX_LOG_CHUNK_BYTES = 32 * 1024;

function boundedText(candidate: unknown, max = 512): candidate is string {
  return typeof candidate === "string" && candidate.length > 0 && candidate.length <= max;
}

function optionalText(candidate: unknown, max = 512): boolean {
  return candidate === undefined || (typeof candidate === "string" && candidate.length <= max);
}

function isUuid(candidate: unknown): candidate is string {
  return (
    typeof candidate === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)
  );
}

export type WsHub = {
  hostCount(): number;
  close(): void;
};

type WsBridgeOptions = {
  maxMessagesPerSecond?: number;
  onRateLimitEvent?: (event: RateLimitEvent) => void;
  /** Short bounded window for coalescing adjacent log frames. */
  logBatchDelayMs?: number;
};

type HostSocketMap = Map<string, WebSocket>;
type HostDrainMap = Map<string, { socket: WebSocket; drain: () => Promise<void> }>;

export function createWsDelivery(
  hostSockets: Map<string, WebSocket>,
): (hostId: string, msg: HostWireMessage) => void {
  return (hostId, msg) => {
    const sock = hostSockets.get(hostId);
    if (sock && sock.readyState === sock.OPEN) sock.send(JSON.stringify(msg));
  };
}

/** Local WebSocket hub with the same identity/ownership boundaries as API Gateway. */
export function createPlaneWsBridge(options: WsBridgeOptions = {}): {
  hostSockets: HostSocketMap;
  onHostMessage: (hostId: string, msg: HostWireMessage) => void;
  attach(server: HttpServer, plane: ControlPlane, auth?: AuthService): WsHub;
} {
  const hostSockets: HostSocketMap = new Map();
  const hostDrains: HostDrainMap = new Map();
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
        const authRequired = auth?.mode === "required";
        let boundHostId: string | null = null;
        let boundConnectionId: string | null = null;
        let windowStartedAt = Date.now();
        let messageCount = 0;
        let accepting = true;
        let pendingRegistration: { hostId: string; closed: boolean } | null = null;
        let drainForReplacement: () => Promise<void>;

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
          if (!isAllowedMessage(plane, msg, boundHostId, principal, authRequired)) {
            accepting = false;
            socket.close(1008, "message not authorized");
            return;
          }
          const registration =
            msg.type === "host:register" ? { hostId: msg.hostId, closed: false } : null;
          if (registration) pendingRegistration = registration;
          const incumbent = registration ? hostDrains.get(registration.hostId) : undefined;
          if (incumbent && incumbent.socket !== socket) await incumbent.drain();
          const result = await plane.handleHostMessageDurable(
            msg,
            boundConnectionId ?? undefined,
            msg.type === "host:register",
          );
          if (!result.ok) {
            if (registration && pendingRegistration === registration) pendingRegistration = null;
            if (socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify({ type: "error", message: result.error }));
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
            boundConnectionId = result.connectionId!;
            hostSockets.set(msg.hostId, socket);
            hostDrains.set(msg.hostId, { socket, drain: drainForReplacement });
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
            socket.send(
              JSON.stringify({
                type: "session:acknowledged",
                sessionId: msg.sessionId,
                attemptId: msg.attemptId,
              }),
            );
          } else if (
            msg.type === "host:status" &&
            result.hostDraining === msg.hostId &&
            socket.readyState === socket.OPEN
          ) {
            socket.send(JSON.stringify({ type: "host:draining", hostId: msg.hostId }));
          }
        };
        type LogMessage = Extract<HostToServerMessage, { type: "session:log" }>;
        const handleLogBatch = async (batch: readonly LogMessage[]): Promise<void> => {
          if (
            boundHostId &&
            boundConnectionId &&
            plane.state.hostConnection.get(boundHostId) !== boundConnectionId
          ) {
            accepting = false;
            socket.close(1008, "stale host connection");
            return;
          }
          const allowed: LogMessage[] = [];
          for (const message of batch) {
            if (!isAllowedMessage(plane, message, boundHostId, principal, authRequired)) {
              accepting = false;
              socket.close(1008, "message not authorized");
              break;
            }
            allowed.push(message);
          }
          if (allowed.length === 0) return;
          // A message cannot pass isAllowedMessage before registration binds
          // both values for this socket.
          const result = await handleHostLogBatchDurable(plane.state, allowed, boundConnectionId!);
          if (!result.ok && socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: "error", message: result.error }));
          }
        };
        // The ws EventEmitter does not await async listeners. Keep host messages in wire
        // order so a keepalive or status cannot race an in-flight durable registration.
        // Store a recovered tail so one failed durable operation cannot block later frames.
        let messageTail: Promise<void> = Promise.resolve();
        let pendingLogs: LogMessage[] = [];
        let logBatchTimer: ReturnType<typeof setTimeout> | undefined;
        const queueWork = (work: () => Promise<void>): void => {
          messageTail = messageTail.then(work).catch(() => {
            accepting = false;
            socket.close(1011, "message handling failed");
          });
        };
        const flushLogBatch = (): void => {
          if (logBatchTimer) clearTimeout(logBatchTimer);
          logBatchTimer = undefined;
          if (pendingLogs.length === 0) return;
          const batch = pendingLogs;
          pendingLogs = [];
          queueWork(() => handleLogBatch(batch));
        };
        const queueLog = (message: LogMessage): void => {
          pendingLogs.push(message);
          if (pendingLogs.length >= MAX_DURABLE_LOG_BATCH_SIZE) {
            flushLogBatch();
          } else if (!logBatchTimer) {
            logBatchTimer = setTimeout(flushLogBatch, options.logBatchDelayMs ?? 5);
          }
        };
        drainForReplacement = async () => {
          accepting = false;
          flushLogBatch();
          await messageTail;
          if (socket.readyState === socket.OPEN) socket.close(1008, "host reconnected");
        };
        socket.on("message", (raw) => {
          if (!accepting) return;
          const now = Date.now();
          if (now - windowStartedAt >= 1000) {
            windowStartedAt = now;
            messageCount = 0;
          }
          if (++messageCount > (options.maxMessagesPerSecond ?? MAX_WS_MESSAGES_PER_SECOND)) {
            options.onRateLimitEvent?.({
              outcome: "denied",
              bucket: "host",
              limit: options.maxMessagesPerSecond ?? MAX_WS_MESSAGES_PER_SECOND,
              actorKey: "websocket-connection",
            });
            flushLogBatch();
            accepting = false;
            socket.close(1008, "message rate exceeded");
            return;
          }
          const msg = parseHostMessage(raw);
          if (!msg) {
            flushLogBatch();
            accepting = false;
            socket.close(1008, "invalid message");
            return;
          }
          if (msg.type === "session:log") {
            queueLog(msg);
          } else {
            // A terminal/control frame may not overtake preceding logs.
            flushLogBatch();
            queueWork(() => handleMessage(msg));
          }
        });
        socket.on("close", () => {
          accepting = false;
          flushLogBatch();
          if (pendingRegistration) pendingRegistration.closed = true;
          if (boundHostId && hostDrains.get(boundHostId)?.socket === socket) {
            hostDrains.delete(boundHostId);
          }
          if (boundHostId && hostSockets.get(boundHostId) === socket) {
            hostSockets.delete(boundHostId);
            if (boundConnectionId) {
              const connectionId = boundConnectionId;
              // Keep the durable lease alive until every already-accepted log
              // has either committed or failed its connection-fenced batch.
              void messageTail.then(() => plane.disconnectHostDurable(connectionId));
            }
          }
        });
      };

      const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
        // HTTP upgrade requests always carry their request target.
        const pathname = new URL(req.url!, "http://localhost").pathname;
        if (pathname !== "/ws") {
          // The browser viewer owns `/ws/viewer` on this same HTTP server.
          // Do not consume its upgrade before that read-only hub can inspect it.
          if (pathname === "/ws/viewer") return;
          socket.destroy();
          return;
        }
        // Credential lookup may re-read accounts, so the upgrade completes on a later
        // tick. The viewer hub on this same server already upgrades asynchronously.
        void (async () => {
          let principal: Principal | null = null;
          try {
            principal = await authenticateSocket(req, auth);
          } catch (error) {
            console.error("host websocket authentication failed", error);
            socket.destroy();
            return;
          }
          if (auth?.mode === "required" && !principal) {
            socket.write(
              "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            socket.destroy();
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, req, principal));
        })();
      };
      server.on("upgrade", onUpgrade);
      return {
        hostCount: () => hostSockets.size,
        close: () => {
          server.off("upgrade", onUpgrade);
          for (const sock of hostSockets.values()) sock.close();
          hostSockets.clear();
          hostDrains.clear();
          wss.close();
        },
      };
    },
  };
}

async function authenticateSocket(
  req: IncomingMessage,
  auth: AuthService | undefined,
): Promise<Principal | null> {
  if (!auth) return null;
  const bearer = req.headers.authorization;
  const token = bearer?.startsWith("Bearer ") ? bearer.slice("Bearer ".length) : null;
  return token ? await auth.authenticateApiKey(token) : null;
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
        (message.capabilities !== undefined &&
          (!Array.isArray(message.capabilities) ||
            message.capabilities.length > HOST_CAPABILITIES.length ||
            !message.capabilities.every(isHostCapability) ||
            new Set(message.capabilities).size !== message.capabilities.length)) ||
        (message.runningSessions !== undefined &&
          (!Array.isArray(message.runningSessions) ||
            message.runningSessions.length > 1_000 ||
            !message.runningSessions.every((sessionId) => boundedText(sessionId)))) ||
        (message.runningAttempts !== undefined &&
          (!Array.isArray(message.runningAttempts) ||
            message.runningAttempts.length > 1_000 ||
            !message.runningAttempts.every(
              (attempt) =>
                isHostRunningAttempt(attempt) &&
                boundedText(attempt.sessionId) &&
                boundedText(attempt.attemptId),
            ) ||
            new Set(
              message.runningAttempts.map((attempt) =>
                isHostRunningAttempt(attempt) ? attempt.sessionId : "",
              ),
            ).size !== message.runningAttempts.length)) ||
        (message.protocolVersion !== undefined &&
          (typeof message.protocolVersion !== "number" ||
            !Number.isSafeInteger(message.protocolVersion) ||
            message.protocolVersion < 0 ||
            message.protocolVersion > 1_024)) ||
        (message.daemonInstanceId === undefined) !== (message.daemonStartedAt === undefined) ||
        (message.daemonInstanceId !== undefined && !isUuid(message.daemonInstanceId)) ||
        (message.daemonStartedAt !== undefined &&
          (!boundedText(message.daemonStartedAt, 128) ||
            !Number.isFinite(Date.parse(message.daemonStartedAt)))) ||
        (message.runtime !== undefined && !validRuntimeReport(message.runtime)) ||
        (message.draining !== undefined && message.draining !== true)
      ) {
        return null;
      }
      return message as HostToServerMessage;
    }
    if (message.type === "session:ack") {
      return boundedText(message.sessionId) &&
        (message.worktreeId === null || boundedText(message.worktreeId)) &&
        boundedText(message.attemptId)
        ? (message as HostToServerMessage)
        : null;
    }
    if (message.type === "session:status") {
      const exitCode = message.exitCode;
      const validExitCode =
        exitCode === undefined ||
        exitCode === null ||
        (typeof exitCode === "number" && Number.isSafeInteger(exitCode));
      return boundedText(message.sessionId) &&
        (message.worktreeId === null || boundedText(message.worktreeId)) &&
        boundedText(message.attemptId) &&
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
        boundedText(message.attemptId) &&
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
    if (message.type === "host:status") {
      return boundedText(message.hostId) && message.draining === true
        ? (message as HostToServerMessage)
        : null;
    }
    if (message.type === "session:usage") {
      return boundedText(message.sessionId) &&
        (message.worktreeId === null || boundedText(message.worktreeId)) &&
        boundedText(message.attemptId) &&
        validateUsage(message.usage)
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

function validRuntimeReport(value: unknown): boolean {
  return isHostRuntimeReport(value);
}

function isAllowedMessage(
  plane: ControlPlane,
  msg: HostToServerMessage,
  hostId: string | null,
  principal: Principal | null,
  authRequired: boolean,
): boolean {
  if (authRequired && (!principal || !principalHas(principal, "agent:protocol"))) return false;
  if (msg.type === "host:register")
    return (
      (!hostId || hostId === msg.hostId) &&
      (!principal?.boundHostId || principal.boundHostId === msg.hostId)
    );
  if (!hostId) return false;
  if (msg.type === "host:keepalive" || msg.type === "host:status") return msg.hostId === hostId;
  const session = plane.getSession(msg.sessionId);
  return Boolean(session && session.hostId === hostId);
}

export function attachHostWsHub(server: HttpServer, plane: ControlPlane): WsHub {
  const bridge = createPlaneWsBridge();
  plane.setOnHostMessage(bridge.onHostMessage);
  return bridge.attach(server, plane);
}
