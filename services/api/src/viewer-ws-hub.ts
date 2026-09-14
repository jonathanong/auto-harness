/* eslint-disable max-lines -- viewer ownership, replay, and fan-out form one protocol boundary. */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import { mayAccessRepository } from "./auth-policy.ts";
import type { AuthService, Principal } from "./auth.ts";
import type { ControlPlane } from "./control-plane.ts";
import { settleStorage } from "./control-plane-state.ts";
import { deleteViewerConnection, putViewerConnection } from "./control-plane-user-sessions.ts";
import { viewerConnectionPrincipal } from "./viewer-principal.ts";
import {
  authenticateViewer,
  isAllowedViewerOrigin,
  parseViewerMessage,
  rejectUpgrade,
} from "./viewer-ws-protocol.ts";
import { WebSocketServer, type WebSocket } from "ws";

const MAX_WS_FRAME_BYTES = 16 * 1024;
const MAX_SUBSCRIPTIONS = 8;
const MAX_BUFFERED_BYTES = 512 * 1024;

type Subscription = {
  sessionId: string;
  repositoryId: string | null;
  after?: string;
  status: string;
  hostId?: string;
};

export type ViewerWsHub = {
  viewerCount(): number;
  close(): void;
};

/**
 * Browser logs have a distinct read-only endpoint from the host control
 * channel. A browser socket can only subscribe to sessions it may read.
 */
