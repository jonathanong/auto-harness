import type { SessionStatus } from "@auto-harness/shared";

import type { WebhookLeaseFence, WebhookLeaseInput } from "./db/plane-storage-webhook-outbox.ts";
import type {
  DurableWebhookDelivery,
  WebhookDestinationRef,
  WebhookEnqueueInput,
  WebhookEvent,
  WebhookFailureCode,
} from "./webhook-outbox.ts";

export type TerminalSessionStatus = Exclude<SessionStatus, "queued" | "running">;

/** The only session fields visible to destination selection. */
export type WebhookLifecycleSnapshot = {
  sessionId: string;
  repositoryId: string;
  attemptId: string | null;
  status: TerminalSessionStatus;
  occurredAt: string;
};

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
