import { describe, expect, it } from "vitest";

import { createControlPlane } from "./create-plane.ts";
import type { DynamoPlaneStorage } from "./db/plane-storage.ts";
import {
  createDynamoTestCtx,
  putActiveTestRepository,
} from "../test-helpers/dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("CustomWebhookGeneration");
const now = "2026-01-01T00:00:00.000Z";

async function putCatalog(storage: DynamoPlaneStorage, repositoryId: string, commandId: string) {
  await putActiveTestRepository(storage, repositoryId);
  await storage.putCommand({
    id: commandId,
    name: commandId,
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
    createdAt: now,
    updatedAt: now,
  });
}

function integration(id: string, repositoryId: string, commandId: string, generation?: string) {
  return {
    id,
    type: "custom-webhook" as const,
    ...(generation === undefined ? {} : { generation }),
    encryptedSecret: "cipher",
    repositoryId,
    target: { commandId },
    fallbacks: [],
    queueTtlSeconds: 3600,
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    enabled: true,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

describe("durable custom webhook generation fences", () => {
  it("rejects a stale delivery after delete and recreate resets the version", async () => {
    if (!ctx.available || !ctx.storage) return;
    await putCatalog(ctx.storage, "repo-generation", "cmd-generation");
    await ctx.storage.putCustomWebhookIntegration(
      integration("deploy-generation", "repo-generation", "cmd-generation", "old-generation"),
      null,
    );
    expect(await ctx.storage.deleteCustomWebhookIntegration("deploy-generation", 1)).toBe(true);
    await ctx.storage.putCustomWebhookIntegration(
      integration("deploy-generation", "repo-generation", "cmd-generation", "new-generation"),
      null,
    );
    const { plane } = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      idFactory: () => "generation-session",
      now: () => now,
      shardCount: 1,
    });
    await expect(
      plane.getCustomWebhookIntegrationRecord("deploy-generation"),
    ).resolves.not.toBeNull();
    await expect(
      plane.createCustomWebhookSessionDurable(
        {
          repositoryId: "repo-generation",
          prompt: "stale delivery",
          target: { commandId: "cmd-generation" },
          timeout: 30,
          concurrencyId: "webhook:deploy-generation:delivery",
        },
        {
          integrationFence: {
            id: "deploy-generation",
            type: "custom-webhook",
            storageId: "custom-webhook:deploy-generation",
            generation: "old-generation",
            version: 1,
            enabled: true,
          },
        },
      ),
    ).resolves.toMatchObject({ ok: false, code: "CONFLICT" });
    expect(await ctx.storage.listAllSessions()).not.toContainEqual(
      expect.objectContaining({ id: "generation-session" }),
    );
  });

  it("admits a legacy row only while its generation remains absent", async () => {
    if (!ctx.available || !ctx.storage) return;
    await putCatalog(ctx.storage, "repo-legacy-generation", "cmd-legacy-generation");
    for (const id of ["legacy-concurrent", "legacy-plain"]) {
      await ctx.storage.putCustomWebhookIntegration(
        integration(id, "repo-legacy-generation", "cmd-legacy-generation"),
        null,
      );
    }
    let sequence = 0;
    const { plane } = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      idFactory: () => `legacy-generation-session-${++sequence}`,
      now: () => now,
      shardCount: 1,
    });
    for (const [id, concurrencyId] of [
      ["legacy-concurrent", "webhook:legacy-concurrent:delivery"],
      ["legacy-plain", undefined],
    ] as const) {
      await expect(plane.getCustomWebhookIntegrationRecord(id)).resolves.not.toBeNull();
      await expect(
        plane.createCustomWebhookSessionDurable(
          {
            repositoryId: "repo-legacy-generation",
            prompt: "legacy delivery",
            target: { commandId: "cmd-legacy-generation" },
            timeout: 30,
            concurrencyId,
          },
          {
            integrationFence: {
              id,
              type: "custom-webhook",
              storageId: `custom-webhook:${id}`,
              version: 1,
              enabled: true,
            },
          },
        ),
      ).resolves.toMatchObject({ ok: true, created: true });
    }
  });
});
