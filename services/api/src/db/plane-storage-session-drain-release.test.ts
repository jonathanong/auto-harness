import { describe, expect, it } from "vitest";

import { releaseSessionDrain, updateSessionDrain } from "./plane-storage-session-drains.ts";
import type { PlaneStorageCtx, SessionDrainRecord } from "./plane-storage-types.ts";

const conditionalTransaction = {
  name: "TransactionCanceledException",
  CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
};
const conditional = { name: "ConditionalCheckFailedException" };

function record(over: Partial<SessionDrainRecord> = {}): SessionDrainRecord {
  return {
    scopeKey: "repo#principal",
    recordKey: "CURRENT",
    operationId: "operation",
    repositoryId: "repo",
    principalId: "principal",
    status: "draining",
    requestedAt: "now",
    updatedAt: "now",
    deadlineAt: "later",
    queuedCount: 1,
    runningCount: 2,
    cancelledCount: 3,
    ...over,
  };
}

function ctx(send: (command: { input?: Record<string, unknown> }) => Promise<unknown>) {
  return {
    doc: { send },
    tables: { sessionDrains: "session-drains" },
  } as unknown as PlaneStorageCtx;
}

describe("session drain update and release races", () => {
  it("classifies update failures without hiding transport failures", async () => {
    await expect(
      updateSessionDrain(
        ctx(async () => ({})),
        record(),
      ),
    ).resolves.toBe(true);
    await expect(
      updateSessionDrain(
        ctx(async () => {
          throw conditionalTransaction;
        }),
        record(),
      ),
    ).resolves.toBe(false);
    await expect(
      updateSessionDrain(
        ctx(async () => {
          throw new Error("offline");
        }),
        record(),
      ),
    ).rejects.toThrow("offline");
  });

  it("classifies release outcomes without hiding transport failures", async () => {
    await expect(
      releaseSessionDrain(
        ctx(async () => ({ Attributes: record({ status: "released" }) })),
        "repo",
        "principal",
        "operation",
        "now",
      ),
    ).resolves.toMatchObject({ status: "released" });
    await expect(
      releaseSessionDrain(
        ctx(async () => ({})),
        "repo",
        "principal",
        "operation",
        "now",
      ),
    ).resolves.toBeNull();
    await expect(
      releaseSessionDrain(
        ctx(async () => {
          throw conditional;
        }),
        "repo",
        "principal",
        "operation",
        "now",
      ),
    ).resolves.toBeNull();
    await expect(
      releaseSessionDrain(
        ctx(async () => {
          throw new Error("offline");
        }),
        "repo",
        "principal",
        "operation",
        "now",
      ),
    ).rejects.toThrow("offline");
  });
});
