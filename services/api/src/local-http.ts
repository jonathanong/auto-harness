import type { IncomingMessage, ServerResponse } from "node:http";

import type { HostWireMessage } from "@auto-harness/shared";

import type { ControlPlane } from "./control-plane.ts";
import type { MemorySessionStore } from "./memory-store.ts";
import type { AuthMode } from "./auth.ts";
import type { AuthService } from "./auth.ts";
import type { Principal } from "./auth.ts";
import type { AuditActor } from "./audit-types.ts";
import type { LocalSchedulerOptions } from "./local-scheduler.ts";
import type { RateLimitConfigOverrides, RateLimitEvent } from "./rate-limit.ts";
import type { SlackTransport } from "./slack-delivery-types.ts";
import type { SlackLifecycleWorkerOptions } from "./slack-worker.ts";
import type { WebhookDestinationSelector, WebhookTransport } from "./webhook-delivery-types.ts";
import type { WebhookWorkerOptions } from "./webhook-worker.ts";
import type {
  SlackAppCredentials,
  SlackIdentityClient,
  SlackOAuthClient,
} from "./slack-oauth-types.ts";

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const DEFAULT_PUBLIC_BASE_URL = "http://localhost:7421";

/** Configured browser origin. Empty or unset falls back to the local web default. */
export function publicBaseUrlFromEnv(
  value = process.env.HARNESS_PUBLIC_BASE_URL,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolvePublicBaseUrl(value?: string): string {
  return value ?? publicBaseUrlFromEnv() ?? DEFAULT_PUBLIC_BASE_URL;
}

export type LocalServerOptions = {
  port?: number;
  /** Bind interface. Defaults to loopback; public binds require required auth. */
  host?: string;
  authMode?: AuthMode;
  /** Injectable for tests and local account administration. */
  authService?: AuthService;
  store?: MemorySessionStore;
  plane?: ControlPlane;
  /** Browser web origin used for viewer WebSocket Origin checks and session URLs. */
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
  /**
   * Optional outbound boundary. Local/AWS runtimes inject the HTTP transport when
   * credentials can be decrypted; tests may replace it.
   */
  slackTransport?: SlackTransport;
  slackWorker?: SlackLifecycleWorkerOptions;
  /** OAuth app credentials, normally loaded from an environment-scoped SSM parameter. */
  slackAppCredentials?: SlackAppCredentials;
  /** Deployed-only public URL lookup for Slack OAuth; local apps use publicBaseUrl directly. */
  resolveSlackOAuthPublicBaseUrl?: () => Promise<string | undefined>;
  /** Injectable Slack OAuth HTTP boundary. */
  slackOAuthClient?: SlackOAuthClient;
  /** Injectable bounded identity lookup for manual Slack configuration. */
  slackIdentityClient?: SlackIdentityClient;
  /** Secret-safe routing boundary. It returns only immutable configuration references. */
  webhookDestinationSelector?: WebhookDestinationSelector;
  /** Optional outbound boundary. Production supplies no implementation. */
  webhookTransport?: WebhookTransport;
  webhookWorker?: WebhookWorkerOptions;
};

export type RouteCtx = {
  plane: ControlPlane;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  principal?: Principal;
  /** Verified ephemeral credential for exactly this parent session route. */
  sessionParentId?: string;
  /** SHA-256 credential proof used to fence child creation to this running attempt. */
  sessionCredentialHash?: string;
  auditActorOverride?: AuditActor;
};

export function readJson(req: IncomingMessage): Promise<unknown> {
  return readRawBody(req).then((body) => {
    if (body.length === 0) return {};
    return JSON.parse(body.toString("utf8")) as unknown;
  });
}

/** Reads unmodified bytes for signature schemes; callers choose a route-specific cap. */
export function readRawBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxBytes) {
        rejected = true;
        // Keep the connection usable so callers can send the documented 413 response. The
        // data listener remains installed until the request ends, but no further chunks are
        // retained after the bounded prefix has been read.
        req.resume();
        reject(
          new Error(
            maxBytes === MAX_JSON_BODY_BYTES
              ? "request body exceeds 1 MiB"
              : "request body exceeds route limit",
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks));
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
