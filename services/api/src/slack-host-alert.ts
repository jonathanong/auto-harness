import { normalizeSlackNotifications } from "@auto-harness/shared";

import type { SlackDeliveryRecord, SlackOutboxStore } from "./slack-delivery-types.ts";
import type { SlackIntegrationRecord } from "./slack-integration-types.ts";
import { enqueueSlackDeliveries } from "./slack-outbox.ts";

type HostOfflineAlertStore = Pick<SlackOutboxStore, "enqueue"> & {
  getSlackIntegration?: () => Promise<SlackIntegrationRecord | null>;
  enqueueHostOfflineAlertCandidate?: (
    candidate: HostOfflineAlertCandidate,
    delivery: SlackDeliveryRecord,
  ) => Promise<boolean>;
};

export type HostOfflineAlertCandidate = {
  hostId: string;
  reason: string;
  lastHeartbeatAt: string;
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

async function plannedHostOfflineAlert(
  state: HostOfflineAlertState,
  input: HostOfflineAlertCandidate,
): Promise<SlackDeliveryRecord | undefined> {
  const storage = state.storage;
  if (!storage) return undefined;
  const record =
    typeof storage.getSlackIntegration === "function"
      ? await storage.getSlackIntegration()
      : state.slackIntegration;
  if (!record?.enabled || !normalizeSlackNotifications(record.notifications).onHostOffline) {
    return undefined;
  }
  return planHostOfflineAlert({
    ...input,
    channel: record.defaultChannel,
    now: state.now(),
  });
}

export async function enqueueHostOfflineAlert(
  state: HostOfflineAlertState,
  input: HostOfflineAlertCandidate,
): Promise<void> {
  const storage = state.storage;
  const delivery = await plannedHostOfflineAlert(state, input);
  if (!storage || !delivery) return;
  await enqueueSlackDeliveries(storage, [delivery]);
}

/**
 * Atomically inserts the idempotent outbox item and clears the exact durable
 * offline observation when the backing store supports it. A competing host
 * registration that clears the candidate wins the fence and yields `lost`.
 */
export async function enqueueFencedHostOfflineAlert(
  state: HostOfflineAlertState,
  input: HostOfflineAlertCandidate,
): Promise<"enqueued" | "skipped" | "lost"> {
  const storage = state.storage;
  const delivery = await plannedHostOfflineAlert(state, input);
  if (!storage || !delivery) return "skipped";
  if (typeof storage.enqueueHostOfflineAlertCandidate !== "function") {
    await enqueueSlackDeliveries(storage, [delivery]);
    return "enqueued";
  }
  return (await storage.enqueueHostOfflineAlertCandidate(input, delivery)) ? "enqueued" : "lost";
}
