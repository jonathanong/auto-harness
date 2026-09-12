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
