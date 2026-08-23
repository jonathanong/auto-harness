import { describe, expect, it } from "vitest";

import {
  createSession,
  listAllSessions,
  listAllWorktrees,
  sessionDrainOperationId,
} from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

const marker = [{ key: "repository:repo", now: "now" }];
const session = (extra: Record<string, unknown> = {}) =>
  ({
    id: "session",
    repositoryId: "repo",
    prompt: "prompt",
    target: { commandId: "command" },
    fallbacks: [],
    targetLabels: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: "later",
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: "queued",
    queueShard: 0,
    createdAt: "now",
    ...extra,
  }) as never;
const ctx = (send: (command: unknown) => Promise<unknown>) =>
  ({
    doc: { send },
    tables: {
      sessions: "sessions",
      repositories: "repositories",
      sessionDrains: "session-drains",
      concurrencyLocks: "locks",
      worktrees: "worktrees",
    },
  }) as unknown as PlaneStorageCtx;
const cancelled = (failedIndex: number, count = 3) => ({
  name: "TransactionCanceledException",
  CancellationReasons: Array.from({ length: count }, (_, index) => ({
    Code: index === failedIndex ? "ConditionalCheckFailed" : "None",
  })),
});

describe("Dynamo session adapter mainline additions", () => {
  it("atomically registers an ACT member for normal and concurrency-owned creation", async () => {
    const commands: Array<{ input: { TransactItems?: Array<Record<string, unknown>> } }> = [];
    const storage = ctx(async (command) => {
      commands.push(command as { input: { TransactItems?: Array<Record<string, unknown>> } });
      return {};
    });

    await expect(
      createSession(storage, session({ id: "plain", principalId: "principal" })),
    ).resolves.toMatchObject({ created: true });
    await expect(
      createSession(
        storage,
        session({
          id: "concurrent",
          concurrencyId: "same-work",
          metadata: { createdBy: "legacy-principal" },
        }),
      ),
    ).resolves.toMatchObject({ created: true });

    expect(commands).toHaveLength(2);
    expect(commands.map((command) => command.input.TransactItems)).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({
            Put: expect.objectContaining({
              TableName: "session-drains",
              Item: expect.objectContaining({
                recordKey: "ACT#plain",
                principalId: "principal",
              }),
            }),
          }),
        ]),
        expect.arrayContaining([
          expect.objectContaining({
            Put: expect.objectContaining({
              TableName: "session-drains",
              Item: expect.objectContaining({
                recordKey: "ACT#concurrent",
                principalId: "legacy-principal",
              }),
            }),
          }),
        ]),
      ]),
    );
  });

  it("permits the session-protected ACT put to repair a stale member for a reused ID", async () => {
    const commands: Array<{ input: { TransactItems?: Array<Record<string, unknown>> } }> = [];
    await createSession(
      ctx(async (command) => {
        commands.push(command as { input: { TransactItems?: Array<Record<string, unknown>> } });
        return {};
      }),
      session({ id: "reused", principalId: "principal" }),
    );

    const items = commands[0]?.input.TransactItems ?? [];
    expect(items).toContainEqual(
      expect.objectContaining({
        Put: expect.objectContaining({
          TableName: "sessions",
          ConditionExpression: "attribute_not_exists(id)",
        }),
      }),
    );
    const activity = items.find(
      (item) => (item.Put as { TableName?: string } | undefined)?.TableName === "session-drains",
    )?.Put as Record<string, unknown> | undefined;
    expect(activity).toMatchObject({
      Item: expect.objectContaining({ recordKey: "ACT#reused", principalId: "principal" }),
    });
    expect(activity).not.toHaveProperty("ConditionExpression");
  });

  it("creates marker-fenced plain sessions and distinguishes marker and id conflicts", async () => {
    await expect(
      createSession(
        ctx(async () => ({})),
        session(),
        marker,
      ),
    ).resolves.toMatchObject({
      created: true,
    });
    await expect(
      createSession(
        ctx(async () => {
          throw cancelled(2);
        }),
        session(),
        marker,
      ),
    ).rejects.toThrow("session id collision: session");
    await expect(
      createSession(
        ctx(async () => {
          throw cancelled(0);
        }),
        session(),
        marker,
      ),
    ).rejects.toThrow("catalog deletion is in progress");
  });

  it("rejects a marker-fenced concurrent session when catalog deletion wins", async () => {
    await expect(
      createSession(
        ctx(async () => {
          throw cancelled(0, 4);
        }),
        session({ concurrencyId: "key" }),
        marker,
      ),
    ).rejects.toThrow("catalog deletion is in progress");
  });

  it("uses legacy metadata ownership for drain admission", async () => {
    let calls = 0;
    const rejected = createSession(
      ctx(async () => {
        calls += 1;
        if (calls === 1) throw cancelled(2, 4);
        return { Item: { operationId: "drain" } };
      }),
      session({ metadata: { createdBy: "principal" } }),
      marker,
    );

    await expect(rejected).rejects.toSatisfy(
      (error: unknown) => sessionDrainOperationId(error) === "drain",
    );
  });

  it("sets a consistent read when listing all worktrees", async () => {
    await expect(
      listAllSessions(
        ctx(async () => ({})),
        true,
      ),
    ).resolves.toEqual([]);
    await expect(
      listAllWorktrees(
        ctx(async () => ({})),
        true,
      ),
    ).resolves.toEqual([]);
  });
});
