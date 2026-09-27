import type { ControlPlaneState } from "./control-plane-state.ts";
import {
  blackboardTransport,
  reportingDelivery,
  sessionReporting,
  type BlackboardTerminalSnapshot,
} from "./blackboard-reporting.ts";
import { processWebhookOutboxBatch } from "./webhook-processor.ts";
import { terminalSnapshotFromStream, type StreamRecord } from "./blackboard-session-stream.ts";
import type { SessionRecord } from "./db/types.ts";

export function isBlackboardSessionStream(event: unknown): event is { Records: StreamRecord[] } {
  if (!event || typeof event !== "object" || !("Records" in event) || !Array.isArray(event.Records))
    return false;
  return (
    event.Records.length <= 100 &&
    event.Records.every((record: StreamRecord) => record?.eventSource === "aws:dynamodb")
  );
}

/** Session commits are the durable event source; only typed allowlisted historical image fields are read, never raw images/logs. */
export async function enqueueBlackboardSession(
  state: ControlPlaneState,
  session: BlackboardTerminalSnapshot,
): Promise<void> {
  const delivery = reportingDelivery(session);
  if (!delivery || !state.storage || !state.blackboardReporting) return;
  await state.storage.enqueueWebhookDelivery({
    sessionId: session.id,
    repositoryId: session.repositoryId || null,
    workspacePoolId: session.workspacePoolId ?? null,
    attemptId: session.attemptId ?? null,
    status: session.status,
    occurredAt: session.completedAt!,
    destination: delivery.destination,
    maxAttempts: delivery.maxAttempts,
    feedback: state.blackboardReporting.snapshot(session, delivery.event.id),
  });
}

export async function processBlackboardSessionStream(
  state: ControlPlaneState,
  event: { Records: StreamRecord[] },
  expectedStreamArn = process.env.HARNESS_SESSION_STREAM_ARN,
): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];
  if (!state.storage) throw new Error("Blackboard stream requires durable storage");
  for (const record of event.Records) {
    if (record.eventName !== "INSERT" && record.eventName !== "MODIFY") continue;
    if (!expectedStreamArn || record.eventSourceARN !== expectedStreamArn)
      throw new Error("unexpected Blackboard session event source");
    const id = record.dynamodb?.Keys?.id?.S;
    const sequence = record.dynamodb?.SequenceNumber;
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9_-]{1,512}$/.test(id) ||
      typeof sequence !== "string" ||
      !/^\d{1,128}$/.test(sequence)
    )
      throw new Error("invalid Blackboard session event");
    try {
      const snapshot = terminalSnapshotFromStream(record);
      if (snapshot && snapshot.id !== id) throw new Error("Blackboard stream identity mismatch");
      if (snapshot) await enqueueBlackboardSession(state, snapshot);
    } catch {
      batchItemFailures.push({ itemIdentifier: sequence });
    }
  }
  return { batchItemFailures };
}

export async function drainBlackboardOutbox(
  state: ControlPlaneState,
  canContinue: () => boolean = () => true,
): Promise<void> {
  if (!state.storage || !state.blackboardReporting) return;
  await processWebhookOutboxBatch(
    state.storage,
    blackboardTransport(state.blackboardReporting),
    {
      lane: "blackboard",
      maxDeliveriesPerTick: 4,
      dueQueryLimit: 4,
      owner: "blackboard-controller",
      baseRetryMs: 60_000,
      maxRetryMs: 15 * 60_000,
    },
    canContinue,
  );
}

/** Receipt reads do not write the session or generate recursive stream events. */
export async function withSessionReporting(
  state: ControlPlaneState,
  session: SessionRecord,
): Promise<SessionRecord> {
  const expected = reportingDelivery(session);
  const delivery =
    expected && state.storage ? await state.storage.getWebhookDelivery(expected.id) : undefined;
  return { ...session, reporting: sessionReporting(session, delivery) };
}
