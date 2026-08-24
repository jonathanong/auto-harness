import type { SessionStatus } from "@auto-harness/shared";

export type SlackLifecycleEvent =
  | "session_created"
  | "session_started"
  | "session_completed"
  | "session_failed"
  | "session_cancelled";

export type SlackSessionSnapshot = {
  id: string;
  repositoryName: string;
  prompt: string;
  commandLabel: string;
  priority: number;
  source: string;
  sourceActor?: string;
  url: string;
  status: SessionStatus;
  createdAt: string;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  hostId?: string | null;
  worktreeId?: string | null;
  exitCode?: number | null | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  stderrTail?: string[] | undefined;
};

type SlackDeliveryOperation = "post-root" | "post-reply" | "update-root";
type SlackDeliveryStatus = "pending" | "delivering" | "sent" | "dead";

/** Durable, secret-free operation. The transport resolves thread timestamps at send time. */
export type SlackDeliveryRecord = {
  id: string;
  integrationId: "slack";
  sessionId: string;
  event: SlackLifecycleEvent;
  operation: SlackDeliveryOperation;
  channel: string;
  text: string;
  threadRootId?: string;
  dependsOnId?: string;
  status: SlackDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  remoteChannel?: string;
  remoteMessageTs?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type SlackTransportRequest = {
  idempotencyKey: string;
  operation: SlackDeliveryOperation;
  channel: string;
  text: string;
  threadTs?: string;
  messageTs?: string;
};

export type SlackTransportResult = { channel: string; messageTs: string };

/**
 * A real adapter must use `idempotencyKey` to deduplicate ambiguous retries.
 * `createSlackHttpTransport` is the production adapter.
 */
export interface SlackTransport {
  deliver(request: SlackTransportRequest): Promise<SlackTransportResult>;
}

export interface SlackOutboxStore {
  enqueue(record: SlackDeliveryRecord): Promise<"created" | "exists">;
  claimDue(input: {
    now: string;
    leaseToken: string;
    leaseExpiresAt: string;
  }): Promise<SlackDeliveryRecord | null>;
  get(id: string): Promise<SlackDeliveryRecord | null>;
  complete(input: {
    id: string;
    leaseToken: string;
    result: SlackTransportResult;
    now: string;
  }): Promise<boolean>;
  reschedule(input: {
    id: string;
    leaseToken: string;
    status: "pending" | "dead";
    attempts: number;
    nextAttemptAt: string;
    error: string;
    now: string;
  }): Promise<boolean>;
}
