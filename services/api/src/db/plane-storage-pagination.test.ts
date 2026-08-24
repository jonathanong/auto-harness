import { describe, expect, it, vi } from "vitest";

import {
  listArchives,
  listHostInventories,
  listLogs,
  queryLogs,
  listRepositories,
  listSchedules,
} from "./plane-storage-catalog.ts";
import { listCommands, listProviders } from "./plane-storage-catalog-providers.ts";
import { listProviderAccounts } from "./plane-storage-provider-accounts.ts";
import { listSessionsByStatus, listWorktreesForRepo } from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";
describe("DynamoDB storage pagination", () => {
  it("exhausts every internal scan and query page", async () => {
    const pages: Record<string, Array<Record<string, unknown>[]>> = {
      Archives: [[{ key: "archive-1" }], [{ key: "archive-2" }]],
      Commands: [[{ id: "command-1" }], [{ id: "command-2" }]],
      HostInventories: [[{ hostId: "host-1" }], [{ hostId: "host-2" }]],
      ProviderAccounts: [[{ id: "account-1" }], [{ id: "account-2" }]],
      Providers: [[{ id: "provider-1" }], [{ id: "provider-2" }]],
      Repositories: [[{ id: "repository-1" }], [{ id: "repository-2" }]],
      Schedules: [[{ id: "schedule-1" }], [{ id: "schedule-2" }]],
      SessionLogs: [[{ sessionId: "session-1", seq: 1 }], [{ sessionId: "session-1", seq: 2 }]],
      Sessions: [
        [{ id: "session-1", statusShard: "queued#0", createdAt: "t1", priority: 0 }],
        [{ id: "session-2", createdAt: "t2", priority: 0 }],
      ],
      Worktrees: [[{ id: "worktree-1" }], [{ id: "worktree-2" }]],
    };
    const commands: Array<{ input: Record<string, unknown> }> = [];
    const doc = {
      async send(command: { input: Record<string, unknown> }) {
        commands.push(command);
        const tableName = command.input.TableName as string;
        const page = command.input.ExclusiveStartKey ? 1 : 0;
        return {
          Items: pages[tableName]?.[page] ?? [],
          LastEvaluatedKey: page === 0 ? { tableName } : {},
        };
      },
    };
    const ctx = {
      doc,
      tables: {
        archives: "Archives",
        commands: "Commands",
        hostInventories: "HostInventories",
        providerAccounts: "ProviderAccounts",
        providers: "Providers",
        repositories: "Repositories",
        schedules: "Schedules",
        sessionLogs: "SessionLogs",
        sessions: "Sessions",
        worktrees: "Worktrees",
      },
    } as unknown as PlaneStorageCtx;

    await expect(listLogs(ctx, "session-1")).resolves.toMatchObject([{ seq: 1 }, { seq: 2 }]);
    await expect(listSchedules(ctx)).resolves.toMatchObject([
      { id: "schedule-1" },
      { id: "schedule-2" },
    ]);
    await expect(listRepositories(ctx)).resolves.toMatchObject([
      { id: "repository-1" },
      { id: "repository-2" },
    ]);
    await expect(listArchives(ctx)).resolves.toMatchObject([
      { key: "archive-1" },
      { key: "archive-2" },
    ]);
    await expect(listHostInventories(ctx)).resolves.toMatchObject([
      { hostId: "host-1" },
      { hostId: "host-2" },
    ]);
    await expect(listProviders(ctx)).resolves.toMatchObject([
      { id: "provider-1" },
      { id: "provider-2" },
    ]);
    await expect(listProviderAccounts(ctx)).resolves.toMatchObject([
      { id: "account-1" },
      { id: "account-2" },
    ]);
    await expect(listCommands(ctx)).resolves.toMatchObject([
      { id: "command-1" },
      { id: "command-2" },
    ]);
    await expect(listSessionsByStatus(ctx, "queued", 0)).resolves.toMatchObject([
      { id: "session-1" },
      { id: "session-2" },
    ]);
    await expect(listWorktreesForRepo(ctx, "repository-1")).resolves.toMatchObject([
      { id: "worktree-1" },
      { id: "worktree-2" },
    ]);

    expect(commands).toHaveLength(22);
    for (let index = 0; index < 22; index += 2) {
      const firstPage = commands[index];
      const secondPage = commands[index + 1];
      expect(firstPage).toBeDefined();
      expect(secondPage).toBeDefined();
      if (!firstPage || !secondPage) continue;
      expect(firstPage.input.ExclusiveStartKey).toBeUndefined();
      expect(secondPage.input.ExclusiveStartKey).toEqual({ tableName: firstPage.input.TableName });
    }
    await expect(
      queryLogs(ctx, "session-1", { after: "cursor", stream: "stderr", limit: 25 }),
    ).resolves.toMatchObject([{ seq: 1 }]);
    expect(commands[22]?.input).toMatchObject({
      KeyConditionExpression: "sessionId = :sessionId AND timestampSeq > :after",
      ExpressionAttributeValues: {
        ":sessionId": "session-1",
        ":after": "cursor",
        ":stream": "stderr",
      },
      FilterExpression: "#stream = :stream",
      ExpressionAttributeNames: { "#stream": "stream" },
      Limit: 25,
    });
    await expect(queryLogs(ctx, "session-1", { after: "cursor", limit: 1 })).resolves.toHaveLength(
      1,
    );
    expect(commands[23]?.input.FilterExpression).toBeUndefined();
  });
  it("uses a bounded, ordered Dynamo query and continues sparse stream-filter pages", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [],
        LastEvaluatedKey: { sessionId: "session-1", timestampSeq: "first" },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            sessionId: "session-1",
            timestampSeq: "2026-01-01T00:00:01.000Z#0000000001",
            stream: "stdout",
            content: "line",
            timestamp: "2026-01-01T00:00:01.000Z",
            seq: 1,
          },
        ],
      });
    const ctx = {
      doc: { send },
      tables: { sessionLogs: "SessionLogs" },
    } as unknown as PlaneStorageCtx;

    await expect(
      queryLogs(ctx, "session-1", {
        stream: "stdout",
        since: "2026-01-01T00:00:00.000Z",
        limit: 1,
      }),
    ).resolves.toMatchObject([{ content: "line" }]);

    expect(send).toHaveBeenCalledTimes(2);
    const first = send.mock.calls[0]?.[0] as { input: Record<string, unknown> };
    const second = send.mock.calls[1]?.[0] as { input: Record<string, unknown> };
    expect(first.input).toMatchObject({
      KeyConditionExpression: "sessionId = :s AND timestampSeq > :since",
      FilterExpression: "#stream = :stream",
      ExpressionAttributeNames: { "#stream": "stream" },
      Limit: 1,
      ScanIndexForward: true,
      ExpressionAttributeValues: {
        ":s": "session-1",
        ":stream": "stdout",
        ":since": "2026-01-01T00:00:00.000Z\uffff",
      },
    });
    expect(second.input).toMatchObject({
      Limit: 1,
      ExclusiveStartKey: { sessionId: "session-1", timestampSeq: "first" },
    });
  });

  it("uses a consistent base-table scan when a repository lease fence needs authority", async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        { id: "held", repositoryId: "repo-1", currentSessionId: "session-1" },
        { id: "other", repositoryId: "repo-2" },
      ],
    });
    const ctx = {
      doc: { send },
      tables: { worktrees: "Worktrees" },
    } as unknown as PlaneStorageCtx;

    await expect(listWorktreesForRepo(ctx, "repo-1", true)).resolves.toEqual([
      { id: "held", repositoryId: "repo-1", currentSessionId: "session-1" },
    ]);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ ConsistentRead: true }) }),
    );
    expect(send.mock.calls[0]?.[0].input.IndexName).toBeUndefined();
  });
});
