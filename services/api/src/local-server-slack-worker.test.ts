import { expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createDynamoTestCtx } from "./db/dynamo-test-helpers.ts";
import { startLocalServer } from "./local-server.ts";
import { DEFAULT_SLACK_NOTIFICATIONS } from "./slack-integration-types.ts";

const dynamo = createDynamoTestCtx("LocalSlackWorker");
const now = "2026-08-12T10:00:00.000Z";

it("starts the lifecycle worker only with durable storage and an injected transport", async () => {
  if (!dynamo.storage) return;
  await dynamo.storage.putSlackIntegration(
    {
      id: "slack",
      type: "slack",
      encryptedConfig: "unused-ciphertext",
      defaultChannel: "C123",
      enabled: true,
      notifications: DEFAULT_SLACK_NOTIFICATIONS,
      signingSecretConfigured: false,
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    null,
  );
  const plane = new ControlPlane({ storage: dynamo.storage, publicBaseUrl: "https://ui.test" });
  plane.state.repositories.set("repo-1", {
    id: "repo-1",
    name: "auto-harness",
    url: "git@example.test:auto-harness.git",
    defaultBranch: "main",
    createdAt: now,
    updatedAt: now,
  });
  plane.state.sessions.set("session-1", {
    id: "session-1",
    repositoryId: "repo-1",
    prompt: "ship it",
    target: { commandId: "command-1" },
    fallbacks: [],
    targetLabels: ["Codex"],
    queueTtlSeconds: 60,
    queueExpiresAt: now,
    timeout: 60,
    priority: 4,
    requiredLabels: [],
    status: "running",
    queueShard: 0,
    createdAt: now,
    startedAt: now,
  });
  const deliver = vi.fn(async (request: { channel: string; idempotencyKey: string }) => ({
    channel: request.channel,
    messageTs: `ts-${request.idempotencyKey}`,
  }));
  const server = await startLocalServer({
    port: 20_000 + Math.floor(Math.random() * 1_000),
    plane,
    enableWs: false,
    slackTransport: { deliver },
    slackWorker: { intervalMs: 5 },
  });
  try {
    expect(server.slackWorker).toBeDefined();
    await eventually(() => deliver.mock.calls.length === 2);
    expect(deliver.mock.calls.map(([request]) => request.operation)).toEqual([
      "post-root",
      "post-reply",
    ]);
  } finally {
    await server.close();
  }
});

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Slack worker did not drain in time");
}
