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

  return {
    putRepository: async (record: RepositoryRecord) => repositories.set(record.id, { ...record }),
    getRepository: async (id: string) => {
      const record = repositories.get(id);
      return record ? { ...record } : null;
    },
    listRepositories: async () => [...repositories.values()].map((record) => ({ ...record })),
    deleteRepository: async (id: string) => repositories.delete(id),
    putSchedule: async (record: import("./control-plane.ts").ScheduleRecord) =>
      schedules.set(record.id, { ...record }),
    getSchedule: async (id: string) => {
      const record = schedules.get(id);
      return record ? { ...record } : null;
    },
    listSchedules: async () => [...schedules.values()].map((record) => ({ ...record })),
    deleteSchedule: async (id: string) => schedules.delete(id),
    putCommand: async (record: CommandRecord) => commands.set(record.id, { ...record }),
    getCommand: async (id: string) => {
      const record = commands.get(id);
      return record ? { ...record } : null;
    },
    listCommands: async () => [...commands.values()].map((record) => ({ ...record })),
    deleteCommand: async (id: string) => commands.delete(id),
    putProvider: async (record: ProviderRecord) => providers.set(record.id, { ...record }),
    getProvider: async (id: string) => {
      const record = providers.get(id);
      return record ? { ...record } : null;
    },
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
      expectedUpdatedAt,
      updatedAt,
      patch,
    }: {
      id: string;
      expectedUpdatedAt: string;
      updatedAt: string;
      patch: Partial<
        Pick<ProviderAccountRecord, "providerId" | "label" | "usageLimitCooldownSeconds">
      >;
    }) => {
      const current = providerAccounts.get(id);
      if (!current || current.updatedAt !== expectedUpdatedAt) return false;
      providerAccounts.set(id, { ...current, ...patch, updatedAt });
      return true;
    },
    deleteProviderAccount: async (id: string) => providerAccounts.delete(id),
    putHostInventory: async (record: HostInventoryRecord) =>
      hostInventories.set(record.hostId, { ...record }),
    getHostInventory: async (id: string) => {
      const record = hostInventories.get(id);
      return record ? { ...record } : null;
    },
    listHostInventories: async () => [...hostInventories.values()].map((record) => ({ ...record })),
    deleteHostInventory: async (hostId: string) => hostInventories.delete(hostId),
    listAllSessions: async () => [],
    listAllWorktrees: async () => [],
    listConnections: async () => [],
    listArchives: async () => [],
  } as never;
}

describe("durable management restart visibility", () => {
  it("survives restart only after every create and update has completed", async () => {
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
