/* eslint-disable max-lines -- operational failure scenarios share a command fake. */
import { describe, expect, it } from "vitest";

import {
  activityPut,
  activeActivityForAssignment,
  assertOperationalActivityReady,
  deleteOperationalActivity,
  operationalActivitiesForBackfill,
  repositoryActivityForSession,
  sessionNeedsOperationalRecovery,
} from "./plane-storage-operational-activity.ts";
import {
  listOperationalRecoveryPage,
  listOperationalSessions,
  listRepositoryOperationalPage,
  OperationalSnapshotOverflowError,
} from "./plane-storage-operational-read.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";
import type { SessionRecord } from "./types.ts";

const running = {
  id: "running",
  repositoryId: "repo",
  queueShard: 0,
  attemptId: "attempt",
  createdAt: "2026-01-01",
  status: "running",
} as SessionRecord;
const ready = { recordType: "operational-activity-ready-v2" };
const conditional = Object.assign(new Error("lost"), { name: "ConditionalCheckFailedException" });
const transactionCancelled = Object.assign(new Error("lost"), {
  name: "TransactionCanceledException",
  CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
});

function context(
  send: (command: {
    constructor: { name: string };
    input: Record<string, unknown>;
  }) => Promise<unknown>,
): PlaneStorageCtx {
  return {
    doc: { send },
    tables: { sessions: "Sessions", sessionDrains: "SessionDrains" },
  } as unknown as PlaneStorageCtx;
}

