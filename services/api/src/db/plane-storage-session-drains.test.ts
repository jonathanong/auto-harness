/* eslint-disable max-lines */
import { describe, expect, it } from "vitest";

import {
  createOrGetSessionDrain,
  getSessionDrain,
  listSessionDrains,
  sessionDrainAdmissionCheck,
  sessionDrainScopeKey,
} from "./plane-storage-session-drains.ts";
import type { PlaneStorageCtx, SessionDrainRecord } from "./plane-storage-types.ts";

const conditionalTransaction = {
  name: "TransactionCanceledException",
  CancellationReasons: [
    { Code: "None" },
    { Code: "None" },
    { Code: "None" },
    { Code: "None" },
    { Code: "ConditionalCheckFailed" },
  ],
};
function record(over: Partial<SessionDrainRecord> = {}): SessionDrainRecord {
  return {
    scopeKey: "",
    recordKey: "CURRENT",
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
    tables: {
      sessionDrains: "session-drains",
      repositories: "repositories",
      concurrencyLocks: "concurrency-locks",
    },
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

  it("supports a strongly consistent scan for deletion guards", async () => {
    const inputs: Record<string, unknown>[] = [];
    await expect(
      listSessionDrains(
        ctx(async (command) => {
          inputs.push(command.input ?? {});
          return {};
        }),
        true,
      ),
    ).resolves.toEqual([]);
    expect(inputs).toEqual([{ TableName: "session-drains", ConsistentRead: true }]);
  });

  it("stops when a backend returns an empty pagination cursor", async () => {
    let scans = 0;
    await expect(
      listSessionDrains(
        ctx(async () => {
          scans += 1;
          return { Items: [record()], LastEvaluatedKey: {} };
        }),
      ),
    ).resolves.toHaveLength(1);
    expect(scans).toBe(1);
  });

  it("creates a new operation and reports conditional replay failures safely", async () => {
    let createInput: Record<string, unknown> | undefined;
    await expect(
      createOrGetSessionDrain(
        ctx(async (command) => {
          createInput = command.input;
          return {};
        }),
        record(),
      ),
    ).resolves.toMatchObject({
      created: true,
      drain: { scopeKey: "repo%2Fone#principal%20two" },
    });
    expect(createInput).toMatchObject({
      TransactItems: [
        {
          ConditionCheck: {
            TableName: "concurrency-locks",
            Key: { concurrencyId: "catalog-delete:repository:repo/one" },
          },
        },
        {
          ConditionCheck: {
            TableName: "repositories",
            Key: { id: "repo/one" },
            ConditionExpression: "attribute_exists(id)",
          },
        },
        {
          ConditionCheck: {
            TableName: "session-drains",
            Key: { scopeKey: "__session-drain-ledger__" },
          },
        },
        { Put: { TableName: "session-drains", Item: { recordKey: "CURRENT" } } },
        { Put: { TableName: "session-drains", Item: { recordKey: "OP#operation" } } },
      ],
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
      "session drain scope is unavailable",
    );

    await expect(
      createOrGetSessionDrain(
        ctx(async () => {
          throw {
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
          };
        }),
        record(),
      ),
    ).rejects.toThrow("session drain scope is unavailable");

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
});
