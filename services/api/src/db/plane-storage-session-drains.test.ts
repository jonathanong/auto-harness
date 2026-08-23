/* eslint-disable max-lines */
import { describe, expect, it } from "vitest";

import {
  createOrGetSessionDrain,
  getSessionDrain,
  listSessionDrains,
  sessionDrainAdmissionCheck,
  sessionDrainScopeKey,
} from "./plane-storage-session-drains.ts";
import { releaseMainCheckoutSession } from "./plane-storage-main-checkout-release.ts";
import { releaseCancelledSessionWorktree } from "./plane-storage-sessions.ts";
import type { AuditLogRecord } from "../audit-types.ts";
import type { PlaneStorageCtx, SessionDrainRecord } from "./plane-storage-types.ts";

const conditionalTransaction = {
  name: "TransactionCanceledException",
  CancellationReasons: [
    { Code: "None" },
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

function audit(drain: SessionDrainRecord): AuditLogRecord {
  return {
    id: `audit-${drain.operationId}-create`,
    createdAt: drain.updatedAt,
    actor: { id: drain.principalId, kind: "service-account", role: "author" },
    action: "session-drain:create",
    resourceType: "repository",
    resourceId: drain.repositoryId,
    repositoryId: drain.repositoryId,
    outcome: "success",
    metadata: { operationId: drain.operationId },
  };
}

function ctx(send: (command: { input?: Record<string, unknown> }) => Promise<unknown>) {
  return {
    doc: { send },
    tables: {
      sessionDrains: "session-drains",
      repositories: "repositories",
      concurrencyLocks: "concurrency-locks",
      sessions: "sessions",
      worktrees: "worktrees",
      hostLocks: "host-locks",
      users: "users",
      auditLogs: "audit-logs",
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
        audit(record()),
      ),
    ).resolves.toMatchObject({
      created: true,
      drain: { scopeKey: "repo%2Fone#principal%20two" },
    });
    expect(createInput?.TransactItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ConditionCheck: expect.objectContaining({
            TableName: "concurrency-locks",
            Key: { concurrencyId: "catalog-delete:repository:repo/one" },
          }),
        }),
        expect.objectContaining({
          ConditionCheck: expect.objectContaining({
            TableName: "concurrency-locks",
            Key: { concurrencyId: "catalog-delete:principal:principal two" },
          }),
        }),
        expect.objectContaining({
          ConditionCheck: expect.objectContaining({
            TableName: "users",
            Key: { id: "principal two" },
            ConditionExpression: "attribute_exists(id)",
          }),
        }),
        expect.objectContaining({
          ConditionCheck: expect.objectContaining({
            TableName: "repositories",
            Key: { id: "repo/one" },
          }),
        }),
        expect.objectContaining({
          Put: expect.objectContaining({
            TableName: "session-drains",
            Item: expect.objectContaining({ recordKey: "CURRENT" }),
          }),
        }),
        expect.objectContaining({
          Put: expect.objectContaining({
            TableName: "session-drains",
            Item: expect.objectContaining({ recordKey: "OP#operation" }),
          }),
        }),
      ]),
    );
    expect(createInput?.TransactItems).toContainEqual(
      expect.objectContaining({
        Put: expect.objectContaining({
          TableName: "audit-logs",
          Item: expect.objectContaining({
            id: "audit-operation-create",
            actor: expect.objectContaining({ id: "principal two" }),
            timestampId: "now#audit-operation-create",
          }),
        }),
      }),
    );

    let call = 0;
    const replayStorage = ctx(async () => {
      call += 1;
      if (call === 1) throw conditionalTransaction;
      return call === 2 ? { Item: record({ recordKey: "OP#operation" }) } : {};
    });
    await expect(
      createOrGetSessionDrain(replayStorage, record(), audit(record())),
    ).resolves.toMatchObject({
      created: false,
      drain: { operationId: "operation" },
    });

    await expect(
      createOrGetSessionDrain(
        ctx(async () => {
          throw {
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }],
          };
        }),
        record(),
        audit(record()),
      ),
    ).rejects.toThrow("session drain scope is unavailable");

    await expect(
      createOrGetSessionDrain(
        ctx(async () => {
          throw {
            name: "TransactionCanceledException",
            CancellationReasons: [
              { Code: "None" },
              { Code: "None" },
              { Code: "ConditionalCheckFailed" },
            ],
          };
        }),
        record(),
        audit(record()),
      ),
    ).rejects.toThrow("session drain scope is unavailable");

    await expect(
      createOrGetSessionDrain(
        ctx(async () => {
          throw {
            name: "TransactionCanceledException",
            CancellationReasons: [
              { Code: "None" },
              { Code: "None" },
              { Code: "None" },
              { Code: "None" },
              { Code: "ConditionalCheckFailed" },
            ],
          };
        }),
        record(),
        audit(record()),
      ),
    ).rejects.toThrow("session drain activity ledger is not ready");

    let systemInput: Record<string, unknown> | undefined;
    await createOrGetSessionDrain(
      ctx(async (command) => {
        systemInput = command.input;
        return {};
      }),
      record({ principalId: "system" }),
      audit(record({ principalId: "system" })),
    );
    expect(systemInput?.TransactItems).not.toContainEqual(
      expect.objectContaining({
        ConditionCheck: expect.objectContaining({ TableName: "users" }),
      }),
    );
    await expect(
      createOrGetSessionDrain(
        ctx(async () => {
          throw {
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }],
          };
        }),
        record({ principalId: "system" }),
        audit(record({ principalId: "system" })),
      ),
    ).rejects.toThrow("session drain scope is unavailable");

    call = 0;
    const missingStorage = ctx(async () => {
      call += 1;
      if (call === 1) throw conditionalTransaction;
      return {};
    });
    await expect(
      createOrGetSessionDrain(missingStorage, record(), audit(record())),
    ).rejects.toThrow("session drain scope is unavailable");

    await expect(
      createOrGetSessionDrain(
        ctx(async () => {
          throw {
            name: "TransactionCanceledException",
            CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
          };
        }),
        record(),
        audit(record()),
      ),
    ).rejects.toThrow("session drain scope is unavailable");

    call = 0;
    const occupiedScopeStorage = ctx(async () => {
      call += 1;
      if (call === 1) throw conditionalTransaction;
      return {};
    });
    await expect(
      createOrGetSessionDrain(occupiedScopeStorage, record(), audit(record())),
    ).rejects.toThrow("session drain scope is unavailable");
    expect(call).toBe(2);
    await expect(
      createOrGetSessionDrain(
        ctx(async () => {
          throw new Error("offline");
        }),
        record(),
        audit(record()),
      ),
    ).rejects.toThrow("offline");
  });

  it("fences terminal ACT cleanup when a drain cancellation wins after its read", async () => {
    const session = {
      id: "session",
      repositoryId: "repo",
      principalId: "principal",
      status: "cancelled",
      worktreeId: "worktree",
      attemptId: "attempt",
      hostId: "host",
      assignmentConnectionId: "connection",
      mainCheckoutLease: true,
    };
    const transactionFor = async (
      release: (storage: PlaneStorageCtx) => Promise<boolean>,
    ): Promise<Record<string, unknown>> => {
      let transaction: Record<string, unknown> | undefined;
      await expect(
        release(
          ctx(async (command) => {
            if ("ConsistentRead" in (command.input ?? {})) return { Item: session };
            transaction = command.input;
            return {};
          }),
        ),
      ).resolves.toBe(true);
      return transaction!;
    };
    const worktree = await transactionFor((storage) =>
      releaseCancelledSessionWorktree(storage, {
        sessionId: session.id,
        worktreeId: "worktree",
        attemptId: "attempt",
        online: true,
      }),
    );
    const mainCheckout = await transactionFor((storage) =>
      releaseMainCheckoutSession(storage, {
        sessionId: session.id,
        hostId: "host",
        repositoryId: "repo",
        connectionId: "connection",
        attemptId: "attempt",
        status: "cancelled",
        expectedStatus: "cancelled",
        queueShard: 0,
      }),
    );
    for (const transaction of [worktree, mainCheckout]) {
      const sessionUpdate = (transaction.TransactItems as Array<Record<string, unknown>>).find(
        (item) => (item.Update as Record<string, unknown> | undefined)?.TableName === "sessions",
      )?.Update as Record<string, unknown>;
      expect(sessionUpdate.ConditionExpression).toContain(
        "attribute_not_exists(cancelledByDrainOperationId)",
      );
    }
  });

  it("retries a late drain cancellation release without deleting its ACT member", async () => {
    const session = {
      id: "session",
      repositoryId: "repo",
      principalId: "principal",
      status: "cancelled",
      worktreeId: "worktree",
      attemptId: "attempt",
      hostId: "host",
      assignmentConnectionId: "connection",
      mainCheckoutLease: true,
    };
    const transactionsFor = async (
      release: (storage: PlaneStorageCtx) => Promise<boolean>,
    ): Promise<Array<Record<string, unknown>>> => {
      const transactions: Array<Record<string, unknown>> = [];
      let reads = 0;
      await expect(
        release(
          ctx(async (command) => {
            if ("ConsistentRead" in (command.input ?? {})) {
              reads += 1;
              return {
                Item: reads === 1 ? session : { ...session, cancelledByDrainOperationId: "drain" },
              };
            }
            transactions.push(command.input!);
            if (transactions.length === 1) throw conditionalTransaction;
            return {};
          }),
        ),
      ).resolves.toBe(true);
      return transactions;
    };
    const worktree = await transactionsFor((storage) =>
      releaseCancelledSessionWorktree(storage, {
        sessionId: session.id,
        worktreeId: "worktree",
        attemptId: "attempt",
        online: true,
      }),
    );
    const mainCheckout = await transactionsFor((storage) =>
      releaseMainCheckoutSession(storage, {
        sessionId: session.id,
        hostId: "host",
        repositoryId: "repo",
        connectionId: "connection",
        attemptId: "attempt",
        status: "cancelled",
        expectedStatus: "cancelled",
        queueShard: 0,
      }),
    );
    for (const transactions of [worktree, mainCheckout]) {
      expect(transactions).toHaveLength(2);
      expect(transactions[1].TransactItems).not.toContainEqual(
        expect.objectContaining({
          Delete: expect.objectContaining({ TableName: "session-drains" }),
        }),
      );
    }
  });
});
