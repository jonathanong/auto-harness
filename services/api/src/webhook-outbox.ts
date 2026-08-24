import { createHash } from "node:crypto";
import { isTerminalSessionStatus, type SessionStatus } from "@auto-harness/shared";

export const DEFAULT_WEBHOOK_MAX_ATTEMPTS = 5;
export const MAX_WEBHOOK_ATTEMPTS = 10;
export const MAX_WEBHOOK_DUE_QUERY = 100;

export type WebhookFailureCode =
  | "configuration-unavailable"
  | "delivery-rejected"
  | "lease-expired"
  | "transient-failure"
  | "unknown";

const WEBHOOK_FAILURE_CODES = new Set<WebhookFailureCode>([
  "configuration-unavailable",
  "delivery-rejected",
  "lease-expired",
  "transient-failure",
  "unknown",
]);

export type WebhookEvent = {
  schemaVersion: 1;
  id: string;
  type: "session.terminal";
  occurredAt: string;
  subject: { type: "session"; id: string };
  data: {
    repositoryId: string;
    /** Null when the session reached terminal state before its first assignment. */
    attemptId: string | null;
    status: SessionStatus;
  };
};

/** A versioned reference only. Endpoint and signing credentials live outside the outbox. */
export type WebhookDestinationRef = {
  configurationId: string;
  configurationVersion: number;
};

type WebhookDeliveryState = "pending" | "leased" | "delivered" | "dead";

export type DurableWebhookDelivery = {
  id: string;
  event: WebhookEvent;
  destination: WebhookDestinationRef;
  state: WebhookDeliveryState;
  createdAt: string;
  updatedAt: string;
  dueAt?: string;
  attemptCount: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseId?: string;
  leaseExpiresAt?: string;
  deliveredAt?: string;
  deadLetteredAt?: string;
  lastFailedAt?: string;
  lastFailureCode?: WebhookFailureCode;
};

export type WebhookEnqueueInput = {
  sessionId: string;
  repositoryId: string;
  attemptId: string | null;
  status: SessionStatus;
  occurredAt: string;
  destination: WebhookDestinationRef;
  maxAttempts?: number;
};

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new TypeError(`${label} must not be empty`);
}

export function assertCanonicalTimestamp(value: string, label: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO-8601 UTC timestamp`);
  }
}

export function assertWebhookQueryLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WEBHOOK_DUE_QUERY) {
    throw new RangeError(`limit must be an integer between 1 and ${MAX_WEBHOOK_DUE_QUERY}`);
  }
}

export function assertWebhookFailureCode(value: string): asserts value is WebhookFailureCode {
  if (!WEBHOOK_FAILURE_CODES.has(value as WebhookFailureCode)) {
    throw new TypeError("failureCode must be a recognized bounded code");
  }
}

function stableId(prefix: string, parts: readonly (null | number | string)[]): string {
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${prefix}_${digest}`;
}

/**
 * Build the exact secret-safe row persisted by the outbox. Extra properties on
 * caller-owned objects are intentionally not copied.
 */
export function createWebhookDelivery(input: WebhookEnqueueInput): DurableWebhookDelivery {
  assertNonEmpty(input.sessionId, "sessionId");
  assertNonEmpty(input.repositoryId, "repositoryId");
  if (input.attemptId !== null) assertNonEmpty(input.attemptId, "attemptId");
  assertNonEmpty(input.destination.configurationId, "configurationId");
  assertCanonicalTimestamp(input.occurredAt, "occurredAt");
  if (!isTerminalSessionStatus(input.status)) {
    throw new TypeError("webhook event status must be terminal");
  }
  if (
    !Number.isInteger(input.destination.configurationVersion) ||
    input.destination.configurationVersion < 1
  ) {
    throw new RangeError("configurationVersion must be a positive integer");
  }
  const maxAttempts = input.maxAttempts ?? DEFAULT_WEBHOOK_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_WEBHOOK_ATTEMPTS) {
    throw new RangeError(`maxAttempts must be an integer between 1 and ${MAX_WEBHOOK_ATTEMPTS}`);
  }

  const eventId = stableId("whe", [
    "session.terminal",
    input.sessionId,
    input.attemptId,
    input.status,
  ]);
  const event: WebhookEvent = {
    schemaVersion: 1,
    id: eventId,
    type: "session.terminal",
    occurredAt: input.occurredAt,
    subject: { type: "session", id: input.sessionId },
    data: {
      repositoryId: input.repositoryId,
      attemptId: input.attemptId,
      status: input.status,
    },
  };
  const destination = {
    configurationId: input.destination.configurationId,
    configurationVersion: input.destination.configurationVersion,
  };
  return {
    id: stableId("whd", [eventId, destination.configurationId, destination.configurationVersion]),
    event,
    destination,
    state: "pending",
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
    dueAt: input.occurredAt,
    attemptCount: 0,
    maxAttempts,
  };
}
