import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SLACK_NOTIFICATIONS } from "@auto-harness/shared";

import { createControlPlaneState } from "./control-plane-state.ts";
import type { DynamoPlaneStorage } from "./db/plane-storage.ts";
import { enqueueHostOfflineAlert, planHostOfflineAlert } from "./slack-host-alert.ts";

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
    const state = createControlPlaneState({
      storage: {
        enqueue,
        getSlackIntegration: async () => ({
          id: "slack",
          type: "slack",
          encryptedConfig: "x",
          defaultChannel: "#ops",
          enabled: true,
          notifications: DEFAULT_SLACK_NOTIFICATIONS,
          signingSecretConfigured: false,
          version: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      } as unknown as DynamoPlaneStorage,
    });
    await enqueueHostOfflineAlert(state, {
      hostId: "host-1",
      reason: "stale",
      lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    });
    expect(enqueue).toHaveBeenCalledOnce();

    const disabled = createControlPlaneState({
      storage: {
        enqueue,
        getSlackIntegration: async () => ({
          id: "slack",
          type: "slack",
          encryptedConfig: "x",
          defaultChannel: "#ops",
          enabled: true,
          notifications: { ...DEFAULT_SLACK_NOTIFICATIONS, onHostOffline: false },
          signingSecretConfigured: false,
          version: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      } as unknown as DynamoPlaneStorage,
    });
    enqueue.mockClear();
    await enqueueHostOfflineAlert(disabled, {
      hostId: "host-1",
      reason: "stale",
      lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    });
    expect(enqueue).not.toHaveBeenCalled();
    await enqueueHostOfflineAlert(createControlPlaneState(), {
      hostId: "host-1",
      reason: "stale",
      lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    });

    const missing = createControlPlaneState({
      storage: {
        enqueue,
        getSlackIntegration: async () => null,
      } as unknown as DynamoPlaneStorage,
    });
    enqueue.mockClear();
    await enqueueHostOfflineAlert(missing, {
      hostId: "host-1",
      reason: "stale",
      lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    });
    expect(enqueue).not.toHaveBeenCalled();

    const off = createControlPlaneState({
      storage: {
        enqueue,
        getSlackIntegration: async () => ({
          id: "slack",
          type: "slack",
          encryptedConfig: "x",
          defaultChannel: "#ops",
          enabled: false,
          notifications: DEFAULT_SLACK_NOTIFICATIONS,
          signingSecretConfigured: false,
          version: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      } as unknown as DynamoPlaneStorage,
    });
    enqueue.mockClear();
    await enqueueHostOfflineAlert(off, {
      hostId: "host-1",
      reason: "stale",
      lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    });
    expect(enqueue).not.toHaveBeenCalled();

    const cached = createControlPlaneState({
      storage: { enqueue } as unknown as DynamoPlaneStorage,
    });
    cached.slackIntegration = {
      id: "slack",
      type: "slack",
      encryptedConfig: "x",
      defaultChannel: "#ops",
      enabled: true,
      notifications: DEFAULT_SLACK_NOTIFICATIONS,
      signingSecretConfigured: false,
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    enqueue.mockClear();
    await enqueueHostOfflineAlert(cached, {
      hostId: "host-2",
      reason: "stale",
      lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    });
    expect(enqueue).toHaveBeenCalledOnce();
  });
});
