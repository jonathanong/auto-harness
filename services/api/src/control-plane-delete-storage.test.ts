import { describe, expect, it } from "vitest";

import { deleteCommand, deleteCommandDurable } from "./control-plane-command-delete.ts";
import { deleteProviderDurable } from "./control-plane-provider-delete.ts";
import { deleteRepository, deleteRepositoryDurable } from "./control-plane-repository-delete.ts";
import { createControlPlaneState } from "./control-plane-state.ts";

const now = "2026-01-01T00:00:00.000Z";

describe("non-durable catalog deletes with storage", () => {
  it("queues a command deletion after its cache entry is removed", async () => {
    const state = createControlPlaneState();
    state.commands.set("command", {
      id: "command",
      name: "command",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
      createdAt: now,
      updatedAt: now,
    });
    const deleted: string[] = [];
    state.storage = { deleteCommand: async (id: string) => void deleted.push(id) } as never;
    expect(deleteCommand(state, "command")).toEqual({ ok: true });
    await Promise.all(state.pendingPersists);
    expect(deleted).toEqual(["command"]);
  });

  it("queues a repository deletion after its cache entry is removed", async () => {
    const state = createControlPlaneState();
    state.repositories.set("repository", {
      id: "repository",
      name: "repository",
      url: "https://example.test/repository",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    });
    const deleted: string[] = [];
    state.storage = { deleteRepository: async (id: string) => void deleted.push(id) } as never;
    expect(deleteRepository(state, "repository")).toEqual({ ok: true });
    await Promise.all(state.pendingPersists);
    expect(deleted).toEqual(["repository"]);
  });

  it("retains a command when refreshed durable references prove it is still scheduled", async () => {
    const state = createControlPlaneState();
    const command = {
      id: "command",
      name: "command",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
      createdAt: now,
      updatedAt: now,
    };
    state.commands.set(command.id, command);
    const deleted: string[] = [];
    state.storage = {
      getCommand: async () => command,
      acquireDeletionMarker: async () => true,
      releaseDeletionMarker: async () => {},
      listSchedules: async () => [
        {
          id: "schedule",
          repositoryId: "repository",
          target: { commandId: command.id },
          fallbacks: [],
        },
      ],
      listAllSessions: async () => [],
      listSessionDrains: async () => [],
      listAllWorktrees: async () => [],
      listHostInventories: async () => [],
      listProviders: async () => [],
      listProviderAccounts: async () => [],
      listCommands: async () => [command],
      deleteCommand: async (id: string) => void deleted.push(id),
    } as never;
    await expect(deleteCommandDurable(state, command.id)).resolves.toMatchObject({
      ok: false,
      conflict: true,
      dependencies: [{ kind: "schedule", id: "schedule" }],
    });
    expect(deleted).toEqual([]);
    expect(state.commands.get(command.id)).toEqual(command);
  });

  it("retains a provider when refreshed durable commands still reference it", async () => {
    const state = createControlPlaneState();
    const provider = {
      id: "provider",
      name: "provider",
      defaultCommandId: null,
      createdAt: now,
      updatedAt: now,
    };
    const command = {
      id: "command",
      name: "command",
      argv: ["echo"],
      appendPrompt: true,
      providerId: provider.id,
      createdAt: now,
      updatedAt: now,
    };
    state.providers.set(provider.id, provider);
    const deleted: string[] = [];
    state.storage = {
      getProvider: async () => provider,
      listProviderAccounts: async () => [],
      listCommands: async () => [command],
      acquireDeletionMarker: async () => true,
      releaseDeletionMarker: async () => {},
      listSchedules: async () => [],
      listAllSessions: async () => [],
      listSessionDrains: async () => [],
      listAllWorktrees: async () => [],
      listHostInventories: async () => [],
      listProviders: async () => [provider],
      deleteProvider: async (id: string) => {
        deleted.push(id);
        return true;
      },
    } as never;
    await expect(deleteProviderDurable(state, provider.id)).resolves.toMatchObject({
      ok: false,
      conflict: true,
    });
    expect(deleted).toEqual([]);
    expect(state.providers.get(provider.id)).toEqual(provider);
  });

  it("retains a repository when refreshed durable schedules still reference it", async () => {
    const state = createControlPlaneState();
    const repository = {
      id: "repository",
      name: "repository",
      url: "https://example.test/repository",
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    };
    state.repositories.set(repository.id, repository);
    const deleted: string[] = [];
    state.storage = {
      getRepository: async () => repository,
      acquireDeletionMarker: async () => true,
      releaseDeletionMarker: async () => {},
      listSchedules: async () => [
        {
          id: "schedule",
          repositoryId: repository.id,
          target: { commandId: "command" },
          fallbacks: [],
        },
      ],
      listAllSessions: async () => [],
      listSessionDrains: async () => [],
      listAllWorktrees: async () => [],
      listHostInventories: async () => [],
      listProviders: async () => [],
      listProviderAccounts: async () => [],
      listCommands: async () => [],
      deleteRepository: async (id: string) => void deleted.push(id),
    } as never;
    await expect(deleteRepositoryDurable(state, repository.id)).resolves.toMatchObject({
      ok: false,
      conflict: true,
      dependencies: [{ kind: "schedule", id: "schedule" }],
    });
    expect(deleted).toEqual([]);
    expect(state.repositories.get(repository.id)).toEqual(repository);
  });
});
