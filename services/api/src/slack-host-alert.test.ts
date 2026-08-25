import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SLACK_NOTIFICATIONS } from "@auto-harness/shared";

import type { SlackIntegrationRecord } from "./slack-integration-types.ts";
import {
  enqueueFencedHostOfflineAlert,
  enqueueHostOfflineAlert,
  planHostOfflineAlert,
  type HostOfflineAlertState,
} from "./slack-host-alert.ts";

const now = "2026-01-01T00:00:00.000Z";

function slackRecord(overrides: Partial<SlackIntegrationRecord> = {}): SlackIntegrationRecord {
  return {
    id: "slack",
    type: "slack",
    encryptedConfig: "x",
    defaultChannel: "#ops",
    enabled: true,
    notifications: DEFAULT_SLACK_NOTIFICATIONS,
    signingSecretConfigured: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function alertState(
  storage: HostOfflineAlertState["storage"] = undefined,
  slackIntegration: SlackIntegrationRecord | undefined = undefined,
): HostOfflineAlertState {
  return { storage, slackIntegration, now: () => now };
}

describe("host offline Slack alerts", () => {
  it("plans a standalone channel post", () => {
    expect(
      planHostOfflineAlert({
        hostId: "host-1",
        reason: "agent heartbeat stale; requeued",
        lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
        channel: "#ops",
        now: "2026-01-01T00:01:00.000Z",
      }),
    ).toMatchObject({
      event: "host_offline",
      operation: "post-root",
      sessionId: "host:host-1",
      channel: "#ops",
    });
  });

  it("enqueues when Slack host-offline alerts are enabled", async () => {
    const enqueue = vi.fn(async () => "created" as const);
    await enqueueHostOfflineAlert(
      alertState({ enqueue, getSlackIntegration: async () => slackRecord() }),
      {
        hostId: "host-1",
        reason: "stale",
        lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
      },
    );
    expect(enqueue).toHaveBeenCalledOnce();

    const disabled = alertState({
      enqueue,
      getSlackIntegration: async () =>
        slackRecord({ notifications: { ...DEFAULT_SLACK_NOTIFICATIONS, onHostOffline: false } }),
    });
    enqueue.mockClear();
    await enqueueHostOfflineAlert(disabled, {
      hostId: "host-1",
      reason: "stale",
      lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    });
    expect(enqueue).not.toHaveBeenCalled();
    await enqueueHostOfflineAlert(alertState(), {
      hostId: "host-1",
      reason: "stale",
      lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    });

    const missing = alertState({ enqueue, getSlackIntegration: async () => null });
    enqueue.mockClear();
    await enqueueHostOfflineAlert(missing, {
      hostId: "host-1",
      reason: "stale",
      lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    });
    expect(enqueue).not.toHaveBeenCalled();

    const off = alertState({
      enqueue,
      getSlackIntegration: async () => slackRecord({ enabled: false }),
    });
    enqueue.mockClear();
    await enqueueHostOfflineAlert(off, {
      hostId: "host-1",
      reason: "stale",
      lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    });
    expect(enqueue).not.toHaveBeenCalled();

    const cached = alertState({ enqueue }, slackRecord());
    enqueue.mockClear();
    await enqueueHostOfflineAlert(cached, {
      hostId: "host-2",
      reason: "stale",
      lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("uses the regular outbox when the storage has no atomic candidate adapter", async () => {
    const enqueue = vi.fn(async () => "created" as const);
    await expect(
      enqueueFencedHostOfflineAlert(
        alertState({ enqueue, getSlackIntegration: async () => slackRecord() }),
        {
          hostId: "host-fallback",
          reason: "stale",
          lastHeartbeatAt: now,
        },
      ),
    ).resolves.toBe("enqueued");
    expect(enqueue).toHaveBeenCalledOnce();
  });
});
