import { describe, expect, it } from "vitest";

import type {
  CommandRecord,
  HostInventoryRecord,
  ProviderAccountRecord,
  ProviderRecord,
  RepositoryRecord,
} from "./db/plane-storage.ts";
import { ControlPlane } from "./control-plane.ts";

function catalogStorage() {
  const repositories = new Map<string, RepositoryRecord>();
  const schedules = new Map<string, import("./control-plane.ts").ScheduleRecord>();
  const commands = new Map<string, CommandRecord>();
  const providers = new Map<string, ProviderRecord>();
  const providerAccounts = new Map<string, ProviderAccountRecord>();
  const hostInventories = new Map<string, HostInventoryRecord>();
  const worktrees = new Map<string, import("./db/types.ts").WorktreeRecord>();

  return {
    putRepository: async (record: RepositoryRecord) => repositories.set(record.id, { ...record }),
    listRepositories: async () => [...repositories.values()].map((record) => ({ ...record })),
    deleteRepository: async (id: string) => repositories.delete(id),
    putSchedule: async (record: import("./control-plane.ts").ScheduleRecord) =>
      schedules.set(record.id, { ...record }),
    updateScheduleManagement: async (
      record: import("./control-plane.ts").ScheduleRecord,
      expectedNextRunAt: string,
    ) => {
      const current = schedules.get(record.id);
      if (!current || current.nextRunAt !== expectedNextRunAt) return null;
      const updated = {
        ...record,
        lastRunAt: current.lastRunAt,
      };
      schedules.set(record.id, updated);
      return { ...updated };
    },
    listSchedules: async () => [...schedules.values()].map((record) => ({ ...record })),
    deleteSchedule: async (id: string) => schedules.delete(id),
    putCommand: async (record: CommandRecord) => commands.set(record.id, { ...record }),
    listCommands: async () => [...commands.values()].map((record) => ({ ...record })),
    deleteCommand: async (id: string) => commands.delete(id),
    putProvider: async (record: ProviderRecord) => providers.set(record.id, { ...record }),
    listProviders: async () => [...providers.values()].map((record) => ({ ...record })),
    deleteProvider: async (id: string) => providers.delete(id),
    putProviderAccount: async (record: ProviderAccountRecord) =>
      providerAccounts.set(record.id, { ...record }),
    getProviderAccount: async (id: string) => {
      const record = providerAccounts.get(id);
      return record ? { ...record } : null;
    },
    listProviderAccounts: async () =>
      [...providerAccounts.values()].map((record) => ({ ...record })),
    updateProviderAccount: async ({
      id,
      expectedVersion,
      updatedAt,
      patch,
    }: {
      id: string;
      expectedVersion: number;
      updatedAt: string;
      patch: Partial<
        Pick<ProviderAccountRecord, "providerId" | "label" | "usageLimitCooldownSeconds">
      >;
    }) => {
      const current = providerAccounts.get(id);
      if (!current || (current.version ?? 0) !== expectedVersion) return false;
      providerAccounts.set(id, { ...current, ...patch, updatedAt, version: expectedVersion + 1 });
      return true;
    },
    deleteProviderAccount: async (id: string) => providerAccounts.delete(id),
    putHostInventory: async (record: HostInventoryRecord) =>
      hostInventories.set(record.hostId, { ...record }),
    listHostInventories: async () => [...hostInventories.values()].map((record) => ({ ...record })),
    deleteHostInventory: async (hostId: string) => hostInventories.delete(hostId),
    putWorktree: async (record: import("./db/types.ts").WorktreeRecord) =>
      worktrees.set(record.id, { ...record }),
    deleteWorktree: async (id: string) => worktrees.delete(id),
    listAllSessions: async () => [],
    listAllWorktrees: async () => [...worktrees.values()].map((record) => ({ ...record })),
    listConnections: async () => [],
    listArchives: async () => [],
  } as never;
}