export function attachViewerWsHub(
  server: HttpServer,
  plane: ControlPlane,
  auth: AuthService,
  options: { pollMs?: number } = {},
): ViewerWsHub {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_FRAME_BYTES });
  const subscriptions = new Map<WebSocket, Map<string, Subscription>>();

  const send = (socket: WebSocket, message: object): boolean => {
    if (socket.readyState !== socket.OPEN) return false;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      socket.close(1013, "viewer backpressure");
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  };
  const viewerCountFor = (sessionId: string): number => {
    let count = 0;
    for (const requested of subscriptions.values()) {
      if (requested.has(sessionId)) count += 1;
    }
    return count;
  };
  const notifyWatch = (sessionId: string, hostId: string | undefined, watching: boolean): void => {
    if (!hostId) return;
    plane.state.onHostMessage?.(hostId, {
      type: watching ? "session:log-watch" : "session:log-unwatch",
      sessionId,
    });
  };
  const publishPart = (event: {
    sessionId: string;
    key: string;
    seqStart: number;
    seqEnd: number;
  }): void => {
    for (const [socket, requested] of subscriptions) {
      if (!requested.has(event.sessionId)) continue;
      send(socket, { type: "session:log-part", ...event });
    }
  };
  const previousOnLogPartCommitted = plane.state.onLogPartCommitted;
  plane.state.onLogPartCommitted = (event) => {
    previousOnLogPartCommitted?.(event);
    publishPart(event);
  };

  const persistBySocket = new Map<WebSocket, () => void>();
  let polling = false;
  const poll = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      for (const persist of persistBySocket.values()) persist();
      for (const [socket, requested] of subscriptions) {
        for (const subscription of requested.values()) {
          try {
            const session = await loadSession(plane, subscription.sessionId);
            if (!session || session.repositoryId !== subscription.repositoryId) {
              socket.close(1008, "session unavailable");
              continue;
            }
            if (session.status !== subscription.status) {
              subscription.status = session.status;
              send(socket, {
                type: "session:status",
                sessionId: subscription.sessionId,
                status: session.status,
              });
            }
          } catch {
            send(socket, {
              type: "session:error",
              code: "TEMPORARY_FAILURE",
              sessionId: subscription.sessionId,
            });
          }
        }
      }
    } finally {
      polling = false;
    }
  };
  const pollTimer = setInterval(() => void poll(), options.pollMs ?? 1_000);
  pollTimer.unref();

  const handleConnection = (socket: WebSocket, principal: Principal | null): void => {
    const requested = new Map<string, Subscription>();
    subscriptions.set(socket, requested);
    const connectionId = randomUUID();
    const connectedAt = new Date().toISOString();
    const persist = (): void => {
      if (!subscriptions.has(socket)) return;
      const now = new Date().toISOString();
      const viewerPrincipal = viewerConnectionPrincipal(principal);
      putViewerConnection(plane.state, {
        connectionId,
        type: "client",
        hostId: principal?.id ?? "anonymous",
        connectedAt,
        lastHeartbeatAt: now,
        ...(viewerPrincipal ? { viewerPrincipal } : {}),
        viewerSubscriptions: [...requested.values()].map(
          ({ sessionId, repositoryId, status, after }) => ({
            sessionId,
            repositoryId,
            status,
            ...(after ? { after } : {}),
          }),
        ),
      });
    };
    persist();
    persistBySocket.set(socket, persist);
    let messageTail: Promise<void> = Promise.resolve();
    socket.on("message", (raw) => {
      const message = parseViewerMessage(raw);
      if (!message) {
        socket.close(1008, "viewer protocol is read-only");
        return;
      }
      if (message.type === "session:unsubscribe") {
        const existing = requested.get(message.sessionId);
        requested.delete(message.sessionId);
        persist();
        if (existing && viewerCountFor(message.sessionId) === 0) {
          notifyWatch(message.sessionId, existing.hostId, false);
        }
        return;
      }
      messageTail = messageTail
        .then(async () => {
          const session = await loadSession(plane, message.sessionId);
          if (!session || !mayAccessRepository(principal ?? undefined, session.repositoryId)) {
            send(socket, {
              type: "session:error",
              code: "NOT_FOUND",
              sessionId: message.sessionId,
            });
            return;
          }
          if (!requested.has(message.sessionId) && requested.size >= MAX_SUBSCRIPTIONS) {
            send(socket, {
              type: "session:error",
              code: "SUBSCRIPTION_LIMIT",
              sessionId: message.sessionId,
            });
            return;
          }
          const firstViewer = viewerCountFor(message.sessionId) === 0;
          const subscription: Subscription = {
            sessionId: message.sessionId,
            repositoryId: session.repositoryId,
            status: session.status,
            ...(session.hostId ? { hostId: session.hostId } : {}),
            ...(message.after ? { after: message.after } : {}),
          };
          requested.set(message.sessionId, subscription);
          persist();
          send(socket, {
            type: "session:subscribed",
            sessionId: message.sessionId,
            cursor: subscription.after ?? null,
            status: subscription.status,
          });
          if (firstViewer) notifyWatch(message.sessionId, session.hostId, true);
        })
        .catch(() => socket.close(1011, "viewer subscription failed"));
    });
    socket.on("close", () => {
      persistBySocket.delete(socket);
      const remaining = [...requested.values()];
      subscriptions.delete(socket);
      deleteViewerConnection(plane.state, connectionId);
      for (const subscription of remaining) {
        if (viewerCountFor(subscription.sessionId) === 0) {
          notifyWatch(subscription.sessionId, subscription.hostId, false);
        }
      }
    });
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws/viewer") return;
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (!isAllowedViewerOrigin(origin, plane.state.publicBaseUrl)) {
      rejectUpgrade(socket);
      return;
    }
    void authenticateViewer(req, auth, plane.state.publicBaseUrl)
      .then((principal) => {
        if (auth.mode === "required" && !principal) {
          rejectUpgrade(socket);
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, principal));
      })
      .catch(() => rejectUpgrade(socket));
  };
  server.on("upgrade", onUpgrade);

  return {
    viewerCount: () => subscriptions.size,
    close: () => {
      server.off("upgrade", onUpgrade);
      plane.state.onLogPartCommitted = previousOnLogPartCommitted;
      clearInterval(pollTimer);
      persistBySocket.clear();
      for (const socket of subscriptions.keys()) socket.close();
      subscriptions.clear();
      wss.close();
      void settleStorage(plane.state);
    },
  };
}

async function loadSession(
  plane: ControlPlane,
  sessionId: string,
): Promise<{ repositoryId: string | null; status: string; hostId?: string } | null> {
  const session = plane.state.storage
    ? await plane.state.storage.getSession(sessionId)
    : (plane.state.sessions.get(sessionId) ?? null);
  if (!session) return null;
  return {
    repositoryId: session.repositoryId,
    status: session.status,
    ...(session.hostId ? { hostId: session.hostId } : {}),
  };
}
