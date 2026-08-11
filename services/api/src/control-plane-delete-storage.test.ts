import { describe, expect, it } from "vitest";

import { deleteCommand } from "./control-plane-command-delete.ts";
import { deleteRepository } from "./control-plane-repository-delete.ts";
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
});
