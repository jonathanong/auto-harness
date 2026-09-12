/* eslint-disable max-lines -- storage CAS variants share one command fixture. */
import { describe, expect, it, vi } from "vitest";

import {
  deleteCustomWebhookIntegration,
  deleteSlackIntegration,
  getSlackIntegration,
  getCustomWebhookIntegration,
  listCustomWebhookIntegrations,
  putCustomWebhookIntegration,
  putSlackIntegration,
} from "./plane-storage-integrations.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

const record = {
  id: "slack" as const,
  type: "slack" as const,
  encryptedConfig: "ciphertext",
  defaultChannel: "C1",
  enabled: true,
  notifications: {
    onSessionCreated: true,
    onSessionStarted: true,
    onSessionCompleted: true,
    onSessionFailed: true,
    onSessionCancelled: true,
    onScheduleCompleted: false,
  },
  signingSecretConfigured: false,
  version: 1,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
};

function ctx(send: ReturnType<typeof vi.fn>): PlaneStorageCtx {
  return {
    doc: { send } as never,
    tables: { integrations: "Integrations", concurrencyLocks: "Locks" } as never,
  };
}

describe("Slack integration storage failures", () => {
  it("adds the installation identity to the conditional update when supplied", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(putSlackIntegration(ctx(send), record, 1, "installation-1")).resolves.toBe(true);
    const command = send.mock.calls[0]?.[0] as {
      input: {
        ConditionExpression?: string;
        ExpressionAttributeValues?: Record<string, unknown>;
      };
    };
    expect(command.input.ConditionExpression).toContain("installationId = :expectedInstallationId");
    expect(command.input.ExpressionAttributeValues).toMatchObject({
      ":expectedInstallationId": "installation-1",
    });
  });

  it("can fence an identity-less legacy row explicitly", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(putSlackIntegration(ctx(send), record, 1, null)).resolves.toBe(true);
    const command = send.mock.calls[0]?.[0] as { input: { ConditionExpression?: string } };
    expect(command.input.ConditionExpression).toContain("attribute_not_exists(installationId)");
  });

  it("keeps ordinary version fencing independent of installation identity", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(putSlackIntegration(ctx(send), record, 1)).resolves.toBe(true);
    const command = send.mock.calls[0]?.[0] as { input: { ConditionExpression?: string } };
    expect(command.input.ConditionExpression).toBe(
      "attribute_exists(id) AND version = :expectedVersion",
    );
  });

  it("propagates non-conditional put and delete failures", async () => {
    const failure = new Error("integrations unavailable");
    await expect(
      putSlackIntegration(ctx(vi.fn().mockRejectedValue(failure)), record, null),
    ).rejects.toBe(failure);
    await expect(deleteSlackIntegration(ctx(vi.fn().mockRejectedValue(failure)), 1)).rejects.toBe(
      failure,
    );
  });

  it("maps conditional CAS outcomes for writes", async () => {
    const conditional = { name: "ConditionalCheckFailedException" };
    await expect(
      putSlackIntegration(ctx(vi.fn().mockRejectedValue(conditional)), record, null),
    ).resolves.toBe(false);
    await expect(
      putSlackIntegration(ctx(vi.fn().mockRejectedValue(conditional)), record, 1),
    ).resolves.toBe(false);
    await expect(
      deleteSlackIntegration(ctx(vi.fn().mockRejectedValue(conditional)), 1),
    ).resolves.toBe(false);
  });

  it("returns null when the Slack row is absent", async () => {
    await expect(getSlackIntegration(ctx(vi.fn().mockResolvedValue({})))).resolves.toBeNull();
  });
});

