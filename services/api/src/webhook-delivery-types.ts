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
  ) => Promise<WebhookDestinationConfig | null>;
  fetch?: typeof globalThis.fetch;
}): WebhookTransport {
  const fetcher = options.fetch ?? globalThis.fetch;
  return {
    async deliver(request): Promise<WebhookTransportResult> {
      const destination = await options.resolveDestination(request.destination);
      if (!destination) return { ok: false, failureCode: "configuration-unavailable" };
      let response: Response;
      if (process.env.NODE_ENV === "production" && !destination.url.startsWith("https://")) {
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
        response = await fetcher(destination.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [WEBHOOK_SIGNATURE_256_HEADER]: signWebhookBody(destination.secret, request.body),
            [WEBHOOK_EVENT_HEADER]: request.event.id,
            [WEBHOOK_DELIVERY_HEADER]: request.idempotencyKey,
          },
          body: request.body,
          redirect: "error",
          signal: AbortSignal.timeout(destination.timeoutMs ?? DEFAULT_WEBHOOK_REQUEST_TIMEOUT_MS),
        });
      } catch {
        return { ok: false, failureCode: "transient-failure" };
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
