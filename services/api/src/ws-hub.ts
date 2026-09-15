/* eslint-disable max-lines -- WebSocket ingress validation and ownership are one boundary. */
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import {
  HOST_PROTOCOL_VERSION,
  MAX_SESSION_LOG_DROPPED,
  isHostRuntimeReport,
  isHostRunningAttempt,
  isValidCliResumeRef,
  isSessionStatus,
  isTerminalSessionStatus,
  parseHostCapabilitiesAdvertisement,
  principalHas,
  sanitizeProviderAccountReadiness,
  validateProviderAccountReadiness,
  normalizeSessionResult,
  type HostToServerMessage,
  type HostWireMessage,
  type ProviderAccountReadiness,
  type WorkspacePoolAttachment,
} from "@auto-harness/shared";
import { WebSocketServer, type WebSocket } from "ws";

import type { AuthService, Principal } from "./auth.ts";
import type { ControlPlane } from "./control-plane.ts";
import {
  clearHostSocketPendingPublish,
  markHostSocketPendingPublish,
} from "./control-plane-host-socket-publish.ts";
import { emitWsMessagesDiscarded } from "./operational-metrics.ts";
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

function isWorkspacePoolSnapshot(value: unknown): value is WorkspacePoolAttachment[] {
  if (!Array.isArray(value) || value.length > 1_000) return false;
  const poolIds = new Set<string>();
  const slotIds = new Set<string>();
  for (const pool of value) {
    if (!pool || typeof pool !== "object" || Array.isArray(pool)) return false;
    const candidate = pool as Record<string, unknown>;
    if (
      !boundedText(candidate.workspacePoolId) ||
      poolIds.has(candidate.workspacePoolId) ||
      !Array.isArray(candidate.slots) ||
      candidate.slots.length > 1_000
    ) {
      return false;
    }
    poolIds.add(candidate.workspacePoolId);
    for (const slot of candidate.slots) {
      if (!slot || typeof slot !== "object" || Array.isArray(slot)) return false;
      const entry = slot as Record<string, unknown>;
      if (
        !boundedText(entry.id) ||
        slotIds.has(entry.id) ||
        !boundedText(entry.name) ||
        !boundedText(entry.path, 4_096)
      ) {
        return false;
      }
      slotIds.add(entry.id);
    }
  }
  return true;
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
        let pendingRegistration: {
          hostId: string;
          closed: boolean;
          connectionId: string;
        } | null = null;
        let drainForReplacement: () => Promise<void>;

        // Each caller here knows *why* it's about to close the socket; log that
        // reason at the point of decision rather than at the generic `!accepting`
        // reads scattered below, which only know the connection is already dead.
        const discardMessages = (count: number, reason: string): void => {
          emitWsMessagesDiscarded(count);
          console.warn(
            JSON.stringify({
              msg: "discarding host websocket message(s)",
              reason,
              count,
              hostId: boundHostId,
            }),
          );
        };

        const handleMessage = async (msg: HostToServerMessage): Promise<void> => {
          if (!accepting) return;
          if (
            boundHostId &&
            boundConnectionId &&
            plane.state.hostConnection.get(boundHostId) !== boundConnectionId
          ) {
            accepting = false;
            discardMessages(1, "stale host connection");
            socket.close(1008, "stale host connection");
            return;
          }
          if (!isAllowedMessage(plane, msg, boundHostId, principal, authRequired)) {
            accepting = false;
            discardMessages(1, "message not authorized");
            socket.close(1008, "message not authorized");
            return;
          }
          const registration =
            msg.type === "host:register"
              ? {
                  hostId: msg.hostId,
                  closed: false,
                  connectionId: boundConnectionId ?? plane.state.connectionIdFactory(),
                }
              : null;
          if (registration) pendingRegistration = registration;
          // Track the in-flight claim before durable work so an overlapping
          // fail-closed rollback cannot assign onto this socket until publish.
          if (registration && !boundConnectionId) {
            markHostSocketPendingPublish(plane.state, registration.connectionId);
          }
          const incumbent = registration ? hostDrains.get(registration.hostId) : undefined;
          if (incumbent && incumbent.socket !== socket) await incumbent.drain();
          const result = await plane.handleHostMessageDurable(
            msg,
            registration?.connectionId ?? boundConnectionId ?? undefined,
            msg.type === "host:register",
          );
          if (!result.ok) {
            if (registration) {
              clearHostSocketPendingPublish(plane.state, registration.connectionId);
              if (pendingRegistration === registration) pendingRegistration = null;
            }
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
              if (connectionId) {
                clearHostSocketPendingPublish(plane.state, connectionId);
                await plane.disconnectHostDurable(connectionId);
              }
              return;
            }
            // Do not overwrite a live socket until the control plane accepted the claim.
            boundHostId = msg.hostId;
            boundConnectionId = result.connectionId!;
            clearHostSocketPendingPublish(plane.state, boundConnectionId);
            hostSockets.set(msg.hostId, socket);
            hostDrains.set(msg.hostId, { socket, drain: drainForReplacement });
            socket.send(
              JSON.stringify({
                type: "host:registered",
                hostId: msg.hostId,
                connectionId: boundConnectionId,
                protocolVersion: HOST_PROTOCOL_VERSION,
              }),
            );
            for (const handoff of result.terminalHookHandoffs ?? []) {
              if (socket.readyState !== socket.OPEN) break;
              socket.send(JSON.stringify(handoff));
            }
            await plane.requestAssignment();
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
            msg.type === "session:command-start" &&
            result.sessionCommandStartAcknowledged?.sessionId === msg.sessionId &&
            socket.readyState === socket.OPEN
          ) {
            socket.send(
              JSON.stringify({
                type: "session:command-start-acknowledged",
                sessionId: result.sessionCommandStartAcknowledged.sessionId,
                attemptId: result.sessionCommandStartAcknowledged.attemptId,
              }),
            );
          } else if (
            msg.type === "session:status" &&
            result.sessionStatusAcknowledged?.sessionId === msg.sessionId &&
            socket.readyState === socket.OPEN
          ) {
            // Same peer-confirmation contract as session:ack above: a durable
            // application of the report, not the write, is the acknowledgement.
            socket.send(
              JSON.stringify({
                type: "session:status-acknowledged",
                sessionId: result.sessionStatusAcknowledged.sessionId,
                attemptId: result.sessionStatusAcknowledged.attemptId,
                ...(result.sessionStatusAcknowledged.retryAccepted !== undefined
                  ? { retryAccepted: result.sessionStatusAcknowledged.retryAccepted }
                  : {}),
                ...(result.sessionStatusAcknowledged.terminalHookHandoffId !== undefined
                  ? {
                      terminalHookHandoffId: result.sessionStatusAcknowledged.terminalHookHandoffId,
                    }
                  : {}),
                ...(result.sessionStatusAcknowledged.terminalHookHandoffExpiresAt !== undefined
                  ? {
                      terminalHookHandoffExpiresAt:
                        result.sessionStatusAcknowledged.terminalHookHandoffExpiresAt,
                    }
                  : {}),
              }),
            );
          } else if (
            msg.type === "session:terminal-hook-complete" &&
            result.sessionTerminalHookAcknowledged?.sessionId === msg.sessionId &&
            socket.readyState === socket.OPEN
          ) {
            socket.send(
              JSON.stringify({
                type: "session:terminal-hook-acknowledged",
                sessionId: msg.sessionId,
                handoffId: result.sessionTerminalHookAcknowledged.handoffId,
              }),
            );
          } else if (
            msg.type === "host:status" &&
            result.hostDraining === msg.hostId &&
            socket.readyState === socket.OPEN
          ) {
            socket.send(JSON.stringify({ type: "host:draining", hostId: msg.hostId }));
          } else if (msg.type === "host:keepalive" && socket.readyState === socket.OPEN) {
            // Same peer-confirmation contract as session:ack: heartbeatDurable
            // has already committed. A successful daemon write is not evidence
            // the control plane received the frame.
            socket.send(
              JSON.stringify({
                type: "host:keepalive-ack",
                hostId: msg.hostId,
                at: msg.at,
              }),
            );
            // Keepalive reconciliation can discover a terminal session while
            // this daemon is still connected. Deliver that handoff on the
            // exact fenced socket that submitted the keepalive; a hostId-only
            // lookup could race a replacement registration.
            if (
              boundConnectionId &&
              plane.state.hostConnection.get(msg.hostId) === boundConnectionId
            ) {
              for (const handoff of result.terminalHookHandoffs ?? []) {
                if (socket.readyState !== socket.OPEN) break;
                socket.send(JSON.stringify(handoff));
              }
            }
          }
        };
        // The ws EventEmitter does not await async listeners. Keep host messages in wire
        // order so a keepalive or status cannot race an in-flight durable registration.
        // Store a recovered tail so one failed durable operation cannot block later frames.
        let messageTail: Promise<void> = Promise.resolve();
        const queueWork = (work: () => Promise<void>): void => {
          messageTail = messageTail.then(work).catch(() => {
            accepting = false;
            socket.close(1011, "message handling failed");
          });
        };
        drainForReplacement = async () => {
          accepting = false;
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
            accepting = false;
            discardMessages(1, "message rate exceeded");
            socket.close(1008, "message rate exceeded");
            return;
          }
          const msg = parseHostMessage(raw);
          if (!msg) {
            accepting = false;
            discardMessages(1, "invalid message");
            socket.close(1008, "invalid message");
            return;
          }
          if (msg.type === "session:log") {
            accepting = false;
            discardMessages(1, "session:log is not accepted on the control-plane websocket");
            socket.close(1008, "session:log is not accepted on the control-plane websocket");
          } else {
            queueWork(() => handleMessage(msg));
          }
        });
        socket.on("close", () => {
          accepting = false;
          if (pendingRegistration) {
            pendingRegistration.closed = true;
            clearHostSocketPendingPublish(plane.state, pendingRegistration.connectionId);
          }
          if (boundHostId && hostDrains.get(boundHostId)?.socket === socket) {
            hostDrains.delete(boundHostId);
          }
          if (boundHostId && hostSockets.get(boundHostId) === socket) {
            hostSockets.delete(boundHostId);
            // boundConnectionId is always set alongside boundHostId. Keep the
            // durable lease alive until every already-accepted write has
            // either committed or failed its connection-fenced batch.
            const connectionId = boundConnectionId!;
            void messageTail.then(() => plane.disconnectHostDurable(connectionId));
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
        (message.workspacePools !== undefined &&
          !isWorkspacePoolSnapshot(message.workspacePools)) ||
        (message.capabilities !== undefined &&
          parseHostCapabilitiesAdvertisement(message.capabilities) === null) ||
        message.maxConcurrentAssignments !== undefined ||
        (message.providerAccountReadiness !== undefined &&
          (!Array.isArray(message.providerAccountReadiness) ||
            validateProviderAccountReadiness(
              message.providerAccountReadiness as ProviderAccountReadiness[],
            ) !== null)) ||
        (message.runningSessions !== undefined &&
          (!Array.isArray(message.runningSessions) ||
            message.runningSessions.length > 1_000 ||
            !message.runningSessions.every((sessionId) => boundedText(sessionId)))) ||
        !Array.isArray(message.runningAttempts) ||
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
        ).size !== message.runningAttempts.length ||
        typeof message.protocolVersion !== "number" ||
        !Number.isSafeInteger(message.protocolVersion) ||
        message.protocolVersion < 0 ||
        message.protocolVersion > 1_024 ||
        !isUuid(message.daemonInstanceId) ||
        !boundedText(message.daemonStartedAt, 128) ||
        !Number.isFinite(Date.parse(message.daemonStartedAt)) ||
        !validRuntimeReport(message.runtime) ||
        (message.draining !== undefined && message.draining !== true)
      ) {
        return null;
      }
      const advertised = parseHostCapabilitiesAdvertisement(message.capabilities)!;
      const normalized = {
        ...(message as HostToServerMessage),
        type: "host:register",
        hostId: message.hostId as string,
        worktrees: message.worktrees as Extract<
          HostToServerMessage,
          { type: "host:register" }
        >["worktrees"],
        ...(message.capabilities !== undefined
          ? {
              capabilities: {
                features: advertised.features,
                maxConcurrentAssignments: advertised.maxConcurrentAssignments,
              },
            }
          : {}),
        ...(message.providerAccountReadiness !== undefined
          ? {
              providerAccountReadiness: sanitizeProviderAccountReadiness(
                message.providerAccountReadiness as ProviderAccountReadiness[],
              ),
            }
          : {}),
      } as HostToServerMessage;
      return normalized;
    }
    if (message.type === "session:ack") {
      return boundedText(message.sessionId) &&
        (message.worktreeId === null || boundedText(message.worktreeId)) &&
        boundedText(message.attemptId)
        ? (message as HostToServerMessage)
        : null;
    }
    if (message.type === "session:command-start") {
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
        optionalText(message.workspaceSlotError, 4_096) &&
        (message.cliResumeRef === undefined || isValidCliResumeRef(message.cliResumeRef)) &&
        (message.result === undefined ||
          (isTerminalSessionStatus(message.status) &&
            normalizeSessionResult(message.result) !== undefined)) &&
        (message.deferTerminalHookResult === undefined || message.deferTerminalHookResult === true)
        ? (message as HostToServerMessage)
        : null;
    }
    if (message.type === "session:log") {
      const timestamp = message.timestamp;
      const stream = message.stream;
      const dropped = message.dropped;
      const droppedOk =
        dropped === undefined ||
        (typeof dropped === "number" &&
          Number.isSafeInteger(dropped) &&
          dropped >= 0 &&
          dropped <= MAX_SESSION_LOG_DROPPED);
      return boundedText(message.sessionId) &&
        boundedText(message.attemptId) &&
        (stream === "stdout" || stream === "stderr" || stream === "system") &&
        typeof message.content === "string" &&
        Buffer.byteLength(message.content) <= MAX_LOG_CHUNK_BYTES &&
        boundedText(timestamp, 128) &&
        Number.isSafeInteger(message.seq) &&
        (message.seq as number) >= 0 &&
        Number.isFinite(Date.parse(timestamp)) &&
        droppedOk
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
    if (message.type === "session:terminal-hook-complete") {
      return boundedText(message.sessionId) &&
        boundedText(message.handoffId) &&
        (message.result === undefined || normalizeSessionResult(message.result) !== undefined)
        ? (message as HostToServerMessage)
        : null;
    }
    return message.type === "host:keepalive" &&
      boundedText(message.hostId) &&
      boundedText(message.at, 128) &&
      Number.isFinite(Date.parse(message.at)) &&
      (message.runningSessions === undefined ||
        (Array.isArray(message.runningSessions) &&
          message.runningSessions.length <= 1_000 &&
          message.runningSessions.every((sessionId) => boundedText(sessionId))))
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
  if (!session) return false;
  if (msg.type === "session:terminal-hook-complete") {
    const stored = plane.state.sessions.get(msg.sessionId);
    return (
      (stored?.terminalHookHandoff?.hostId === hostId &&
        stored.terminalHookHandoff.handoffId === msg.handoffId) ||
      (stored?.terminalHookHandoffSettled?.hostId === hostId &&
        stored.terminalHookHandoffSettled.handoffId === msg.handoffId)
    );
  }
  if (session.hostId === hostId) return true;
  return (
    "attemptId" in msg &&
    msg.attemptId !== undefined &&
    session.attemptId !== undefined &&
    (msg.attemptId !== session.attemptId || session.timedOutHostId === hostId)
  );
}

export function attachHostWsHub(server: HttpServer, plane: ControlPlane): WsHub {
  const bridge = createPlaneWsBridge();
  plane.setOnHostMessage(bridge.onHostMessage);
  return bridge.attach(server, plane);
}
