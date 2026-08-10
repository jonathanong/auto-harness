import { describe, expect, it } from "vitest";

import { DEFAULT_USAGE_LIMIT_COOLDOWN_SECONDS } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import type {
  CommandRecord,
  HostInventoryRecord,
  ProviderAccountRecord,
  ProviderRecord,
  RepositoryRecord,
} from "./db/plane-storage.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

function rejectedStorage() {
  return new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error("storage unavailable");
        };
      },
    },
  ) as never;
}

const repository: RepositoryRecord = {
  id: "repo",
  name: "repo",
  url: "https://example.test/repo.git",
  defaultBranch: "main",
  createdAt: "t",
  updatedAt: "t",
};

const command: CommandRecord = {
  id: "cmd",
  name: "command",
  argv: ["echo"],
  appendPrompt: true,
  providerId: null,
  createdAt: "t",
  updatedAt: "t",
};

const provider: ProviderRecord = {
  id: "provider",
  name: "provider",
  defaultCommandId: null,
  createdAt: "t",
  updatedAt: "t",
};

const account: ProviderAccountRecord = {
  id: "account",
  providerId: provider.id,
  label: "account@example.test",
  usageLimitCooldownSeconds: DEFAULT_USAGE_LIMIT_COOLDOWN_SECONDS,
  usageLimitedUntil: null,
  lastUsageLimitedAt: null,
  lastAssignedAt: null,
  createdAt: "t",
  updatedAt: "t",
};

const inventory: HostInventoryRecord = {
  hostId: "host",
  repositories: [],
  providerAccounts: [],
  commandProfiles: {},
  updatedAt: "t",
};

function seed(plane: ControlPlane): void {
  plane.state.repositories.set(repository.id, { ...repository });
  plane.state.commands.set(command.id, { ...command });
  plane.state.providers.set(provider.id, { ...provider });
  plane.state.providers.set("empty-provider", {
    ...provider,
    id: "empty-provider",
    name: "empty-provider",
  });
  plane.state.providerAccounts.set(account.id, { ...account });
  plane.state.schedules.set("schedule", {
    id: "schedule",
    repositoryId: repository.id,
    name: "schedule",
    target: { commandId: command.id },
    fallbacks: [],
    targetLabels: [command.name],
    cron: "* * * * *",
    enabled: true,
    timeout: 1,
    queueTtlSeconds: 60,
    nextRunAt: "2026-01-01T00:00:00.000Z",
    lastRunAt: null,
    createdAt: "t",
  });
  plane.state.hostInventories.set(inventory.hostId, { ...inventory });
}

function errorCode(response: Awaited<ReturnType<typeof invokeHandler>>): string | undefined {
  return (response.json as { error?: { code?: string } }).error?.code;
}

describe("management routes durable writes", () => {
  it("returns structured 500s and leaves cache unchanged when catalog writes fail", async () => {
    const plane = new ControlPlane({
      storage: rejectedStorage(),
      repositoryIdFactory: () => "new-repo",
      scheduleIdFactory: () => "new-schedule",
      commandIdFactory: () => "new-command",
      providerIdFactory: () => "new-provider",
      providerAccountIdFactory: () => "new-account",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    seed(plane);
    const { handler } = createLocalApp({ plane });
    const invoke = (method: string, path: string, body?: unknown) =>
      invokeHandler(handler, method, path, body);

    const creates = await Promise.all([
      invoke("POST", "/api/v1/repositories", {
        name: "new-repo",
        url: "https://example.test/new.git",
      }),
      invoke("POST", "/api/v1/schedules", {
        repositoryId: repository.id,
        name: "new-schedule",
        target: { commandId: command.id },
        cron: "* * * * *",
        timeout: 1,
        nextRunAt: "2026-01-01T00:00:00.000Z",
      }),
      invoke("POST", "/api/v1/commands", { name: "new-command", argv: ["echo"] }),
      invoke("POST", "/api/v1/providers", { name: "new-provider" }),
      invoke("POST", "/api/v1/provider-accounts", {
        providerId: provider.id,
        label: "new@example.test",
      }),
      invoke("PUT", "/api/v1/hosts/new-host/inventory", { repositories: [], commandProfiles: {} }),
    ]);
    for (const response of creates) {
      expect(response.status).toBe(500);
      expect(errorCode(response)).toBe("INTERNAL_ERROR");
    }
    expect(plane.getRepository("new-repo")).toBeNull();
    expect(plane.getSchedule("new-schedule")).toBeNull();
    expect(plane.getCommand("new-command")).toBeNull();
    expect(plane.getProvider("new-provider")).toBeNull();
    expect(plane.getProviderAccount("new-account")).toBeNull();
    expect(plane.getHostInventory("new-host")).toBeNull();

    const updates = await Promise.all([
      invoke("PATCH", "/api/v1/repositories/repo", { name: "changed-repo" }),
      invoke("PATCH", "/api/v1/schedules/schedule", { name: "changed-schedule" }),
      invoke("PATCH", "/api/v1/commands/cmd", { name: "changed-command" }),
      invoke("PATCH", "/api/v1/providers/provider", { name: "changed-provider" }),
      invoke("PATCH", "/api/v1/provider-accounts/account", { label: "changed@example.test" }),
      invoke("PUT", "/api/v1/hosts/host/inventory", { repositories: [], commandProfiles: {} }),
    ]);
    for (const response of updates) {
      expect(response.status).toBe(500);
      expect(errorCode(response)).toBe("INTERNAL_ERROR");
    }
    expect(plane.getRepository(repository.id)?.name).toBe(repository.name);
    expect(plane.getSchedule("schedule")?.name).toBe("schedule");
    expect(plane.getCommand(command.id)?.name).toBe(command.name);
    expect(plane.getProvider(provider.id)?.name).toBe(provider.name);
    expect(plane.getProviderAccount(account.id)?.label).toBe(account.label);
    expect(plane.getHostInventory(inventory.hostId)).toMatchObject(inventory);

    const deletes = await Promise.all([
      invoke("DELETE", "/api/v1/repositories/repo"),
      invoke("DELETE", "/api/v1/schedules/schedule"),
      invoke("DELETE", "/api/v1/commands/cmd"),
      invoke("DELETE", "/api/v1/providers/empty-provider"),
      invoke("DELETE", "/api/v1/provider-accounts/account"),
      invoke("DELETE", "/api/v1/hosts/host/inventory"),
    ]);
    for (const response of deletes) {
      expect(response.status).toBe(500);
      expect(errorCode(response)).toBe("INTERNAL_ERROR");
    }
    expect(plane.getRepository(repository.id)).not.toBeNull();
    expect(plane.getSchedule("schedule")).not.toBeNull();
    expect(plane.getCommand(command.id)).not.toBeNull();
    expect(plane.getProvider("empty-provider")).not.toBeNull();
    expect(plane.getProviderAccount(account.id)).not.toBeNull();
    expect(plane.getHostInventory(inventory.hostId)).not.toBeNull();
  });
});
