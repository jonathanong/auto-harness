import { describe, expect, it } from "vitest";

import {
  activeActivityForAssignment,
  repositoryActivityForSession,
} from "./plane-storage-operational-activity.ts";
import {
  listOperationalRecoveryPage,
  listOperationalSessions,
  listRepositoryOperationalPage,
} from "./plane-storage-operational-read.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";
import type { SessionRecord } from "./types.ts";

const running = {
  id: "session",
  repositoryId: "repo",
  createdAt: "2026-01-01",
  queueShard: 0,
  attemptId: "attempt",
  status: "running",
} as SessionRecord;
const ready = { recordType: "operational-activity-ready-v2" };

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

describe("operational activity page transitions", () => {
  it("returns no recovery work for an empty shard layout", async () => {
    let calls = 0;
    const ctx = context(async () => {
      calls += 1;
      return { Item: ready };
    });
    await expect(listOperationalRecoveryPage(ctx, "ack", 0)).resolves.toEqual([]);
    expect(calls).toBe(1);
  });

  it("retains a recovery cursor within a shard while the query has another page", async () => {
    const activity = activeActivityForAssignment({
      sessionId: running.id,
      repositoryId: running.repositoryId,
      queueShard: 0,
      attemptId: running.attemptId!,
    });
    const nextKey = { scopeKey: activity.scopeKey, recordKey: "ACT#last" };
    let saved: Record<string, unknown> | undefined;
    const ctx = context(async (command) => {
      if (command.input.Key?.recordKey === "READY") return { Item: ready };
      if (command.input.Key?.recordKey === "ack") return {};
      if (command.constructor.name === "QueryCommand")
        return { Items: [activity], LastEvaluatedKey: nextKey };
      if (command.input.Key?.id === running.id) return { Item: running };
      if (command.constructor.name === "PutCommand")
        saved = command.input.Item as Record<string, unknown>;
      return {};
    });
    await expect(listOperationalRecoveryPage(ctx, "ack", 2)).resolves.toMatchObject([
      { id: running.id },
    ]);
    expect(saved).toMatchObject({ shard: 0, nextKey });
  });

  it("cleans a terminal ACT member during complete capacity hydration", async () => {
    const activity = activeActivityForAssignment({
      sessionId: running.id,
      repositoryId: running.repositoryId,
      queueShard: 0,
      attemptId: running.attemptId!,
    });
    const calls: string[] = [];
    const ctx = context(async (command) => {
      calls.push(command.constructor.name);
      if (command.input.Key?.recordKey === "READY") return { Item: ready };
      if (command.constructor.name === "QueryCommand") return { Items: [activity] };
      if (command.input.Key?.id === running.id)
        return { Item: { ...running, status: "completed" } };
      return {};
    });
    await expect(listOperationalSessions(ctx, 1)).resolves.toEqual([]);
    expect(calls).toContain("DeleteCommand");
  });

  it("passes a repository page cursor to the drain and propagates infrastructure failure", async () => {
    const activity = repositoryActivityForSession(running)!;
    const nextKey = { scopeKey: activity.scopeKey, recordKey: "ACT#later" };
    const ctx = context(async (command) => {
      if (command.input.Key?.recordKey === "READY") return { Item: ready };
      if (command.constructor.name === "QueryCommand")
        return { Items: [activity], LastEvaluatedKey: nextKey };
      if (command.input.Key?.id === running.id) return { Item: running };
      return {};
    });
    await expect(listRepositoryOperationalPage(ctx, "repo")).resolves.toMatchObject({
      sessions: [{ id: running.id }],
      nextKey,
    });

    const unavailable = new Error("Dynamo unavailable");
    const failing = context(async (command) => {
      if (command.input.Key?.recordKey === "READY") return { Item: ready };
      if (command.constructor.name === "QueryCommand") return { Items: [activity] };
      if (command.input.Key?.id === running.id)
        return { Item: { ...running, status: "completed" } };
      throw unavailable;
    });
    await expect(listRepositoryOperationalPage(failing, "repo")).rejects.toBe(unavailable);
  });
});
