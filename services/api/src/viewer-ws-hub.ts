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

type Subscription = { sessionId: string; after?: string; repositoryId: string; replaying: boolean };

export type ViewerWsHub = {
  viewerCount(): number;
  close(): void;
};

/**
 * Read-only browser log channel. It intentionally has a separate endpoint and
 * parser from the agent control socket so a browser can never submit host
 * mutations, and an agent credential can never observe browser subscriptions.
 */
export function attachViewerWsHub(
  server: HttpServer,
  plane: ControlPlane,
  auth: AuthService,
  options: { pollMs?: number } = {},
): ViewerWsHub {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_FRAME_BYTES });
  const subscriptions = new Map<WebSocket, Map<string, Subscription>>();

  const sendRecord = (socket: WebSocket, subscription: Subscription, record: LogRecord): void => {
    if (subscription.after && record.timestampSeq <= subscription.after) return;
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      socket.close(1013, "viewer backpressure");
      return;
    }
    socket.send(JSON.stringify({ type: "viewer:log", record }));
    subscription.after = record.timestampSeq;
  };
  const publish = (record: LogRecord): void => {
    for (const [socket, requested] of subscriptions) {
      const subscription = requested.get(record.sessionId);
      if (subscription) sendRecord(socket, subscription, record);
    }
  };
  plane.state.onLogCommitted = publish;

  const drain = async (socket: WebSocket, subscription: Subscription): Promise<void> => {
    if (subscription.replaying) return;
    subscription.replaying = true;
    try {
      for (let page = 0; page < MAX_DRAIN_PAGES; page += 1) {
        const records = await loadTail(plane, subscription.sessionId, subscription.after);
        for (const record of records.toSorted((a, b) =>
          a.timestampSeq.localeCompare(b.timestampSeq),
        ))
          sendRecord(socket, subscription, record);
        if (records.length < TAIL_PAGE_SIZE) return;
      }
    } finally {
      subscription.replaying = false;
    }
  };

  // A callback reaches only this API process. Polling the durable cursor is
  // the cross-worker delivery path: it fills records committed by another
  // worker and any record written between REST bootstrap and subscription.
  let polling = false;
  const poll = async (): Promise<void> => {
    if (polling || !plane.state.storage) return;
    polling = true;
    try {
      for (const [socket, requested] of subscriptions) {
        for (const subscription of requested.values()) {
          const session = await plane.state.storage.getSession(subscription.sessionId);
          if (!session || session.repositoryId !== subscription.repositoryId) {
            socket.close(1008, "session unavailable");
            continue;
          }
          await drain(socket, subscription);
        }
      }
    } catch {
      for (const socket of subscriptions.keys()) {
        if (socket.readyState === socket.OPEN)
          socket.send(JSON.stringify({ type: "viewer:error", code: "TEMPORARY_FAILURE" }));
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
    let messageTail: Promise<void> = Promise.resolve();
    socket.on("message", (raw) => {
      const message = parseViewerMessage(raw);
      if (!message) {
        socket.close(1008, "viewer protocol is read-only");
        return;
      }
      if (message.type === "viewer:unsubscribe") {
        requested.delete(message.sessionId);
        return;
      }
      messageTail = messageTail
        .then(async () => {
          const session = await loadSession(plane, message.sessionId);
          if (!session || !mayAccessRepository(principal ?? undefined, session.repositoryId)) {
            socket.send(JSON.stringify({ type: "viewer:error", code: "NOT_FOUND" }));
            return;
          }
          if (!requested.has(message.sessionId) && requested.size >= MAX_SUBSCRIPTIONS) {
            socket.send(JSON.stringify({ type: "viewer:error", code: "SUBSCRIPTION_LIMIT" }));
            return;
          }
          const subscription = {
            sessionId: message.sessionId,
            repositoryId: session.repositoryId,
            ...(message.after ? { after: message.after } : {}),
            replaying: false,
          };
          requested.set(message.sessionId, subscription);
          // Send the replay before the ready marker. WebSocket frame order is
          // preserved, so a browser cannot observe a fresh tail record ahead
          // of an older replay record from the same subscription.
          await drain(socket, subscription);
          socket.send(
            JSON.stringify({
              type: "viewer:subscribed",
              sessionId: message.sessionId,
              cursor: subscription.after ?? null,
            }),
          );
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
      plane.state.onLogCommitted = undefined;
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
): Promise<{ repositoryId: string } | null> {
  return plane.state.storage
    ? await plane.state.storage.getSession(sessionId)
    : plane.getSession(sessionId);
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
