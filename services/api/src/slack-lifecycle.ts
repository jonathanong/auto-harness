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

export function planSlackLifecycle(input: {
  event: SlackLifecycleEvent;
  session: SlackSessionSnapshot;
  channel: string;
  notifications: SlackNotifications;
  now: string;
  maxAttempts?: number;
}): SlackDeliveryRecord[] {
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
  const root: SlackDeliveryRecord = {
    ...base,
    id: rootId,
    event: "session_created",
    operation: "post-root",
    text: formatSlackLifecycleMessage("session_created", input.session),
  };
  if (input.event === "session_created") return [root];

  const replyId = `slack:${input.session.id}:${input.event}:reply`;
  const reply: SlackDeliveryRecord = {
    ...base,
    id: replyId,
    event: input.event,
    operation: "post-reply",
    text: formatSlackLifecycleMessage(input.event, input.session),
    threadRootId: rootId,
    dependsOnId: rootId,
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

function enabled(event: SlackLifecycleEvent, notifications: SlackNotifications): boolean {
  if (event === "session_created") return notifications.onSessionCreated;
  if (event === "session_started") return notifications.onSessionStarted;
  if (event === "session_completed") return notifications.onSessionCompleted;
  if (event === "session_cancelled") return notifications.onSessionCancelled;
  return notifications.onSessionFailed;
}
