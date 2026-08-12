import { describe, expect, it } from "vitest";

import { createDynamoTestCtx } from "./dynamo-test-helpers.ts";

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
      version: 1,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    };
    expect(await ctx.storage.putSlackIntegration(record, null)).toBe(true);
    expect(await ctx.storage.putSlackIntegration(record, null)).toBe(false);
    expect((await ctx.storage.getSlackIntegration())?.encryptedConfig).toBe("ciphertext-only");
    expect(await ctx.storage.putSlackIntegration({ ...record, version: 2 }, 1)).toBe(true);
    expect(await ctx.storage.deleteSlackIntegration(1)).toBe(false);
    expect(await ctx.storage.deleteSlackIntegration(2)).toBe(true);
  });
});