describe("operational activity failure boundaries", () => {
  it("fails closed before reading members when readiness is absent", async () => {
    let calls = 0;
    const ctx = context(async () => {
      calls += 1;
      return {};
    });
    await expect(listOperationalSessions(ctx, 1)).rejects.toThrow("not ready");
    expect(calls).toBe(1);
    await expect(assertOperationalActivityReady(ctx)).rejects.toThrow("not ready");
  });

  it("keeps workspace admissions out of REPO and tolerates a raced ACT deletion", async () => {
    expect(repositoryActivityForSession({ ...running, repositoryId: "" })).toBeNull();
    const activity = activeActivityForAssignment({
      sessionId: running.id,
      repositoryId: "",
      queueShard: 0,
      attemptId: "attempt",
    });
    expect(
      activityPut(
        context(async () => ({})),
        activity,
      ),
    ).toMatchObject({
      Put: { TableName: "SessionDrains", Item: activity },
    });
    expect(operationalActivitiesForBackfill({ ...running, attemptId: undefined })[0]).toMatchObject(
      { generation: running.createdAt },
    );
    const deferred = {
      ...running,
      status: "failed",
      errorCode: "checkout_fetch_failed",
      terminalHookHandoffSettled: { handoffId: "handoff", hostId: "host" },
    } as SessionRecord;
    expect(sessionNeedsOperationalRecovery(deferred)).toBe(true);
    expect(
      sessionNeedsOperationalRecovery({
        ...deferred,
        terminalHookLifecycleEnqueuedAt: "2026-01-02",
      }),
    ).toBe(false);
    const ctx = context(async () => {
      throw conditional;
    });
    await expect(deleteOperationalActivity(ctx, activity)).resolves.toBeUndefined();
    const unavailable = new Error("Dynamo unavailable");
    await expect(
      deleteOperationalActivity(
        context(async () => {
          throw unavailable;
        }),
        activity,
      ),
    ).rejects.toBe(unavailable);
  });

  it("advances recovery from its saved page cursor and removes stale ACT members", async () => {
    const calls: Array<{ constructor: { name: string }; input: Record<string, unknown> }> = [];
    const activity = activeActivityForAssignment({
      sessionId: "stale",
      repositoryId: "repo",
      queueShard: 1,
      attemptId: "old",
    });
    const ctx = context(async (command) => {
      calls.push(command);
      if (command.input.Key?.recordKey === "READY") return { Item: ready };
      if (command.input.Key?.recordKey === "timeout")
        return {
          Item: { shard: 1, nextKey: { scopeKey: "__active#v2#1", recordKey: "ACT#before" } },
        };
      if (command.constructor.name === "QueryCommand") return { Items: [activity] };
      if (command.constructor.name === "GetCommand") return {};
      return {};
    });
    await expect(listOperationalRecoveryPage(ctx, "timeout", 2)).resolves.toEqual([]);
    expect(calls.find((call) => call.constructor.name === "QueryCommand")?.input).toMatchObject({
      ExclusiveStartKey: { scopeKey: "__active#v2#1", recordKey: "ACT#before" },
      ExpressionAttributeValues: { ":scope": "__active#v2#1" },
    });
    expect(calls.some((call) => call.constructor.name === "DeleteCommand")).toBe(true);
    expect(calls.find((call) => call.constructor.name === "PutCommand")?.input.Item).toMatchObject({
      shard: 0,
      recordKey: "timeout",
    });
  });

  it("fails closed above a complete active snapshot while recovery can still page", async () => {
    let pages = 0;
    const activity = activeActivityForAssignment({
      sessionId: running.id,
      repositoryId: "repo",
      queueShard: 0,
      attemptId: "attempt",
    });
    const ctx = context(async (command) => {
      if (command.input.Key?.recordKey === "READY") return { Item: ready };
      if (command.constructor.name === "QueryCommand") {
        pages += 1;
        return pages <= 80
          ? {
              Items: Array.from({ length: 25 }, () => activity),
              LastEvaluatedKey: { scopeKey: activity.scopeKey, recordKey: `ACT#${pages}` },
            }
          : { Items: [activity] };
      }
      if (command.input.Key?.id) return { Item: running };
      return {};
    });
    await expect(listOperationalSessions(ctx, 1)).rejects.toBeInstanceOf(
      OperationalSnapshotOverflowError,
    );
    expect(pages).toBe(81);
  });

  it("handles an empty ACT query page without a session-table read", async () => {
    const calls: string[] = [];
    const ctx = context(async (command) => {
      calls.push(command.constructor.name);
      if (command.input.Key?.recordKey === "READY") return { Item: ready };
      return {};
    });
    await expect(listOperationalRecoveryPage(ctx, "ack", 1)).resolves.toEqual([]);
    expect(calls).toEqual(["GetCommand", "GetCommand", "QueryCommand", "PutCommand"]);
  });

  it("keeps live REPO members and ignores raced terminal pruning", async () => {
    const activity = repositoryActivityForSession(running)!;
    const calls: string[] = [];
    const ctx = context(async (command) => {
      calls.push(command.constructor.name);
      if (command.input.Key?.recordKey === "READY") return { Item: ready };
      if (command.constructor.name === "QueryCommand") return { Items: [activity] };
      if (command.input.Key?.id === running.id) return { Item: running };
      return {};
    });
    await expect(listRepositoryOperationalPage(ctx, "repo")).resolves.toMatchObject({
      sessions: [{ id: "running" }],
      observedMembers: 1,
    });
    expect(calls).not.toContain("TransactWriteCommand");

    const terminalCtx = context(async (command) => {
      if (command.input.Key?.recordKey === "READY") return { Item: ready };
      if (command.constructor.name === "QueryCommand") return { Items: [activity] };
      if (command.input.Key?.id === running.id)
        return { Item: { ...running, status: "completed" } };
      if (command.constructor.name === "TransactWriteCommand") throw transactionCancelled;
      return {};
    });
    await expect(listRepositoryOperationalPage(terminalCtx, "repo")).resolves.toMatchObject({
      sessions: [],
      observedMembers: 1,
    });
  });

  it("removes a mismatched REPO generation without touching the current session", async () => {
    const activity = repositoryActivityForSession(running)!;
    const calls: string[] = [];
    const ctx = context(async (command) => {
      calls.push(command.constructor.name);
      if (command.input.Key?.recordKey === "READY") return { Item: ready };
      if (command.constructor.name === "QueryCommand") return { Items: [activity] };
      if (command.input.Key?.id === running.id)
        return { Item: { ...running, createdAt: "new", status: "completed" } };
      return {};
    });
    await expect(listRepositoryOperationalPage(ctx, "repo")).resolves.toMatchObject({
      sessions: [],
    });
    expect(calls).toContain("DeleteCommand");
    expect(calls).not.toContain("TransactWriteCommand");
  });
});
