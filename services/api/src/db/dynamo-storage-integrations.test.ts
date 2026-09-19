import { describe, expect, it } from "vitest";

import { createDynamoTestCtx } from "../../test-helpers/dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("Int");

describe("DynamoDB Slack integration storage", () => {
  it("uses conditional singleton create/update/delete", async () => {
    if (!ctx.storage) return;
    const record = {
      id: "slack" as const,
      type: "slack" as const,
      encryptedConfig: "ciphertext-only",
      defaultChannel: "C0123ABCDE",
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
      installationId: "installation-1",
      version: 1,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    };
    expect(await ctx.storage.putSlackIntegration(record, null)).toBe(true);
    expect(await ctx.storage.putSlackIntegration(record, null)).toBe(false);
    expect((await ctx.storage.getSlackIntegration())?.encryptedConfig).toBe("ciphertext-only");
    expect(
      await ctx.storage.putSlackIntegration({ ...record, version: 2 }, 1, "installation-1"),
    ).toBe(true);
    expect(await ctx.storage.deleteSlackIntegration(1)).toBe(false);
    expect(await ctx.storage.deleteSlackIntegration(2)).toBe(true);

    const recreated = { ...record, installationId: "installation-2" };
    expect(await ctx.storage.putSlackIntegration(recreated, null)).toBe(true);
    expect(
      await ctx.storage.putSlackIntegration({ ...recreated, version: 2 }, 1, "installation-1"),
    ).toBe(false);
    expect(await ctx.storage.deleteSlackIntegration(1)).toBe(true);
  });

  it("records and clears a delivery failure without touching version", async () => {
    if (!ctx.storage) return;
    const record = {
      id: "slack" as const,
      type: "slack" as const,
      encryptedConfig: "ciphertext-only",
      defaultChannel: "C0123ABCDE",
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
    // A missing row is a no-op, not an error.
    await expect(
      ctx.storage.recordSlackDeliveryOutcome({ ok: false, error: "boom", at: record.createdAt }),
    ).resolves.toBeUndefined();

    expect(await ctx.storage.putSlackIntegration(record, null)).toBe(true);
    await ctx.storage.recordSlackDeliveryOutcome({
      ok: false,
      error: "Slack chat.postMessage failed: not_in_channel",
      at: "2026-08-10T00:01:00.000Z",
    });
    const withFailure = await ctx.storage.getSlackIntegration();
    expect(withFailure).toMatchObject({
      version: 1,
      lastDeliveryFailure: {
        message: "Slack chat.postMessage failed: not_in_channel",
        at: "2026-08-10T00:01:00.000Z",
      },
    });

    // A success with nothing to clear is also a no-op.
    await ctx.storage.recordSlackDeliveryOutcome({ ok: true, at: "2026-08-10T00:02:00.000Z" });
    await ctx.storage.recordSlackDeliveryOutcome({ ok: true, at: "2026-08-10T00:02:00.000Z" });
    const cleared = await ctx.storage.getSlackIntegration();
    expect(cleared?.lastDeliveryFailure).toBeUndefined();
    expect(cleared?.version).toBe(1);

    expect(await ctx.storage.deleteSlackIntegration(1)).toBe(true);
  });
});
