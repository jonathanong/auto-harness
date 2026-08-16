/* eslint-disable max-lines */
import type { HostToServerMessage, HostWireMessage } from "@auto-harness/shared";
import WebSocket from "ws";

import type { DaemonTransport, SendOptions } from "./daemon-transport-types.ts";
import { WsOutboundBuffer, type WsBufferItem } from "./ws-outbound-buffer.ts";
import { writeWs, type RegisterMessage } from "./ws-wire.ts";

type Options = {
  url: string;
  hostId?: string;
  apiKey?: string;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (err: Error) => void;
  socketFactory?: (url: string, options?: ConstructorParameters<typeof WebSocket>[1]) => WebSocket;
  timers?: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
  /** Injectable for deterministic reconnect-jitter tests. */
  random?: () => number;
};

type InflightWrite = { item: WsBufferItem; target: WebSocket; epoch: number };
type LossMarker = {
  message: Extract<HostToServerMessage, { type: "session:log" }>;
  count: number;
  started: boolean;
};

/** Epoch-fenced reconnecting transport. One socket carries exactly one host
 * inventory generation; a refresh restarts the socket, so a registration
 * acknowledgement can never open the barrier for stale inventory. */
export function createWsTransport(options: Options): DaemonTransport & {
  ready: Promise<void>;
  registered: Promise<void>;
} {
  const url = options.hostId
    ? `${options.url}${options.url.includes("?") ? "&" : "?"}hostId=${encodeURIComponent(options.hostId)}`
    : options.url;
  const init = options.apiKey
    ? { headers: { authorization: `Bearer ${options.apiKey}` } }
    : undefined;
  const timers = options.timers ?? globalThis;
  const random = options.random ?? Math.random;
  const factory = options.socketFactory ?? ((target, opts) => new WebSocket(target, opts));
  const lossMarkers = new Map<string, LossMarker>();
  const buffer = new WsOutboundBuffer(
    (log) => {
      recordDroppedLog(log);
    },
    () => pump(),
  );
  let socket: WebSocket | null = null;
  let epoch = 0;
  let registered = false;
  let closed = false;
  let pendingRegister: RegisterMessage | undefined;
  let registerSentEpoch: number | undefined;
  let delay = 1_000;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let inflight: InflightWrite | undefined;
  let messageHandler: ((message: HostWireMessage) => void) | undefined;
  let connectedHandler: (() => void) | undefined;
  let registeredHandler: (() => void) | undefined;
  let disconnectedHandler: (() => void) | undefined;
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  void ready.catch(() => {});
  let registeredResolve: (() => void) | undefined;
  let registeredReject: ((error: Error) => void) | undefined;
  const registeredReady = new Promise<void>((resolve, reject) => {
    registeredResolve = resolve;
    registeredReject = reject;
  });
  void registeredReady.catch(() => {});

  const recordDroppedLog = (log: Extract<HostToServerMessage, { type: "session:log" }>): void => {
    const existing = lossMarkers.get(log.sessionId);
    if (existing && !existing.started) {
      existing.count++;
      existing.message.content = `${existing.count} log chunk(s) dropped while disconnected`;
      return;
    }
    const marker: LossMarker = {
      message: {
        type: "session:log",
        sessionId: log.sessionId,
        stream: "system",
        content: "1 log chunk(s) dropped while disconnected",
        timestamp: new Date().toISOString(),
        seq: Number.MAX_SAFE_INTEGER,
      },
      count: 1,
      started: false,
    };
    lossMarkers.set(log.sessionId, marker);
    void buffer
      .enqueue(marker.message, { nonDroppable: true, onStart: () => (marker.started = true) })
      .catch(() => {})
      .finally(() => {
        if (lossMarkers.get(log.sessionId) === marker) lossMarkers.delete(log.sessionId);
      });
  };

  const retryLater = (): void => {
    // Jitter the wait. A whole fleet loses its sockets at the same instant when the
    // control plane restarts, and an unjittered ladder has every host retrying together
    // on the same 1s/2s/4s boundaries — the reconnect storm lands exactly when the
    // control plane can least absorb it.
    const wait = Math.round(delay * (0.5 + random()));
    delay = Math.min(delay * 2, 60_000);
    retry = timers.setTimeout(() => {
      retry = undefined;
      connect();
    }, wait);
  };

  const settleInflight = (entry: InflightWrite, error?: Error): void => {
    if (inflight === entry) inflight = undefined;
    if (entry.item.cancelled()) {
      buffer.complete(entry.item);
      entry.item.dispose();
      entry.item.reject(new Error("outbound frame cancelled"));
      return;
    }
    if (error) {
      if (entry.item.message.type === "session:log" && !entry.item.nonDroppable) {
        buffer.complete(entry.item);
        entry.item.dispose();
        // Its attempted write never reached the peer. Count it exactly once.
        recordDroppedLog(entry.item.message);
        entry.item.reject(error);
      } else if (closed) {
        buffer.complete(entry.item);
        entry.item.dispose();
        entry.item.reject(error);
      } else {
        buffer.putBack(entry.item);
      }
      return;
    }
    buffer.complete(entry.item);
    entry.item.dispose();
    entry.item.resolve();
  };

  const pump = (): void => {
    if (inflight || !registered || !socket || socket.readyState !== WebSocket.OPEN) return;
    const item = buffer.take();
    if (!item) return;
    const entry: InflightWrite = { item, target: socket, epoch };
    inflight = entry;
    void writeWs(entry.target, JSON.stringify(item.message))
      .then(() => {
        if (inflight !== entry) return;
        settleInflight(entry);
        pump();
      })
      .catch((error: Error) => {
        if (inflight !== entry) return;
        settleInflight(entry, error);
        registered = false;
        entry.target.close(1011, "write failed");
      });
  };

  const sendRegister = (): void => {
    if (
      !pendingRegister ||
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      registerSentEpoch === epoch
    )
      return;
    const target = socket;
    const mine = epoch;
    const snapshot = pendingRegister;
    registerSentEpoch = mine;
    registered = false;
    void writeWs(target, JSON.stringify(snapshot)).catch((error: Error) => {
      if (!closed && mine === epoch && socket === target) {
        options.onError?.(error);
        target.close(1011, "register write failed");
      }
    });
  };

  const disconnected = (target: WebSocket, mine: number, retryAfterClose: boolean): void => {
    if (socket !== target || mine !== epoch) return;
    socket = null;
    registered = false;
    registerSentEpoch = undefined;
    if (inflight?.target === target) settleInflight(inflight, new Error("socket closed"));
    if (closed) return;
    options.onClose?.();
    disconnectedHandler?.();
    if (retryAfterClose) retryLater();
  };

  const refreshSocket = (): void => {
    // The caller has already established an open current socket.
    const target = socket!;
    const mine = epoch;
    disconnected(target, mine, false);
    target.close(1012, "inventory refresh");
    if (!closed) connect();
  };

  const connect = (): void => {
    const mine = ++epoch;
    const target = factory(url, init);
    socket = target;
    target.on("open", () => {
      if (closed || mine !== epoch || socket !== target) return;
      options.onOpen?.();
      readyResolve?.();
      readyResolve = undefined;
      connectedHandler?.();
      sendRegister();
    });
    target.on("error", (error) => {
      if (!closed && mine === epoch && socket === target) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
        target.close(1011, "socket error");
      }
    });
    target.on("close", () => disconnected(target, mine, true));
    target.on("message", (raw) => {
      if (closed || mine !== epoch || socket !== target) return;
      try {
        const message = JSON.parse(String(raw)) as HostWireMessage | { type?: string };
        if (message.type === "host:registered") {
          if (registerSentEpoch !== mine) return;
          registered = true;
          delay = 1_000;
          registeredResolve?.();
          registeredResolve = undefined;
          registeredHandler?.();
          pump();
        } else if (message.type === "error") {
          target.close(1008, "registration rejected");
        } else if (
          registered &&
          ((message.type === "session:acknowledged" &&
            typeof message.sessionId === "string" &&
            message.sessionId.length > 0 &&
            message.sessionId.length <= 512) ||
            message.type === "session:assign" ||
            message.type === "session:cancel" ||
            message.type === "host:draining" ||
            message.type === "host:drain")
        ) {
          messageHandler?.(message as HostWireMessage);
        }
      } catch {
        // Invalid wire input is untrusted.
      }
    });
  };
  connect();
  return {
    ready,
    registered: registeredReady,
    async send(message: HostToServerMessage, sendOptions?: SendOptions) {
      if (closed) throw new Error("WebSocket transport closed");
      if (message.type === "host:register") {
        pendingRegister = message;
        // Never send a second register over one connection: its acknowledgement
        // cannot identify which snapshot it accepted. Restarting is a safe
        // generation boundary and causes the server to requeue unacked work.
        if (socket?.readyState === WebSocket.OPEN && registerSentEpoch === epoch) refreshSocket();
        else sendRegister();
        return;
      }
      const queued = buffer.enqueue(message, sendOptions);
      pump();
      return queued;
    },
    onMessage(handler) {
      messageHandler = handler;
    },
    onConnected(handler) {
      connectedHandler = handler;
    },
    onRegistered(handler) {
      registeredHandler = handler;
    },
    onDisconnected(handler) {
      disconnectedHandler = handler;
    },
    close() {
      closed = true;
      const closeError = new Error("WebSocket transport closed");
      if (retry) timers.clearTimeout(retry);
      if (socket) {
        const target = socket;
        disconnected(target, epoch, false);
        target.close();
      }
      buffer.rejectAll(closeError);
      readyReject?.(closeError);
      registeredReject?.(closeError);
    },
  };
}
