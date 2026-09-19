import type { SessionStatus } from "@auto-harness/shared";

import type { SlackNotifications } from "./slack-integration-types.ts";
import { formatSlackFinalRoot, formatSlackLifecycleMessage } from "./slack-message-format.ts";
import type {
  SlackDeliveryRecord,
  SlackLifecycleEvent,
  SlackSessionSnapshot,
} from "./slack-delivery-types.ts";

export function slackLifecycleEvent(
  previous: SessionStatus | undefined,
  current: SessionStatus,
): SlackLifecycleEvent | null {
  if (previous === undefined) return "session_created";
  if (previous === current) return null;
  if (current === "running") return "session_started";
  if (current === "completed") return "session_completed";
  if (current === "cancelled") return "session_cancelled";
  if (current === "failed" || current === "timed_out") return "session_failed";
  return null;
}

/**
 * Ordering policy: within one session's thread, a lifecycle reply must never post while
 * an *earlier* lifecycle reply for the same thread is still pending — otherwise a delay
 * on one event (e.g. the root retrying `not_in_channel`) can let a later event's reply
 * race ahead. Only "started" can precede a terminal reply (created always becomes the
 * root or is skipped), so the terminal reply's `dependsOnId` chains to the started
 * reply's deterministic id *when that reply exists*, found with a bounded point `get` —
 * never a scan. Two cases must not wedge a terminal reply forever:
 *   - Never created (onSessionStarted disabled, or the session was cancelled while
 *     queued and never ran): the point `get` finds nothing, so this falls back to
 *     depending on the thread root instead — identical to today's behavior.
 *   - Dead (the started reply exhausted every attempt): it is superseded, not a
 *     cascade — see the `isThreadRoot` branch in `resolveDependencies`
 *     (slack-outbox.ts), which lets a terminal reply proceed once the thread root
 *     itself is sent, rather than dying alongside a sibling that will never send.
 * A dead *root*, by contrast, must still cascade: there is no thread to post into.
 */
export async function planSlackLifecycle(input: {
  event: SlackLifecycleEvent;
  session: SlackSessionSnapshot;
  channel: string;
  notifications: SlackNotifications;
  now: string;
  maxAttempts?: number;
  getDelivery?: (id: string) => Promise<SlackDeliveryRecord | null>;
}): Promise<SlackDeliveryRecord[]> {
  if (!enabled(input.event, input.notifications)) return [];
  const rootId = `slack:${input.session.id}:thread`;
  const base = {
    integrationId: "slack" as const,
    sessionId: input.session.id,
    channel: input.channel,
    status: "pending" as const,
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 8,
    nextAttemptAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
  };
  const rootEvent = rootEventFor(input);
  const root: SlackDeliveryRecord = {
    ...base,
    id: rootId,
    event: rootEvent,
    operation: "post-root",
    text:
      rootEvent === input.event && isTerminalEvent(rootEvent)
        ? formatSlackFinalRoot(input.session)
        : formatSlackLifecycleMessage(rootEvent, input.session),
  };
  if (rootEvent === input.event) return [root];

  const replyId = `slack:${input.session.id}:${input.event}:reply`;
  const replyDependsOnId =
    input.event === "session_started" ? rootId : await precedingReplyDependency(input, rootId);
  const reply: SlackDeliveryRecord = {
    ...base,
    id: replyId,
    event: input.event,
    operation: "post-reply",
    text: formatSlackLifecycleMessage(input.event, input.session),
    threadRootId: rootId,
    dependsOnId: replyDependsOnId,
  };
  if (input.event === "session_started") return [root, reply];
  return [
    root,
    reply,
    {
      ...base,
      id: `slack:${input.session.id}:${input.event}:update`,
      event: input.event,
      operation: "update-root",
      text: formatSlackFinalRoot(input.session),
      threadRootId: rootId,
      dependsOnId: replyId,
    },
  ];
}

async function precedingReplyDependency(
  input: {
    session: SlackSessionSnapshot;
    getDelivery?: (id: string) => Promise<SlackDeliveryRecord | null>;
  },
  rootId: string,
): Promise<string> {
  if (!input.getDelivery) return rootId;
  const precedingReplyId = `slack:${input.session.id}:session_started:reply`;
  const preceding = await input.getDelivery(precedingReplyId);
  return preceding ? precedingReplyId : rootId;
}

function rootEventFor(input: {
  event: SlackLifecycleEvent;
  session: SlackSessionSnapshot;
  notifications: SlackNotifications;
}): SlackLifecycleEvent {
  if (input.notifications.onSessionCreated) return "session_created";
  if (input.event !== "session_created" && input.notifications.onSessionStarted) {
    if (input.event === "session_started" || input.session.startedAt) return "session_started";
  }
  return input.event;
}

function isTerminalEvent(event: SlackLifecycleEvent): boolean {
  return (
    event === "session_completed" || event === "session_cancelled" || event === "session_failed"
  );
}

function enabled(event: SlackLifecycleEvent, notifications: SlackNotifications): boolean {
  if (event === "session_created") return notifications.onSessionCreated;
  if (event === "session_started") return notifications.onSessionStarted;
  if (event === "session_completed") return notifications.onSessionCompleted;
  if (event === "session_cancelled") return notifications.onSessionCancelled;
  return notifications.onSessionFailed;
}
