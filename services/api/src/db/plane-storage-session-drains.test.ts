import { describe, expect, it } from "vitest";

import {
  createOrGetSessionDrain,
  getSessionDrain,
  listSessionDrains,
  releaseSessionDrain,
  sessionDrainAdmissionCheck,
  sessionDrainScopeKey,
  updateSessionDrain,
} from "./plane-storage-session-drains.ts";
import type { PlaneStorageCtx, SessionDrainRecord } from "./plane-storage-types.ts";

const conditionalTransaction = {
  name: "TransactionCanceledException",
  CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
};
const conditional = { name: "ConditionalCheckFailedException" };

function record(over: Partial<SessionDrainRecord> = {}): SessionDrainRecord {
  return {
    scopeKey: "",
    recordKey: "",
    operationId: "operation",
    repositoryId: "repo/one",
    principalId: "principal two",
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

describe("session drain Dynamo adapter residuals", () => {
  it("builds encoded scope and optional admission checks", () => {
    const storage = ctx(async () => ({}));
    expect(sessionDrainScopeKey("repo/one", "principal two")).toBe("repo%2Fone#principal%20two");
    expect(sessionDrainAdmissionCheck(storage, "repo", undefined)).toBeNull();
    expect(sessionDrainAdmissionCheck(storage, "repo", "principal")).toMatchObject({
      ConditionCheck: { TableName: "session-drains", Key: { recordKey: "CURRENT" } },
    });
  });

  it("reads missing records and paginates scans", async () => {
    const scanInputs: unknown[] = [];
    let call = 0;
    const storage = ctx(async (command) => {
      if ("ConsistentRead" in (command.input ?? {})) return {};
      scanInputs.push(command.input);
      call += 1;
      return call === 1
        ? { Items: [record()], LastEvaluatedKey: { scopeKey: "next", recordKey: "next" } }
        : {};
    });
    await expect(getSessionDrain(storage, "repo", "principal", false)).resolves.toBeNull();
    await expect(listSessionDrains(storage)).resolves.toHaveLength(1);
    expect(scanInputs).toHaveLength(2);
  });

  it("creates a new operation and reports conditional replay failures safely", async () => {
    await expect(
      createOrGetSessionDrain(
        ctx(async () => ({})),
        record(),
      ),
    ).resolves.toMatchObject({
      created: true,
      drain: { scopeKey: "repo%2Fone#principal%20two" },
    });

    let call = 0;
    const replayStorage = ctx(async () => {
      call += 1;
      if (call === 1) throw conditionalTransaction;
      return call === 2 ? { Item: record({ recordKey: "OP#operation" }) } : {};
    });
    await expect(createOrGetSessionDrain(replayStorage, record())).resolves.toMatchObject({
      created: false,
      drain: { operationId: "operation" },
    });

    call = 0;
    const missingStorage = ctx(async () => {
      call += 1;
      if (call === 1) throw conditionalTransaction;
      return {};
    });
    await expect(createOrGetSessionDrain(missingStorage, record())).rejects.toThrow(
      "session drain changed while replaying request",
    );

    call = 0;
    const currentStorage = ctx(async () => {
      call += 1;
      if (call === 1) throw conditionalTransaction;
      return call === 3 ? { Item: record({ recordKey: "CURRENT" }) } : {};
    });
    await expect(createOrGetSessionDrain(currentStorage, record())).resolves.toMatchObject({
      created: false,
      drain: { recordKey: "CURRENT" },
    });
    await expect(
      createOrGetSessionDrain(
        ctx(async () => {
          throw new Error("offline");
        }),
        record(),
      ),
    ).rejects.toThrow("offline");
  });

  it("classifies update and release races without hiding transport failures", async () => {
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
