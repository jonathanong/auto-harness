import { describe, expect, it } from "vitest";

import {
  listArchives,
  listHostInventories,
  listLogs,
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
      Sessions: [[{ id: "session-1", statusShard: "queued#0" }], [{ id: "session-2" }]],
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

    expect(commands).toHaveLength(20);
    for (let index = 0; index < 20; index += 2) {
      const firstPage = commands[index];
      const secondPage = commands[index + 1];
      expect(firstPage).toBeDefined();
      expect(secondPage).toBeDefined();
      if (!firstPage || !secondPage) continue;
      expect(firstPage.input.ExclusiveStartKey).toBeUndefined();
      expect(secondPage.input.ExclusiveStartKey).toEqual({ tableName: firstPage.input.TableName });
    }
  });
});
