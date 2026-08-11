import type { IncomingMessage, ServerResponse } from "node:http";

import type { HostWireMessage } from "@auto-harness/shared";

import type { ControlPlane } from "./control-plane.ts";
import type { MemorySessionStore } from "./memory-store.ts";
import type { AuthMode } from "./auth.ts";
import type { AuthService } from "./auth.ts";
import type { Principal } from "./auth.ts";
import type { LocalSchedulerOptions } from "./local-scheduler.ts";
import type { RateLimitConfigOverrides, RateLimitEvent } from "./rate-limit.ts";

const MAX_JSON_BODY_BYTES = 1024 * 1024;

export type LocalServerOptions = {
  port?: number;
  /** Bind interface. Defaults to loopback; public binds require required auth. */
  host?: string;
  authMode?: AuthMode;
  /** Injectable for tests and local account administration. */
  authService?: AuthService;
  store?: MemorySessionStore;
  plane?: ControlPlane;
  publicBaseUrl?: string;
  /**
   * When true (default for startLocalServer), open DynamoDB Local and hydrate.
   * Unit tests may pass an in-process plane without DynamoDB.
   */
  useDynamo?: boolean;
  /** Attach /ws agent hub (default true for startLocalServer). */
  enableWs?: boolean;
  onHostMessage?: (hostId: string, msg: HostWireMessage) => void;
  /** Local EventBridge-equivalent scheduler configuration. */
  scheduler?: LocalSchedulerOptions;
  /** API fixed-window policy. Defaults to the documented safe limits. */
  rateLimitConfig?: RateLimitConfigOverrides;
  /** Injectable wall clock for deterministic boundary tests. */
  rateLimitNow?: () => number;
  /** Only enable when a trusted proxy overwrites X-Forwarded-For. */
  trustProxy?: boolean;
  /** Metrics/log sink; events contain no request body or credential. */
  onRateLimitEvent?: (event: RateLimitEvent) => void;
  /** Per-connection WebSocket messages per second. */
  wsRateLimitPerSecond?: number;
};

export type RouteCtx = {
  plane: ControlPlane;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  principal?: Principal;
};

export function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_JSON_BODY_BYTES) {
        rejected = true;
        req.destroy();
        reject(new Error("request body exceeds 1 MiB"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (rejected) return;
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  if (status === 204) {
    // Keep headers already set (e.g. CORS) — do not pass a headers object.
    res.writeHead(204);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  const len = Buffer.byteLength(payload);
  // Prefer setHeader so prior CORS headers stay; fall back for minimal test fakes.
  if (typeof res.setHeader === "function") {
    res.setHeader("content-type", "application/json");
    res.setHeader("content-length", len);
    res.writeHead(status);
  } else {
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": len,
    });
  }
  res.end(payload);
}

/** Do not expose storage-provider details while returning the documented error envelope. */
export function sendInternalError(res: ServerResponse): void {
  send(res, 500, {
    error: { code: "INTERNAL_ERROR", message: "unable to persist control-plane state" },
  });
}
