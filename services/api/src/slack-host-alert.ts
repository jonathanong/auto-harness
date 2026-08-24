import { normalizeSlackNotifications } from "@auto-harness/shared";

import type { ControlPlaneState } from "./control-plane-state.ts";
import type { SlackDeliveryRecord } from "./slack-delivery-types.ts";
import { enqueueSlackDeliveries } from "./slack-outbox.ts";

export function planHostOfflineAlert(input: {
  hostId: string;
  reason: string;
  lastHeartbeatAt: string;
  channel: string;
  now: string;
}): SlackDeliveryRecord {
  return {
    id: `slack:host:${input.hostId}:offline:${input.lastHeartbeatAt}`,
    integrationId: "slack",
    sessionId: `host:${input.hostId}`,
    event: "host_offline",
    operation: "post-root",
    channel: input.channel,
    text: [
      "⚠️ Host offline",
      `Host: ${input.hostId}`,
      `Last heartbeat: ${input.lastHeartbeatAt}`,
      input.reason,
    ].join("\n"),
    status: "pending",
    attempts: 0,
    maxAttempts: 8,
    nextAttemptAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export async function enqueueHostOfflineAlert(
  state: ControlPlaneState,
  input: { hostId: string; reason: string; lastHeartbeatAt: string },
): Promise<void> {
  const storage = state.storage;
  if (!storage || typeof storage.enqueue !== "function") return;
  const record =
    typeof storage.getSlackIntegration === "function"
      ? await storage.getSlackIntegration()
      : state.slackIntegration;
  if (!record?.enabled) return;
  const notifications = normalizeSlackNotifications(record.notifications);
  if (!notifications.onHostOffline) return;
  await enqueueSlackDeliveries(storage, [
    planHostOfflineAlert({
      ...input,
      channel: record.defaultChannel,
      now: state.now(),
    }),
  ]);
}
