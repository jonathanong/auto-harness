/* eslint-disable max-lines -- eligibility and the durable cleanup store share a focused fixture. */
import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { DynamoPlaneStorageBase } from "./plane-storage-base.ts";
import {
  DynamoSessionRetentionStore,
  SESSION_DELETION_FENCE_SCOPE,
  sessionRetentionAdmissionCheck,
  sessionRetentionEligible,
  type RetentionJob,
} from "./plane-storage-session-retention.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";
import type { SessionRecord } from "./types.ts";
import { dynamoAvailable } from "../../test-helpers/dynamo-test-helpers.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const COMPLETED_AT = "2025-12-01T00:00:00.000Z";

function terminalSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "retention-session",
    repositoryId: "repo",
    prompt: "prompt",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: "completed",
    queueShard: 0,
    createdAt: "2025-11-30T23:00:00.000Z",
    completedAt: COMPLETED_AT,
    ...overrides,
  };
}

type FakeCommand = { input: Record<string, unknown> };

function context(
  send: (command: FakeCommand) => Promise<unknown>,
  tables: Partial<DynamoTableNames> = {},
): PlaneStorageCtx {
  return {
    doc: { send },
    tables: {
      sessions: "Sessions",
      sessionDrains: "SessionDrains",
      archives: "Archives",
      sessionUsage: "SessionUsage",
      sessionUsageKinds: "SessionUsageKinds",
      ...tables,
    },
  } as unknown as PlaneStorageCtx;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function transactionConditionFailure(): Error & {
  CancellationReasons: Array<{ Code: string }>;
} {
  return Object.assign(namedError("TransactionCanceledException"), {
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
  });
}

function job(overrides: Partial<RetentionJob> = {}): RetentionJob {
  return {
    scopeKey: "__retention#v1#jobs",
    recordKey: "2026-01-01T00:02:00.000Z#token",
    sessionId: "retention-session",
    repositoryId: "repo",
    principalId: "owner",
    queueShard: 0,
    activityGeneration: "attempt-1",
    createdAt: "2025-11-30T23:00:00.000Z",
    completedAt: COMPLETED_AT,
    token: "token",
    readyAt: "2026-01-01T00:02:00.000Z",
    retentionDays: 30,
    ...overrides,
  };
}

describe("sessionRetentionEligible", () => {
  it("accepts every terminal status with a valid completion time", () => {
    for (const status of ["completed", "failed", "cancelled", "timed_out"] as const) {
      expect(sessionRetentionEligible(terminalSession({ status }))).toBe(true);
    }
  });

  it("rejects active, malformed, leased, assigned, and unresolved handoff sessions", () => {
    const ineligible = [
      { status: "running" },
      { completedAt: undefined },
      { completedAt: "not-a-date" },
      { worktreeId: "worktree" },
      { workspaceSlotId: "slot" },
      { mainCheckoutLease: true },
      { workspaceSlotLease: true },
      {
        providerAccountLease: {
          concurrencyId: "c",
          providerAccountId: "p",
          slot: 0,
          attemptId: "a",
        },
      },
      { hostAssignmentLease: { hostId: "host" } },
      { activeHostId: "host" },
      { reconnectDeadlineAt: NOW },
      { terminalHookHandoff: { handoffId: "handoff" } },
      { errorCode: "checkout_fetch_failed", terminalHookHandoffSettled: true },
      { errorCode: "checkout_fetch_failed", terminalHookHandoffExpiredAt: NOW },
    ] satisfies Array<Partial<SessionRecord>>;
    for (const overrides of ineligible) {
      expect(sessionRetentionEligible(terminalSession(overrides))).toBe(false);
    }
    expect(
      sessionRetentionEligible(
        terminalSession({
          errorCode: "checkout_fetch_failed",
          terminalHookHandoffSettled: true,
          terminalHookLifecycleEnqueuedAt: NOW,
        }),
      ),
    ).toBe(true);
  });
});

describe("DynamoSessionRetentionStore command contract", () => {
  it("builds the session-deletion admission fence check", () => {
    expect(
      sessionRetentionAdmissionCheck(
        context(async () => ({})),
        "session-1",
      ),
    ).toEqual({
      ConditionCheck: {
        TableName: "SessionDrains",
        Key: { scopeKey: SESSION_DELETION_FENCE_SCOPE, recordKey: "session-1" },
        ConditionExpression: "attribute_not_exists(scopeKey)",
      },
    });
  });

  it("rotates partitions and loads/saves durable cursors with empty-key normalization", async () => {
    const commands: FakeCommand[] = [];
    const store = new DynamoSessionRetentionStore(
      context(async (command) => {
        commands.push(command);
        if (command instanceof UpdateCommand) return { Attributes: { partitionNumber: 5 } };
        if (command instanceof GetCommand) return { Item: { nextKey: {} } };
        return {};
      }),
    );
    await expect(store.nextPartition(4)).resolves.toBe(1);
    await expect(store.loadCursor("JOBS")).resolves.toBeUndefined();
    await store.saveCursor("JOBS", { scopeKey: "scope", recordKey: "last" });
    await store.saveCursor("EMPTY");
    expect(commands[0]?.input).toMatchObject({
      TableName: "SessionDrains",
      UpdateExpression: "ADD partitionNumber :one",
      ReturnValues: "UPDATED_OLD",
    });
    expect(commands[1]?.input).toMatchObject({
      TableName: "SessionDrains",
      ConsistentRead: true,
      Key: { scopeKey: "__retention#v1#cursors", recordKey: "JOBS" },
    });
    expect(commands[2]?.input.Item).toMatchObject({
      scopeKey: "__retention#v1#cursors",
      recordKey: "JOBS",
      nextKey: { scopeKey: "scope", recordKey: "last" },
    });
    expect(commands[3]?.input.Item).toEqual({
      scopeKey: "__retention#v1#cursors",
      recordKey: "EMPTY",
    });

    const missingOldValue = new DynamoSessionRetentionStore(context(async () => ({})));
    await expect(missingOldValue.nextPartition(8)).resolves.toBe(0);
  });

  it("queries bounded candidate and due-job pages and defaults missing rows/cursors to empty", async () => {
    const commands: FakeCommand[] = [];
    const store = new DynamoSessionRetentionStore(
      context(async (command) => {
        commands.push(command);
        return { Items: [], LastEvaluatedKey: {} };
      }),
    );
    await expect(store.listCandidates("failed", 2, NOW, 7, { id: "prior" })).resolves.toEqual({
      records: [],
      nextKey: undefined,
    });
    await expect(
      store.listJobs(NOW, 9, { scopeKey: "prior", recordKey: "prior" }),
    ).resolves.toEqual({
      records: [],
      nextKey: undefined,
    });
    expect(commands[0]).toBeInstanceOf(QueryCommand);
    expect(commands[0]?.input).toMatchObject({
      TableName: "Sessions",
      IndexName: "statusShard-completedAt",
      KeyConditionExpression: "statusShard = :statusShard AND completedAt <= :cutoff",
      ExpressionAttributeValues: { ":statusShard": "failed#2", ":cutoff": NOW },
      Limit: 7,
      ExclusiveStartKey: { id: "prior" },
    });
    expect(commands[1]?.input).toMatchObject({
      TableName: "SessionDrains",
      ConsistentRead: true,
      KeyConditionExpression: "scopeKey = :scope AND recordKey <= :due",
      ExpressionAttributeValues: { ":scope": "__retention#v1#jobs", ":due": `${NOW}#\uffff` },
      Limit: 9,
      ExclusiveStartKey: { scopeKey: "prior", recordKey: "prior" },
    });
  });

  it("returns empty candidate/job pages when Items are absent and propagates query errors", async () => {
    const store = new DynamoSessionRetentionStore(context(async () => ({})));
    await expect(store.listCandidates("completed", 0, NOW, 1)).resolves.toEqual({
      records: [],
      nextKey: undefined,
    });
    await expect(store.listJobs(NOW, 1)).resolves.toEqual({ records: [], nextKey: undefined });
    const failed = new Error("query unavailable");
    const broken = new DynamoSessionRetentionStore(
      context(async () => {
        throw failed;
      }),
    );
    await expect(broken.listCandidates("completed", 0, NOW, 1)).rejects.toBe(failed);
  });

  it("claims eligible sessions with the policy snapshot and distinguishes CAS loss from errors", async () => {
    const commands: FakeCommand[] = [];
    const store = new DynamoSessionRetentionStore(
      context(async (command) => {
        commands.push(command);
        return {};
      }),
    );
    const session = terminalSession({
      sessionApiKeyHash: "secret-hash",
      principalId: "owner",
      attemptId: "attempt-1",
    });
    await expect(store.claim(session, NOW, 90)).resolves.toBe(true);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(TransactWriteCommand);
    const transaction = (commands[0] as TransactWriteCommand).input.TransactItems ?? [];
    expect(transaction).toHaveLength(3);
    expect(transaction[0]?.Update).toMatchObject({
      TableName: "Sessions",
      Key: { id: session.id },
      UpdateExpression:
        "SET retentionToken = :token, retentionClaimedAt = :now REMOVE sessionApiKeyHash",
      ConditionExpression: expect.stringContaining("#status = :status"),
    });
    expect(transaction[1]?.Put?.Item).toMatchObject({
      scopeKey: "__retention#v1#jobs",
      sessionId: session.id,
      repositoryId: session.repositoryId,
      principalId: "owner",
      queueShard: session.queueShard,
      activityGeneration: "attempt-1",
      createdAt: session.createdAt,
      completedAt: session.completedAt,
      retentionDays: 90,
      readyAt: "2026-01-01T00:02:00.000Z",
    });
    expect(transaction[2]?.Put?.Item).toMatchObject({
      key: `sessions/${session.id}/logs.jsonl.gz`,
      status: "expired",
      objectStored: false,
    });
    await expect(store.claim(session, NOW)).resolves.toBe(true);
    await expect(store.claim(terminalSession({ status: "queued" }), NOW)).resolves.toBe(false);
    await expect(store.claim(terminalSession({ retentionToken: "claimed" }), NOW)).resolves.toBe(
      false,
    );
    const conditional = new DynamoSessionRetentionStore(
      context(async () => {
        throw transactionConditionFailure();
      }),
    );
    await expect(conditional.claim(session, NOW)).resolves.toBe(false);
    const failure = new Error("transaction unavailable");
    const broken = new DynamoSessionRetentionStore(
      context(async () => {
        throw failure;
      }),
    );
    await expect(broken.claim(session, NOW)).rejects.toBe(failure);
  });

  it("leases jobs with a bounded owner lease and reports conditional conflicts", async () => {
    const commands: FakeCommand[] = [];
    const store = new DynamoSessionRetentionStore(
      context(async (command) => {
        commands.push(command);
        return {};
      }),
    );
    await expect(store.lease(job(), NOW, "owner-1")).resolves.toBe(true);
    expect(commands[0]).toBeInstanceOf(UpdateCommand);
    expect(commands[0]?.input).toMatchObject({
      TableName: "SessionDrains",
      UpdateExpression: "SET leaseOwner = :owner, leaseUntil = :until",
      ConditionExpression:
        "#token = :token AND (attribute_not_exists(leaseUntil) OR leaseUntil <= :now)",
      ExpressionAttributeValues: {
        ":token": "token",
        ":owner": "owner-1",
        ":now": NOW,
        ":until": "2026-01-01T00:00:55.000Z",
      },
    });
    const conditional = new DynamoSessionRetentionStore(
      context(async () => {
        throw namedError("ConditionalCheckFailedException");
      }),
    );
    await expect(conditional.lease(job(), NOW, "owner-2")).resolves.toBe(false);
    const failure = new Error("lease unavailable");
    const broken = new DynamoSessionRetentionStore(
      context(async () => {
        throw failure;
      }),
    );
    await expect(broken.lease(job(), NOW, "owner-2")).rejects.toBe(failure);
  });

  it("deletes bounded related usage pages and their attempt markers before usage rows", async () => {
    const commands: FakeCommand[] = [];
    const store = new DynamoSessionRetentionStore(
      context(async (command) => {
        commands.push(command);
        if (command instanceof QueryCommand) {
          return {
            Items: [
              { usageKey: "a", attemptId: "attempt-1" },
              { usageKey: "b", attemptId: "attempt-1" },
              { usageKey: "c", attemptId: "attempt-2" },
            ],
          };
        }
        return {};
      }),
    );
    await expect(store.deleteRelatedPage("sess", "usage")).resolves.toBe(false);
    expect(commands[0]?.input).toMatchObject({
      TableName: "SessionUsage",
      ConsistentRead: true,
      Limit: 25,
      KeyConditionExpression: "sessionId = :id",
      ExpressionAttributeValues: { ":id": "sess" },
    });
    const batches = commands.filter(
      (command) => command instanceof BatchWriteCommand,
    ) as BatchWriteCommand[];
    expect(Object.keys(batches[0]!.input.RequestItems ?? {})).toEqual(["SessionUsageKinds"]);
    expect(batches[0]!.input.RequestItems?.SessionUsageKinds).toHaveLength(2);
    expect(Object.keys(batches[1]!.input.RequestItems ?? {})).toEqual(["SessionUsage"]);
    expect(batches[1]!.input.RequestItems?.SessionUsage).toHaveLength(3);

    const markerFailure = new DynamoSessionRetentionStore(
      context(async (command) =>
        command instanceof QueryCommand
          ? { Items: [{ usageKey: "a", attemptId: "attempt-1" }] }
          : { UnprocessedItems: { SessionUsageKinds: [{}] } },
      ),
    );
    await expect(markerFailure.deleteRelatedPage("sess", "usage")).rejects.toThrow(
      "usage marker deletion was incomplete",
    );
    const rowFailure = new DynamoSessionRetentionStore(
      context(async (command) =>
        command instanceof QueryCommand
          ? { Items: [{ usageKey: "a", attemptId: "attempt-1" }] }
          : command.input.RequestItems?.SessionUsageKinds
            ? {}
            : { UnprocessedItems: { SessionUsage: [{}] } },
      ),
    );
    await expect(rowFailure.deleteRelatedPage("sess", "usage")).rejects.toThrow(
      "session retention row deletion was incomplete",
    );
  });

  it("handles empty and optional log tables, and bounds legacy log deletion", async () => {
    const noLogTable = new DynamoSessionRetentionStore(
      context(
        async () => {
          throw new Error("must not query without a logs table");
        },
        { sessionLogs: undefined },
      ),
    );
    await expect(noLogTable.deleteRelatedPage("sess", "logs")).resolves.toBe(true);
    const empty = new DynamoSessionRetentionStore(
      context(
        async (command) => {
          expect(command).toBeInstanceOf(QueryCommand);
          return {};
        },
        { sessionLogs: "SessionLogs" },
      ),
    );
    await expect(empty.deleteRelatedPage("sess", "logs")).resolves.toBe(true);
    const commands: FakeCommand[] = [];
    const store = new DynamoSessionRetentionStore(
      context(
        async (command) => {
          commands.push(command);
          return command instanceof QueryCommand
            ? { Items: [{ timestampSeq: "2026-01-01T00:00:00.000Z#0001" }] }
            : {};
        },
        { sessionLogs: "SessionLogs" },
      ),
    );
    await expect(store.deleteRelatedPage("sess", "logs")).resolves.toBe(false);
    expect(commands[0]?.input.Limit).toBe(25);
    expect((commands[1] as BatchWriteCommand).input.RequestItems?.SessionLogs).toEqual([
      {
        DeleteRequest: {
          Key: { sessionId: "sess", timestampSeq: "2026-01-01T00:00:00.000Z#0001" },
        },
      },
    ]);
  });

  it("finishes with an atomic deletion tombstone and distinguishes conditional loss from errors", async () => {
    const commands: FakeCommand[] = [];
    const store = new DynamoSessionRetentionStore(
      context(async (command) => {
        commands.push(command);
        return {};
      }),
    );
    const completedAt = "2026-01-10T00:00:00.000Z";
    await expect(store.finish(job({ retentionDays: 90 }), "owner", completedAt)).resolves.toBe(
      true,
    );
    const transaction = (commands[0] as TransactWriteCommand).input.TransactItems ?? [];
    expect(transaction).toHaveLength(7);
    expect(transaction[0]?.Delete).toMatchObject({
      TableName: "Sessions",
      Key: { id: "retention-session" },
      ConditionExpression:
        "retentionToken = :token AND createdAt = :createdAt AND completedAt = :completedAt",
    });
    expect(transaction[1]?.Delete).toEqual({
      TableName: "Archives",
      Key: { key: "sessions/retention-session/logs.jsonl.gz" },
    });
    expect(transaction[2]?.Delete).toMatchObject({
      TableName: "SessionDrains",
      Key: { scopeKey: "__repo#v2#repo", recordKey: "ACT#retention-session" },
      ConditionExpression: expect.stringContaining("generation = :generation"),
    });
    expect(transaction[3]?.Delete).toMatchObject({
      TableName: "SessionDrains",
      Key: { scopeKey: "__active#v2#0", recordKey: "ACT#retention-session" },
      ConditionExpression: expect.stringContaining("generation = :generation"),
    });
    expect(transaction[4]?.Delete).toMatchObject({
      TableName: "SessionDrains",
      Key: { scopeKey: "repo#owner", recordKey: "ACT#retention-session" },
      ConditionExpression: expect.stringContaining("principalId = :principalId"),
    });
    expect(transaction[5]?.Delete).toMatchObject({
      TableName: "SessionDrains",
      ConditionExpression: "#token = :token AND leaseOwner = :owner",
    });
    expect(transaction[6]?.Put?.Item).toEqual({
      scopeKey: SESSION_DELETION_FENCE_SCOPE,
      recordKey: "retention-session",
      createdAt: job().createdAt,
      deletedAt: completedAt,
      ttl: Math.floor(Date.parse(completedAt) / 1000) + 90 * 86_400,
    });
    const { principalId: _principalId, ...withoutPrincipal } = job();
    await expect(
      store.finish({ ...withoutPrincipal, repositoryId: "" }, "owner", completedAt),
    ).resolves.toBe(true);
    expect((commands[1] as TransactWriteCommand).input.TransactItems).toHaveLength(5);
    const conditional = new DynamoSessionRetentionStore(
      context(async () => {
        throw transactionConditionFailure();
      }),
    );
    await expect(conditional.finish(job(), "owner", NOW)).resolves.toBe(false);
    const failure = new Error("finish unavailable");
    const broken = new DynamoSessionRetentionStore(
      context(async () => {
        throw failure;
      }),
    );
    await expect(broken.finish(job(), "owner", NOW)).rejects.toBe(failure);
  });
});

let localClient: DynamoDBClient | undefined;
let localDoc: ReturnType<typeof createDynamoClients>["doc"] | undefined;
let localTables: DynamoTableNames | undefined;
let localStore: DynamoSessionRetentionStore | undefined;
let localStorage: DynamoPlaneStorageBase | undefined;

beforeAll(async () => {
  if (!(await dynamoAvailable())) return;
  const clients = createDynamoClients();
  localClient = clients.client;
  localDoc = clients.doc;
  localTables = await ensureControlPlaneTables({
    client: clients.client,
    prefix: `AhRetention${process.pid}`,
  });
  localStorage = new DynamoPlaneStorageBase(clients.doc, localTables);
  localStore = localStorage.getSessionRetentionStore();
});

afterAll(async () => {
  if (localClient && localTables) {
    await Promise.all(
      Object.values(localTables).map((TableName) =>
        localClient!.send(new DeleteTableCommand({ TableName })),
      ),
    );
  }
});

describe("DynamoDB Local session retention transactions", () => {
  it("does not claim a checkout failure while a newly settled handoff awaits Slack enqueue", async () => {
    if (!localStore || !localStorage || !localDoc || !localTables) {
      throw new Error("DynamoDB Local is unavailable; set HARNESS_DDB_ENDPOINT");
    }
    for (const transition of ["settled", "expired"] as const) {
      const session = terminalSession({
        id: `retention-handoff-race-${transition}-${process.pid}`,
        status: "failed",
        errorCode: "checkout_fetch_failed",
      });
      await localStorage.putSession(session);
      const field =
        transition === "settled" ? "terminalHookHandoffSettled" : "terminalHookHandoffExpiredAt";
      await localDoc.send(
        new UpdateCommand({
          TableName: localTables.sessions,
          Key: { id: session.id },
          UpdateExpression: "SET #field = :value",
          ExpressionAttributeNames: { "#field": field },
          ExpressionAttributeValues: {
            ":value":
              transition === "settled"
                ? { handoffId: "handoff", hostId: "host" }
                : "2025-12-02T00:00:00.000Z",
          },
        }),
      );

      expect(await localStore.claim(session, NOW)).toBe(false);
      expect(await localStore.getSession(session.id)).toMatchObject({ id: session.id });
      expect((await localStore.getSession(session.id))?.retentionToken).toBeUndefined();

      await localDoc.send(
        new UpdateCommand({
          TableName: localTables.sessions,
          Key: { id: session.id },
          UpdateExpression: "SET terminalHookLifecycleEnqueuedAt = :at",
          ExpressionAttributeValues: { ":at": NOW },
        }),
      );
      expect(await localStore.claim(session, NOW)).toBe(true);
      const due = "2026-01-01T00:03:00.000Z";
      const claimedJob = (await localStore.listJobs(due, 25)).records.find(
        (record) => record.sessionId === session.id,
      )!;
      expect(await localStore.lease(claimedJob, due, "race-test")).toBe(true);
      expect(await localStore.finish(claimedJob, "race-test", due)).toBe(true);
    }
  });

  it("queries stale candidates, claims with CAS, leases once, removes related pages, and tombstones atomically", async () => {
    if (!localStore || !localStorage || !localDoc || !localTables) {
      throw new Error("DynamoDB Local is unavailable; set HARNESS_DDB_ENDPOINT");
    }
    const session = terminalSession({
      id: `retention-local-${process.pid}`,
      sessionApiKeyHash: "must-be-removed",
      principalId: "owner",
      attemptId: "attempt-1",
    });
    await localStorage.putSession(session);
    await localDoc.send(
      new PutCommand({
        TableName: localTables.archives,
        Item: { key: `sessions/${session.id}/logs.jsonl.gz`, status: "ready", objectStored: true },
      }),
    );
    await localDoc.send(
      new PutCommand({
        TableName: localTables.sessionUsage,
        Item: { sessionId: session.id, usageKey: "attempt#1", attemptId: "attempt-1" },
      }),
    );
    await localDoc.send(
      new PutCommand({
        TableName: localTables.sessionUsageKinds,
        Item: { sessionAttempt: `${session.id}\0attempt-1`, kind: "delta" },
      }),
    );
    await Promise.all([
      localDoc.send(
        new PutCommand({
          TableName: localTables.sessionDrains,
          Item: {
            scopeKey: `__repo#v2#${encodeURIComponent(session.repositoryId)}`,
            recordKey: `ACT#${session.id}`,
            recordType: "operational-activity-v2",
            sessionId: session.id,
            repositoryId: session.repositoryId,
            generation: session.createdAt,
          },
        }),
      ),
      localDoc.send(
        new PutCommand({
          TableName: localTables.sessionDrains,
          Item: {
            scopeKey: `__active#v2#${session.queueShard}`,
            recordKey: `ACT#${session.id}`,
            recordType: "operational-activity-v2",
            sessionId: session.id,
            repositoryId: session.repositoryId,
            generation: session.attemptId,
          },
        }),
      ),
      localDoc.send(
        new PutCommand({
          TableName: localTables.sessionDrains,
          Item: {
            scopeKey: "repo#owner",
            recordKey: `ACT#${session.id}`,
            recordType: "activity",
            sessionId: session.id,
            repositoryId: session.repositoryId,
            principalId: "owner",
          },
        }),
      ),
    ]);

    const candidates = await localStore.listCandidates(
      "completed",
      0,
      "2025-12-02T00:00:00.000Z",
      5,
    );
    expect(candidates.records).toContainEqual(
      expect.objectContaining({ id: session.id, completedAt: COMPLETED_AT }),
    );
    expect(await localStore.claim(session, NOW, 90)).toBe(true);
    expect(await localStore.claim(session, NOW, 90)).toBe(false);
    const claimed = await localStore.getSession(session.id);
    expect(claimed).toMatchObject({ id: session.id, retentionToken: expect.any(String) });
    expect(claimed?.sessionApiKeyHash).toBeUndefined();

    const due = "2026-01-01T00:03:00.000Z";
    const jobs = await localStore.listJobs(due, 5);
    expect(jobs.records).toHaveLength(1);
    const claimedJob = jobs.records[0]!;
    expect(claimedJob).toMatchObject({ sessionId: session.id, retentionDays: 90 });
    expect(await localStore.lease(claimedJob, due, "owner-1")).toBe(true);
    expect(await localStore.lease(claimedJob, due, "owner-2")).toBe(false);

    expect(await localStore.deleteRelatedPage(session.id, "usage")).toBe(false);
    expect(await localStore.deleteRelatedPage(session.id, "usage")).toBe(true);
    const markerAfterPage = await localDoc.send(
      new GetCommand({
        TableName: localTables.sessionUsageKinds,
        Key: { sessionAttempt: `${session.id}\0attempt-1` },
      }),
    );
    expect(markerAfterPage.Item).toBeUndefined();

    expect(await localStore.finish(claimedJob, "owner-1", due)).toBe(true);
    expect(await localStore.getSession(session.id)).toBeNull();
    const archiveAfterFinish = await localDoc.send(
      new GetCommand({
        TableName: localTables.archives,
        Key: { key: `sessions/${session.id}/logs.jsonl.gz` },
      }),
    );
    expect(archiveAfterFinish.Item).toBeUndefined();
    const locatorResults = await Promise.all([
      localDoc.send(
        new GetCommand({
          TableName: localTables.sessionDrains,
          Key: {
            scopeKey: `__repo#v2#${encodeURIComponent(session.repositoryId)}`,
            recordKey: `ACT#${session.id}`,
          },
        }),
      ),
      localDoc.send(
        new GetCommand({
          TableName: localTables.sessionDrains,
          Key: {
            scopeKey: `__active#v2#${session.queueShard}`,
            recordKey: `ACT#${session.id}`,
          },
        }),
      ),
      localDoc.send(
        new GetCommand({
          TableName: localTables.sessionDrains,
          Key: { scopeKey: "repo#owner", recordKey: `ACT#${session.id}` },
        }),
      ),
    ]);
    expect(locatorResults.map((result) => result.Item)).toEqual([undefined, undefined, undefined]);
    expect(
      await localDoc.send(
        new GetCommand({
          TableName: localTables.sessionDrains,
          Key: { scopeKey: SESSION_DELETION_FENCE_SCOPE, recordKey: session.id },
          ConsistentRead: true,
        }),
      ),
    ).toMatchObject({
      Item: {
        scopeKey: SESSION_DELETION_FENCE_SCOPE,
        recordKey: session.id,
        ttl: expect.any(Number),
      },
    });

    const unindexed = terminalSession({ id: `retention-unindexed-${process.pid}` });
    await localStorage.putSession(unindexed);
    expect(await localStore.claim(unindexed, NOW)).toBe(true);
    const unindexedJob = (await localStore.listJobs("2026-01-01T00:03:00.000Z", 25)).records.find(
      (record) => record.sessionId === unindexed.id,
    )!;
    expect(await localStore.lease(unindexedJob, "2026-01-01T00:03:00.000Z", "owner-2")).toBe(true);
    expect(await localStore.deleteRelatedPage(unindexed.id, "usage")).toBe(true);
    expect(await localStore.deleteRelatedPage(unindexed.id, "logs")).toBe(true);
    expect(await localStore.finish(unindexedJob, "owner-2", "2026-01-01T00:03:00.000Z")).toBe(true);
  });
});
