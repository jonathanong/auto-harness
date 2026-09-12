import { describe, expect, it, vi } from "vitest";

import { deleteSlackIntegration, putSlackIntegration } from "./plane-storage-integrations.ts";
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
  return { doc: { send } as never, tables: { integrations: "Integrations" } as never };
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
});
