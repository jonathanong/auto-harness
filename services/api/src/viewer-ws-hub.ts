/* eslint-disable max-lines -- viewer ownership, replay, and fan-out form one protocol boundary. */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import { mayAccessRepository } from "./auth-policy.ts";
import type { AuthService, Principal } from "./auth.ts";
import type { ControlPlane, LogRecord } from "./control-plane.ts";
import { authenticateViewer, parseViewerMessage, rejectUpgrade } from "./viewer-ws-protocol.ts";
import { WebSocketServer, type WebSocket } from "ws";

const MAX_WS_FRAME_BYTES = 16 * 1024;
const MAX_SUBSCRIPTIONS = 8;
const MAX_BUFFERED_BYTES = 512 * 1024;
const TAIL_PAGE_SIZE = 250;
const MAX_DRAIN_PAGES = 4;

type Subscription = {
  sessionId: string;
  repositoryId: string;
  after?: string;
  status: string;
  replaying: boolean;
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
  const sendRecord = (socket: WebSocket, subscription: Subscription, record: LogRecord): void => {
    if (subscription.after && record.timestampSeq <= subscription.after) return;
    if (send(socket, { type: "session:log", ...record })) subscription.after = record.timestampSeq;
  };
  const publish = (record: LogRecord): void => {
    for (const [socket, requested] of subscriptions) {
      const subscription = requested.get(record.sessionId);
      if (subscription) sendRecord(socket, subscription, record);
    }
  };
  const previousOnLogCommitted = plane.state.onLogCommitted;
  const onLogCommitted = (record: LogRecord): void => {
    previousOnLogCommitted?.(record);
    publish(record);
  };
  plane.state.onLogCommitted = onLogCommitted;

  const drain = async (socket: WebSocket, subscription: Subscription): Promise<void> => {
    if (subscription.replaying) return;
    subscription.replaying = true;
    try {
      for (let page = 0; page < MAX_DRAIN_PAGES; page += 1) {
        const records = await loadTail(plane, subscription.sessionId, subscription.after);
        for (const record of records.toSorted((a, b) =>
          a.timestampSeq.localeCompare(b.timestampSeq),
        )) {
          sendRecord(socket, subscription, record);
        }
        if (records.length < TAIL_PAGE_SIZE) break;
      }
    } finally {
      subscription.replaying = false;
    }
  };

  let polling = false;
  const poll = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      for (const [socket, requested] of subscriptions) {
        for (const subscription of requested.values()) {
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
          await drain(socket, subscription);
        }
      }
    } catch {
      for (const socket of subscriptions.keys())
        send(socket, { type: "session:error", code: "TEMPORARY_FAILURE" });
    } finally {
      polling = false;
    }
  };
  const pollTimer = setInterval(() => void poll(), options.pollMs ?? 1_000);
  pollTimer.unref();

  const handleConnection = (socket: WebSocket, principal: Principal | null): void => {
    const requested = new Map<string, Subscription>();
    subscriptions.set(socket, requested);
    let messageTail: Promise<void> = Promise.resolve();
    socket.on("message", (raw) => {
      const message = parseViewerMessage(raw);
      if (!message) {
        socket.close(1008, "viewer protocol is read-only");
        return;
      }
      if (message.type === "session:unsubscribe") {
        requested.delete(message.sessionId);
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
          const subscription: Subscription = {
            sessionId: message.sessionId,
            repositoryId: session.repositoryId,
            status: session.status,
            replaying: false,
            ...(message.after ? { after: message.after } : {}),
          };
          requested.set(message.sessionId, subscription);
          await drain(socket, subscription);
          send(socket, {
            type: "session:subscribed",
            sessionId: message.sessionId,
            cursor: subscription.after ?? null,
            status: subscription.status,
          });
        })
        .catch(() => socket.close(1011, "viewer subscription failed"));
    });
    socket.on("close", () => subscriptions.delete(socket));
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws/viewer") return;
    void authenticateViewer(req, auth)
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
      if (plane.state.onLogCommitted === onLogCommitted) {
        plane.state.onLogCommitted = previousOnLogCommitted;
      }
      clearInterval(pollTimer);
      for (const socket of subscriptions.keys()) socket.close();
      subscriptions.clear();
      wss.close();
    },
  };
}

async function loadSession(
  plane: ControlPlane,
  sessionId: string,
): Promise<{ repositoryId: string; status: string } | null> {
  if (plane.state.storage) return await plane.state.storage.getSession(sessionId);
  return plane.getSession(sessionId);
}

async function loadTail(
  plane: ControlPlane,
  sessionId: string,
  after: string | undefined,
): Promise<LogRecord[]> {
  if (plane.state.storage) {
    return await plane.state.storage.queryLogs(sessionId, {
      ...(after ? { after } : {}),
      limit: TAIL_PAGE_SIZE,
    });
  }
  return plane
    .getLogs(sessionId)
    .filter((record) => !after || record.timestampSeq > after)
    .toSorted((a, b) => a.timestampSeq.localeCompare(b.timestampSeq))
    .slice(0, TAIL_PAGE_SIZE);
}
