import type {
  SlackDeliveryRecord,
  SlackOutboxStore,
  SlackTransport,
  SlackTransportRequest,
} from "./slack-delivery-types.ts";

type SlackOutboxOptions = {
  now?: () => string;
  leaseToken?: () => string;
  leaseMs?: number;
  dependencyDelayMs?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
  onFailure?: (event: {
    id: string;
    operation: SlackDeliveryRecord["operation"];
    status: "retried" | "dead";
    error: string;
  }) => void | Promise<void>;
};

/** Enqueues insert-only stable IDs, so replaying the same lifecycle event is idempotent. */
export async function enqueueSlackDeliveries(
  store: Pick<SlackOutboxStore, "enqueue">,
  deliveries: readonly SlackDeliveryRecord[],
): Promise<{ created: number; existing: number }> {
  let created = 0;
  for (const delivery of deliveries) {
    if ((await store.enqueue(delivery)) === "created") created += 1;
  }
  return { created, existing: deliveries.length - created };
}

/** Claims and processes at most one durable operation. Safe for concurrent workers. */
export async function processSlackOutboxOnce(
  store: SlackOutboxStore,
  transport: SlackTransport,
  options: SlackOutboxOptions = {},
): Promise<"idle" | "deferred" | "sent" | "retried" | "dead"> {
  const now = options.now ?? (() => new Date().toISOString());
  const current = now();
  const leaseToken = (options.leaseToken ?? randomLeaseToken)();
  const claimed = await store.claimDue({
    now: current,
    leaseToken,
    leaseExpiresAt: addMs(current, options.leaseMs ?? 30_000),
  });
  if (!claimed) return "idle";

  const dependencies = await resolveDependencies(store, claimed);
  if (!dependencies.ready) {
    const dead = dependencies.dead;
    const rescheduled = await store.reschedule({
      id: claimed.id,
      leaseToken,
      status: dead ? "dead" : "pending",
      attempts: claimed.attempts,
      nextAttemptAt: addMs(current, options.dependencyDelayMs ?? 1_000),
      error: dependencies.error,
      now: current,
    });
    return rescheduled && dead ? "dead" : "deferred";
  }

  try {
    const result = await transport.deliver(transportRequest(claimed, dependencies.root));
    if (!(await store.complete({ id: claimed.id, leaseToken, result, now: current }))) {
      throw new Error("Slack delivery lease was lost after transport success");
    }
    return "sent";
  } catch (cause) {
    const attempts = claimed.attempts + 1;
    const dead = attempts >= claimed.maxAttempts;
    const backoffMs = retryDelay(
      attempts,
      options.baseRetryMs ?? 1_000,
      options.maxRetryMs ?? 60_000,
    );
    const nextAttemptAt = addMs(current, Math.max(backoffMs, retryAfterMsFrom(cause)));
    const error = errorMessage(cause);
    const rescheduled = await store.reschedule({
      id: claimed.id,
      leaseToken,
      status: dead ? "dead" : "pending",
      attempts,
      nextAttemptAt,
      error,
      now: current,
    });
    if (!rescheduled) return "deferred";
    const status = dead ? ("dead" as const) : ("retried" as const);
    try {
      await options.onFailure?.({
        id: claimed.id,
        operation: claimed.operation,
        status,
        error,
      });
    } catch {
      // Observability cannot block retry or dead-letter.
    }
    return status;
  }
}

type ResolvedDependencies =
  | { ready: true; root: SlackDeliveryRecord | null }
  | { ready: false; dead: boolean; error: string };

async function resolveDependencies(
  store: SlackOutboxStore,
  record: SlackDeliveryRecord,
): Promise<ResolvedDependencies> {
  const legacyStartedReply = await legacyStartedReplyDependency(store, record);
  const dependencyId = legacyStartedReply?.id ?? record.dependsOnId;
  if (dependencyId) {
    const dependency = legacyStartedReply ?? (await store.get(dependencyId));
    const isThreadRoot = dependencyId === record.threadRootId;
    if (dependency?.status === "dead") {
      const isSupersededStartedReply =
        record.operation === "post-reply" &&
        dependency.operation === "post-reply" &&
        dependency.event === "session_started";
      if (isThreadRoot || !isSupersededStartedReply) {
        return { ready: false, dead: true, error: `dependency ${dependencyId} is dead` };
      }
      // A dead "started" reply is superseded for its terminal reply only: the terminal
      // operation still needs the thread root, while later operations such as the final
      // root update must continue to cascade a dead dependency.
    } else if (dependency?.status !== "sent") {
      return { ready: false, dead: false, error: `waiting for ${dependencyId}` };
    }
  }
  if (!record.threadRootId) return { ready: true, root: null };
  const root = await store.get(record.threadRootId);
  if (root?.status === "dead") {
    return { ready: false, dead: true, error: `dependency ${record.threadRootId} is dead` };
  }
  if (root?.status !== "sent" || !root.remoteMessageTs || !root.remoteChannel) {
    return { ready: false, dead: false, error: `waiting for ${record.threadRootId}` };
  }
  return { ready: true, root };
}

/** Existing terminal rows are insert-only and may predate started-reply ordering. */
async function legacyStartedReplyDependency(
  store: SlackOutboxStore,
  record: SlackDeliveryRecord,
): Promise<SlackDeliveryRecord | null> {
  if (
    record.operation !== "post-reply" ||
    record.dependsOnId !== record.threadRootId ||
    !["session_completed", "session_failed", "session_cancelled"].includes(record.event)
  ) {
    return null;
  }
  return store.get(`slack:${record.sessionId}:session_started:reply`);
}

function transportRequest(
  record: SlackDeliveryRecord,
  root: SlackDeliveryRecord | null,
): SlackTransportRequest {
  return {
    idempotencyKey: record.id,
    operation: record.operation,
    channel: root?.remoteChannel ?? record.channel,
    text: record.text,
    ...(record.operation === "post-reply" ? { threadTs: root!.remoteMessageTs } : {}),
    ...(record.operation === "update-root" ? { messageTs: root!.remoteMessageTs } : {}),
  };
}

export function retryDelay(attempts: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempts - 1));
}

function retryAfterMsFrom(cause: unknown): number {
  if (!cause || typeof cause !== "object" || !("retryAfterMs" in cause)) return 0;
  const value = cause.retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function addMs(iso: string, milliseconds: number): string {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

function errorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "Slack transport failed";
  return message.length <= 500 ? message : `${message.slice(0, 499)}…`;
}

function randomLeaseToken(): string {
  return randomUUID();
}
import { randomUUID } from "node:crypto";