describe("custom webhook integration storage", () => {
  it("uses a namespace separate from the Slack singleton and restores the public id", async () => {
    const sends: unknown[] = [];
    const customRecord = {
      id: "slack",
      type: "custom-webhook" as const,
      generation: "generation",
      encryptedSecret: "ciphertext",
      repositoryId: "repo",
      target: { providerId: "provider" },
      fallbacks: [],
      queueTtlSeconds: 60,
      timeout: 60,
      priority: 0,
      requiredLabels: [],
      enabled: true,
      version: 1,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    };
    const storage = ctx(
      vi.fn(async (command: { input?: Record<string, unknown> }) => {
        sends.push(command.input);
        if (command.input?.Key) return { Item: { ...customRecord, id: "custom-webhook:slack" } };
        return {};
      }),
    );
    expect(await putCustomWebhookIntegration(storage, customRecord, null)).toBe(true);
    expect(await getCustomWebhookIntegration(storage, "slack")).toMatchObject({ id: "slack" });
    expect(await deleteCustomWebhookIntegration(storage, "slack", 1)).toBe(true);
    expect(sends).toEqual([
      expect.objectContaining({ Item: expect.objectContaining({ id: "custom-webhook:slack" }) }),
      expect.objectContaining({ Key: { id: "custom-webhook:slack" }, ConsistentRead: true }),
      expect.objectContaining({ Key: { id: "custom-webhook:slack" } }),
    ]);
  });

  it("rejects rows of another type and handles empty scans", async () => {
    await expect(
      getCustomWebhookIntegration(
        ctx(vi.fn().mockResolvedValue({ Item: { id: "custom-webhook:wrong", type: "slack" } })),
        "wrong",
      ),
    ).resolves.toBeNull();
    await expect(
      listCustomWebhookIntegrations(ctx(vi.fn().mockResolvedValue({ Items: undefined }))),
    ).resolves.toEqual([]);
  });

  it("covers the generation and conditional-write variants", async () => {
    const base = {
      id: "deploy",
      type: "custom-webhook" as const,
      generation: "generation",
      encryptedSecret: "ciphertext",
      repositoryId: "repo",
      target: { providerId: "provider" },
      fallbacks: [],
      queueTtlSeconds: 60,
      timeout: 60,
      priority: 0,
      requiredLabels: [],
      enabled: true,
      version: 1,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    };
    const commands: unknown[] = [];
    const send = vi.fn(async (command: { input?: unknown }) => {
      commands.push(command.input);
      return {};
    });
    await expect(putCustomWebhookIntegration(ctx(send), base, null)).resolves.toBe(true);
    await expect(putCustomWebhookIntegration(ctx(send), base, 1)).resolves.toBe(true);
    await expect(putCustomWebhookIntegration(ctx(send), base, 1, undefined, null)).resolves.toBe(
      true,
    );
    await expect(
      putCustomWebhookIntegration(ctx(send), base, 1, undefined, "generation"),
    ).resolves.toBe(true);
    await expect(deleteCustomWebhookIntegration(ctx(send), "deploy", 1)).resolves.toBe(true);
    await expect(deleteCustomWebhookIntegration(ctx(send), "deploy", 1, null)).resolves.toBe(true);
    await expect(
      deleteCustomWebhookIntegration(ctx(send), "deploy", 1, "generation"),
    ).resolves.toBe(true);
    expect(commands).toHaveLength(7);
    expect(commands[0]).toMatchObject({ ConditionExpression: "attribute_not_exists(id)" });
    expect(commands[3]).toMatchObject({
      ExpressionAttributeValues: { ":expectedGeneration": "generation" },
    });
    expect(commands[5]).toMatchObject({
      ConditionExpression: expect.stringContaining("attribute_not_exists(#generation)"),
    });
  });

  it("maps conditional outcomes and propagates other storage errors", async () => {
    const conditional = { name: "ConditionalCheckFailedException" };
    const transactionConditional = {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
    };
    const failure = new Error("storage unavailable");
    await expect(
      putCustomWebhookIntegration(
        ctx(vi.fn().mockRejectedValue(conditional)),
        {
          ...record,
          id: "deploy",
          type: "custom-webhook",
        } as never,
        null,
      ),
    ).resolves.toBe(false);
    await expect(
      putCustomWebhookIntegration(
        ctx(vi.fn().mockRejectedValue(failure)),
        {
          ...record,
          id: "deploy",
          type: "custom-webhook",
        } as never,
        null,
      ),
    ).rejects.toBe(failure);
    await expect(
      deleteCustomWebhookIntegration(ctx(vi.fn().mockRejectedValue(conditional)), "deploy", 1),
    ).resolves.toBe(false);
    await expect(
      deleteCustomWebhookIntegration(ctx(vi.fn().mockRejectedValue(failure)), "deploy", 1),
    ).rejects.toBe(failure);
    await expect(
      putCustomWebhookIntegration(
        ctx(vi.fn().mockRejectedValue(transactionConditional)),
        {
          ...record,
          id: "deploy",
          type: "custom-webhook",
        } as never,
        1,
        [{ key: "repository:repo", owner: "owner", now: "now" }],
      ),
    ).resolves.toBe(false);
  });

  it("lists every namespaced custom integration across scan pages", async () => {
    const first = {
      id: "custom-webhook:first",
      type: "custom-webhook" as const,
      generation: "generation",
      encryptedSecret: "ciphertext",
      repositoryId: "repo",
      target: { providerId: "provider" },
      fallbacks: [],
      queueTtlSeconds: 60,
      timeout: 60,
      priority: 0,
      requiredLabels: [],
      enabled: true,
      version: 1,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [first, { id: "slack", type: "slack" }, { ...first, id: "not-namespaced" }],
        LastEvaluatedKey: { id: "next" },
      })
      .mockResolvedValueOnce({ Items: [{ ...first, id: "custom-webhook:second" }] });
    await expect(listCustomWebhookIntegrations(ctx(send))).resolves.toMatchObject([
      { id: "first" },
      { id: "second" },
    ]);
    expect(send.mock.calls.map(([command]) => command.input)).toEqual([
      expect.objectContaining({ TableName: "Integrations", ConsistentRead: true }),
      expect.objectContaining({
        TableName: "Integrations",
        ConsistentRead: true,
        ExclusiveStartKey: { id: "next" },
      }),
    ]);
  });

  it("returns a conflict when a fenced write loses its transaction", async () => {
    const customRecord = {
      id: "deploy",
      type: "custom-webhook" as const,
      generation: "generation",
      encryptedSecret: "ciphertext",
      repositoryId: "repo",
      target: { providerId: "provider" },
      fallbacks: [],
      queueTtlSeconds: 60,
      timeout: 60,
      priority: 0,
      requiredLabels: [],
      enabled: true,
      version: 1,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    };
    const committed = vi.fn().mockResolvedValue({});
    await expect(
      putCustomWebhookIntegration(ctx(committed), customRecord, null, [
        { key: "repository:repo", owner: "owner", now: "2026-08-10T00:00:00.000Z" },
      ]),
    ).resolves.toBe(true);
    expect(committed.mock.calls[0]?.[0].input.TransactItems).toHaveLength(2);
    await expect(
      putCustomWebhookIntegration(
        ctx(
          vi.fn().mockRejectedValue({
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
          }),
        ),
        customRecord,
        null,
        [{ key: "repository:repo", owner: "owner", now: "2026-08-10T00:00:00.000Z" }],
      ),
    ).resolves.toBe(false);
  });
});