describe("durable management restart visibility", () => {
  it("persists durable management changes across restarts", async () => {
    const storage = catalogStorage();
    const plane = new ControlPlane({
      storage,
      now: () => "2026-01-01T00:00:00.000Z",
      repositoryIdFactory: () => "repository",
      scheduleIdFactory: () => "schedule",
      commandIdFactory: () => "command",
      providerIdFactory: () => "provider",
      providerAccountIdFactory: () => "account",
    });

    expect(
      (await plane.createRepositoryDurable({ name: "repository", url: "https://example.test/r" }))
        .ok,
    ).toBe(true);
    expect((await plane.createCommandDurable({ name: "command", argv: ["echo"] })).ok).toBe(true);
    expect((await plane.createProviderDurable({ name: "provider" })).ok).toBe(true);
    expect(
      (
        await plane.createProviderAccountDurable({
          providerId: "provider",
          label: "account@example.test",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await plane.putScheduleDurable({
          repositoryId: "repository",
          name: "schedule",
          target: { commandId: "command" },
          cron: "* * * * *",
          timeout: 1,
          nextRunAt: "2026-01-01T00:00:00.000Z",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await plane.putHostInventoryDurable("host", {
          repositories: [
            {
              id: "repository",
              path: "/repository",
              defaultBranch: "main",
              worktrees: [{ id: "worktree", name: "worktree", path: "/repository/wt", labels: [] }],
            },
          ],
          commandProfiles: {},
        })
      ).ok,
    ).toBe(true);

    const afterCreate = new ControlPlane({ storage });
    await afterCreate.hydrateFromStorage();
    expect(
      afterCreate.listWorktrees().find((worktree) => worktree.id === "worktree"),
    ).toMatchObject({
      path: "/repository/wt",
    });

    expect(
      (await plane.updateRepositoryDurable("repository", { name: "repository-updated" })).ok,
    ).toBe(true);
    expect((await plane.updateCommandDurable("command", { name: "command-updated" })).ok).toBe(
      true,
    );
    expect((await plane.updateProviderDurable("provider", { name: "provider-updated" })).ok).toBe(
      true,
    );
    expect(
      (await plane.updateProviderAccountDurable("account", { label: "updated@example.test" })).ok,
    ).toBe(true);
    expect((await plane.updateScheduleDurable("schedule", { name: "schedule-updated" })).ok).toBe(
      true,
    );
    expect(
      (
        await plane.putHostInventoryDurable("host", {
          repositories: [],
          commandProfiles: {},
          logLevel: "debug",
        })
      ).ok,
    ).toBe(true);

    const restarted = new ControlPlane({ storage });
    await restarted.hydrateFromStorage();
    expect(restarted.getRepository("repository")?.name).toBe("repository-updated");
    expect(restarted.getCommand("command")?.name).toBe("command-updated");
    expect(restarted.getProvider("provider")?.name).toBe("provider-updated");
    expect(restarted.getProviderAccount("account")?.label).toBe("updated@example.test");
    expect(restarted.getSchedule("schedule")?.name).toBe("schedule-updated");
    expect(restarted.getHostInventory("host")?.logLevel).toBe("debug");
    expect(restarted.listWorktrees().filter((worktree) => worktree.hostId === "host")).toEqual([]);

    expect((await plane.deleteRepositoryDurable("repository")).ok).toBe(true);
    expect((await plane.deleteScheduleDurable("schedule")).ok).toBe(true);
    expect((await plane.deleteCommandDurable("command")).ok).toBe(true);
    expect((await plane.deleteProviderAccountDurable("account")).ok).toBe(true);
    expect((await plane.deleteProviderDurable("provider")).ok).toBe(true);
    expect((await plane.deleteHostInventoryDurable("host")).ok).toBe(true);

    const afterDeletes = new ControlPlane({ storage });
    await afterDeletes.hydrateFromStorage();
    expect(afterDeletes.getRepository("repository")).toBeNull();
    expect(afterDeletes.getSchedule("schedule")).toBeNull();
    expect(afterDeletes.getCommand("command")).toBeNull();
    expect(afterDeletes.getProviderAccount("account")).toBeNull();
    expect(afterDeletes.getProvider("provider")).toBeNull();
    expect(afterDeletes.getHostInventory("host")).toBeNull();
  });
});
