import { describe, expect, it } from "vitest";

import {
  activeActivityForAssignment,
  operationalActivitiesForBackfill,
  repositoryActivityForSession,
  repositoryActivityScope,
} from "./plane-storage-operational-activity.ts";
import {
  listOperationalRecoveryPage,
  listOperationalSessions,
  listRepositoryOperationalPage,
} from "./plane-storage-operational-read.ts";
import { markTerminalHookLifecycleEnqueued } from "./plane-storage-terminal-hook-lifecycle.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";
import type { SessionRecord } from "./types.ts";

const running = {
  id: "running",
  repositoryId: "repo",
  createdAt: "2026-01-01",
  queueShard: 0,
  attemptId: "attempt",
  status: "running",
} as SessionRecord;

describe("operational activity ledger", () => {
  it("keeps queued backlog outside the bounded active-lease snapshot", () => {
    const queued = Array.from(
      { length: 2_501 },
      (_, index) =>
        ({
          ...running,
          id: `queued-${index}`,
          status: "queued",
          attemptId: undefined,
        }) as SessionRecord,
    );
    const members = queued.flatMap(operationalActivitiesForBackfill);
    expect(members).toHaveLength(queued.length);
    expect(members.every((member) => member.scopeKey.startsWith("__repo#v2#"))).toBe(true);
  });

  it("uses scopes that cannot collide with principal activity and records ownerless admissions", () => {
    const repository = repositoryActivityForSession(running);
    expect(repository).toMatchObject({
      scopeKey: "__repo#v2#repo",
      recordKey: "ACT#running",
      generation: "2026-01-01",
    });
    expect(repositoryActivityScope("repo#principal")).toBe("__repo#v2#repo%23principal");
    expect(
      activeActivityForAssignment({
        sessionId: "workspace",
        repositoryId: "",
        queueShard: 1,
        attemptId: "attempt-2",
      }),
    ).toMatchObject({ scopeKey: "__active#v2#1", repositoryId: "" });
    expect(operationalActivitiesForBackfill({ ...running, status: "queued" })).toHaveLength(1);
    expect(operationalActivitiesForBackfill(running)).toHaveLength(2);
  });

  it("strongly reads only the sparse ACTIVE partition and exact session row", async () => {
    const commands: Array<{ constructor: { name: string }; input: Record<string, unknown> }> = [];
    const activity = activeActivityForAssignment({
      sessionId: running.id,
      repositoryId: running.repositoryId,
      queueShard: 0,
      attemptId: running.attemptId!,
    });
    const ctx = {
      doc: {
        send: async (command: {
          constructor: { name: string };
          input: Record<string, unknown>;
        }) => {
          commands.push(command);
          if (command.input.Key?.recordKey === "READY")
            return { Item: { recordType: "operational-activity-ready-v2" } };
          if (command.input.KeyConditionExpression) return { Items: [activity] };
          if (command.input.Key?.id === running.id) return { Item: running };
          throw new Error("unexpected Dynamo command");
        },
      },
      tables: { sessions: "Sessions", sessionDrains: "SessionDrains" },
    } as unknown as PlaneStorageCtx;

    await expect(listOperationalSessions(ctx, 1)).resolves.toMatchObject([{ id: "running" }]);
    expect(commands.map((command) => command.constructor.name)).toEqual([
      "GetCommand",
      "QueryCommand",
      "GetCommand",
    ]);
    expect(commands[1]?.input).toMatchObject({
      ConsistentRead: true,
      Limit: 25,
      ExpressionAttributeValues: { ":scope": "__active#v2#0" },
    });
    expect(commands[2]?.input).toMatchObject({ TableName: "Sessions", ConsistentRead: true });
  });

  it("persists a separate bounded cursor for each recovery sweep", async () => {
    const calls: Array<{ constructor: { name: string }; input: Record<string, unknown> }> = [];
    const activity = activeActivityForAssignment({
      sessionId: running.id,
      repositoryId: running.repositoryId,
      queueShard: 0,
      attemptId: running.attemptId!,
    });
    const ctx = {
      doc: {
        send: async (command: {
          constructor: { name: string };
          input: Record<string, unknown>;
        }) => {
          calls.push(command);
          if (command.input.Key?.recordKey === "READY")
            return { Item: { recordType: "operational-activity-ready-v2" } };
          if (command.input.Key?.recordKey === "ack") return {};
          if (command.input.KeyConditionExpression) return { Items: [activity] };
          if (command.input.Key?.id === running.id) return { Item: running };
          return {};
        },
      },
      tables: { sessions: "Sessions", sessionDrains: "SessionDrains" },
    } as unknown as PlaneStorageCtx;

    await expect(listOperationalRecoveryPage(ctx, "ack", 2)).resolves.toMatchObject([
      { id: "running" },
    ]);
    expect(calls.find((call) => call.constructor.name === "QueryCommand")?.input).toMatchObject({
      ConsistentRead: true,
      Limit: 25,
      ExpressionAttributeValues: { ":scope": "__active#v2#0" },
    });
    expect(calls.find((call) => call.constructor.name === "PutCommand")?.input).toMatchObject({
      Item: { scopeKey: "__operational-activity#v2#cursor", recordKey: "ack", shard: 1 },
    });
  });

  it("keeps a repository member until a strong terminal check can delete it", async () => {
    const calls: Array<{ constructor: { name: string }; input: Record<string, unknown> }> = [];
    const activity = repositoryActivityForSession(running)!;
    const ctx = {
      doc: {
        send: async (command: {
          constructor: { name: string };
          input: Record<string, unknown>;
        }) => {
          calls.push(command);
          if (command.input.Key?.recordKey === "READY")
            return { Item: { recordType: "operational-activity-ready-v2" } };
          if (command.input.KeyConditionExpression) return { Items: [activity] };
          if (command.input.Key?.id === running.id)
            return { Item: { ...running, status: "completed" } };
          if (command.constructor.name === "TransactWriteCommand") return {};
          throw new Error("unexpected Dynamo command");
        },
      },
      tables: { sessions: "Sessions", sessionDrains: "SessionDrains" },
    } as unknown as PlaneStorageCtx;

    await expect(listRepositoryOperationalPage(ctx, "repo")).resolves.toMatchObject({
      sessions: [],
      observedMembers: 1,
    });
    const transaction = calls.find((call) => call.constructor.name === "TransactWriteCommand");
    expect(transaction?.input.TransactItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ConditionCheck: expect.objectContaining({ TableName: "Sessions" }),
        }),
        expect.objectContaining({
          Delete: expect.objectContaining({ TableName: "SessionDrains" }),
        }),
      ]),
    );
  });

  it("fences deferred lifecycle acknowledgement to the settled handoff generation", async () => {
    const commands: Array<{ input: Record<string, unknown> }> = [];
    const ctx = {
      doc: {
        send: async (command: { input: Record<string, unknown> }) => {
          commands.push(command);
          return {};
        },
      },
      tables: { sessions: "Sessions" },
    } as unknown as PlaneStorageCtx;
    const session = {
      ...running,
      terminalHookHandoffSettled: { handoffId: "handoff", hostId: "host" },
    };
    await expect(markTerminalHookLifecycleEnqueued(ctx, session, "2026-01-02")).resolves.toBe(true);
    expect(commands[0]?.input).toMatchObject({
      ConditionExpression: expect.stringContaining(
        "terminalHookHandoffSettled.handoffId = :handoffId",
      ),
      ExpressionAttributeValues: {
        ":createdAt": session.createdAt,
        ":attemptId": session.attemptId,
        ":handoffId": "handoff",
      },
    });
  });
});
