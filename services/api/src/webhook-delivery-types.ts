import { createHmac } from "node:crypto";

import type { SessionTerminalStatus } from "@auto-harness/shared";

import type { WebhookLeaseFence, WebhookLeaseInput } from "./db/plane-storage-webhook-outbox.ts";
import type {
  DurableWebhookDelivery,
  WebhookDestinationRef,
  WebhookEnqueueInput,
  WebhookEvent,
  WebhookFailureCode,
} from "./webhook-outbox.ts";

/** The only session fields visible to destination selection. */
export type WebhookLifecycleSnapshot = {
  sessionId: string;
  /** Null for a non-Git workspace session. */
  repositoryId: string | null;
  /** Null for repository-backed work. */
  workspacePoolId: string | null;
  /** Null before assignment; completed attempts retain their final slot through resolvedRoute. */
  workspaceSlotId: string | null;
  attemptId: string | null;
  status: SessionTerminalStatus;
  occurredAt: string;
};

/**
 * Historical resolver: the same snapshot must return the same immutable
 * configuration references forever, including after rotation and restart.
 * Implementations resolve the versions that were effective at occurredAt,
 * never whichever versions happen to be current when reconciliation runs.
 */
export type WebhookDestinationSelector = (
  snapshot: WebhookLifecycleSnapshot,
) => Promise<readonly WebhookDestinationRef[]>;

export type WebhookTransportRequest = {
  /** Stable across ambiguous retries; transports must use it for deduplication. */
  idempotencyKey: string;
  destination: WebhookDestinationRef;
  event: WebhookEvent;
  /** Exact bytes a future transport may sign and send. */
  body: string;
  /** Exact durable-lease deadline; transport work must settle before it. */
  leaseExpiresAt?: string;
};

export type WebhookTransportResult =
  | { ok: true }
  | {
      ok: false;
      failureCode: Exclude<WebhookFailureCode, "lease-expired">;
    };

export type WebhookTransport = {
  deliver(request: WebhookTransportRequest): Promise<WebhookTransportResult>;
};

/** Stable wire contract shared by generic outbound consumers and custom inbound senders. */
export const WEBHOOK_SIGNATURE_256_HEADER = "x-auto-harness-signature-256";
export const WEBHOOK_EVENT_HEADER = "x-auto-harness-event";
export const WEBHOOK_DELIVERY_HEADER = "x-auto-harness-delivery";
/** Leave time to record the outcome before the worker's 30-second delivery lease expires. */
export const DEFAULT_WEBHOOK_REQUEST_TIMEOUT_MS = 25_000;
/** Reserve time to conditionally record a result while the delivery lease is still live. */
const WEBHOOK_LEASE_SETTLEMENT_MARGIN_MS = 1_000;

export function signWebhookBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

export type WebhookDestinationConfig = {
  url: string;
  secret: string;
  timeoutMs?: number;
};

/** HTTP boundary for production outbound delivery; secret resolution stays outside the outbox. */
export function createSignedWebhookTransport(options: {
  resolveDestination: (
    destination: WebhookDestinationRef,
    signal: AbortSignal,
  ) => Promise<WebhookDestinationConfig | null>;
  fetch?: typeof globalThis.fetch;
  /** Local development/test only; production always requires HTTPS. */
  allowInsecureHttp?: boolean;
}): WebhookTransport {
  const fetcher = options.fetch ?? globalThis.fetch;
  return {
    async deliver(request): Promise<WebhookTransportResult> {
      const remaining = request.leaseExpiresAt
        ? Date.parse(request.leaseExpiresAt) - Date.now() - WEBHOOK_LEASE_SETTLEMENT_MARGIN_MS
        : DEFAULT_WEBHOOK_REQUEST_TIMEOUT_MS;
      if (!Number.isFinite(remaining) || remaining <= 0) {
        return { ok: false, failureCode: "transient-failure" };
      }
      const signal = AbortSignal.timeout(remaining);
      let destination: WebhookDestinationConfig | null;
      try {
        destination = await abortable(
          options.resolveDestination(request.destination, signal),
          signal,
        );
      } catch {
        return { ok: false, failureCode: "transient-failure" };
      }
      if (!destination) return { ok: false, failureCode: "configuration-unavailable" };
      let response: Response;
      if (
        !isHttps(destination.url) &&
        !(options.allowInsecureHttp && process.env.NODE_ENV !== "production")
      ) {
        return { ok: false, failureCode: "configuration-unavailable" };
      }
      if (
        destination.timeoutMs !== undefined &&
        (!Number.isFinite(destination.timeoutMs) ||
          destination.timeoutMs <= 0 ||
          destination.timeoutMs > DEFAULT_WEBHOOK_REQUEST_TIMEOUT_MS)
      ) {
        return { ok: false, failureCode: "configuration-unavailable" };
      }
      try {
        const requestTimeout = Math.min(
          destination.timeoutMs ?? DEFAULT_WEBHOOK_REQUEST_TIMEOUT_MS,
          request.leaseExpiresAt
            ? Date.parse(request.leaseExpiresAt) - Date.now() - WEBHOOK_LEASE_SETTLEMENT_MARGIN_MS
            : DEFAULT_WEBHOOK_REQUEST_TIMEOUT_MS,
        );
        if (!Number.isFinite(requestTimeout) || requestTimeout <= 0)
          return { ok: false, failureCode: "transient-failure" };
        response = await fetcher(destination.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [WEBHOOK_SIGNATURE_256_HEADER]: signWebhookBody(destination.secret, request.body),
            [WEBHOOK_EVENT_HEADER]: request.event.id,
            [WEBHOOK_DELIVERY_HEADER]: request.idempotencyKey,
          },
          body: request.body,
          redirect: "manual",
          signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeout)]),
        });
      } catch {
        return { ok: false, failureCode: "transient-failure" };
      }
      if (response.status >= 300 && response.status < 400) {
        return { ok: false, failureCode: "delivery-rejected" };
      }
      if (response.ok) return { ok: true };
      return {
        ok: false,
        failureCode:
          response.status === 408 || response.status === 429 || response.status >= 500
            ? "transient-failure"
            : "delivery-rejected",
      };
    },
  };
}

function isHttps(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export type WebhookOutboxStore = {
  enqueueWebhookDelivery(input: WebhookEnqueueInput): Promise<{
    created: boolean;
    delivery: DurableWebhookDelivery;
  }>;
  listDueWebhookDeliveries(input: {
    state: "pending" | "leased";
    now: string;
    limit: number;
  }): Promise<DurableWebhookDelivery[]>;
  claimWebhookDelivery(input: WebhookLeaseInput): Promise<DurableWebhookDelivery | null>;
  completeWebhookDelivery(input: WebhookLeaseFence): Promise<boolean>;
  failWebhookDelivery(
    input: WebhookLeaseFence & {
      failureCode: WebhookFailureCode;
      nextAttemptAt: string;
    },
  ): Promise<"pending" | "dead" | null>;
  deadLetterExhaustedWebhookDelivery(input: { id: string; now: string }): Promise<boolean>;
};

export type WebhookWorkerOptions = {
  intervalMs?: number;
  maxDeliveriesPerTick?: number;
  maxSessionsPerTick?: number;
  dueQueryLimit?: number;
  leaseMs?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
  now?: () => string;
  leaseId?: () => string;
  owner?: string;
  onError?: (error: unknown) => void;
};
