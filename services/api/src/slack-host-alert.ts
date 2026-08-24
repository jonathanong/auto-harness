import { normalizeSlackNotifications } from "@auto-harness/shared";

import type { SlackDeliveryRecord, SlackOutboxStore } from "./slack-delivery-types.ts";
import type { SlackIntegrationRecord } from "./slack-integration-types.ts";
import { enqueueSlackDeliveries } from "./slack-outbox.ts";

type HostOfflineAlertStore = Pick<SlackOutboxStore, "enqueue"> & {
  getSlackIntegration?: () => Promise<SlackIntegrationRecord | null>;
};

/** Structural slice of control-plane state, kept narrow for alert delivery tests. */
export type HostOfflineAlertState = {
  storage: HostOfflineAlertStore | undefined;
  slackIntegration: SlackIntegrationRecord | undefined;
  now: () => string;
};

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
  state: HostOfflineAlertState,
  input: { hostId: string; reason: string; lastHeartbeatAt: string },
): Promise<void> {
  const storage = state.storage;
  if (!storage) return;
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
