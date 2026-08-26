import { expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createDynamoTestCtx } from "./db/dynamo-test-helpers.ts";
import { startLocalServer } from "./local-server.ts";

const dynamo = createDynamoTestCtx("LocalWebhookWorker");
const now = "2026-08-15T12:00:00.000Z";

it("starts the webhook worker only with durable storage and both injected boundaries", async () => {
  if (!dynamo.storage) return;
  const plane = new ControlPlane({ storage: dynamo.storage });
  plane.state.sessions.set("session-1", {
    id: "session-1",
    repositoryId: "repository-1",
    prompt: "must not be transported",
    target: { commandId: "command-1" },
    fallbacks: [],
    targetDisplayNames: ["Codex"],
    queueTtlSeconds: 60,
    queueExpiresAt: now,
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: "cancelled",
    queueShard: 0,
    createdAt: now,
    completedAt: now,
  });
  const deliver = vi.fn(async () => ({ ok: true }) as const);
  const selectDestinations = vi.fn(async () => [
    { configurationId: "operations", configurationVersion: 4 },
  ]);
  const server = await startLocalServer({
    port: 22_000 + Math.floor(Math.random() * 1_000),
    plane,
    enableWs: false,
    webhookDestinationSelector: selectDestinations,
    webhookTransport: { deliver },
    webhookWorker: { intervalMs: 5, now: () => now, leaseId: () => "lease-1" },
  });
  try {
    expect(server.webhookWorker).toBeDefined();
    await eventually(() => deliver.mock.calls.length === 1);
    expect(selectDestinations).toHaveBeenCalledWith({
      sessionId: "session-1",
      repositoryId: "repository-1",
      attemptId: null,
      status: "cancelled",
      occurredAt: now,
    });
    expect(deliver.mock.calls[0]![0]).toMatchObject({
      destination: { configurationId: "operations", configurationVersion: 4 },
      event: { data: { attemptId: null, status: "cancelled" } },
    });
  } finally {
    await server.close();
  }

  const missingTransport = await startLocalServer({
    port: 23_000 + Math.floor(Math.random() * 1_000),
    plane,
    enableWs: false,
    webhookDestinationSelector: selectDestinations,
  });
  try {
    expect(missingTransport.webhookWorker).toBeUndefined();
  } finally {
    await missingTransport.close();
  }
});

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Webhook worker did not drain in time");
}
