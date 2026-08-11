import { describe, expect, it } from "vitest";

import {
  dependenciesForAccount,
  dependenciesForCommand,
  dependenciesForProvider,
  dependenciesForRepository,
  type DeleteReferences,
} from "./control-plane-delete-guards.ts";

const now = "2026-01-01T00:00:00.000Z";
const refs: DeleteReferences = {
  schedules: [
    {
      id: "schedule",
      repositoryId: "repository",
      target: { providerId: "provider" },
      fallbacks: [{ commandId: "command" }],
    },
  ],
  sessions: [
    {
      id: "running",
      repositoryId: "repository",
      prompt: "run",
      target: { commandId: "command" },
      fallbacks: [{ providerId: "provider" }],
      targetLabels: [],
      queueTtlSeconds: 1,
      queueExpiresAt: now,
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      status: "running",
      queueShard: 0,
      createdAt: now,
      resolvedRoute: { providerAccountId: "account", commandId: "command" },
      pinnedProviderAccountId: "account",
      pinnedCommandId: "command",
    },
  ],
  worktrees: [{ id: "worktree", repositoryId: "repository" }],
  inventories: [
    {
      hostId: "host",
      repositories: [
        {
          id: "repository",
          providerAccountOverrides: { account: { commandId: "command" } },
          worktrees: [{ providerAccountOverrides: { account: { commandId: "command" } } }],
        },
      ],
      providerAccounts: [],
    },
  ],
  providers: [
    {
      id: "provider",
      name: "provider",
      defaultCommandId: "command",
      createdAt: now,
      updatedAt: now,
    },
  ],
  accounts: [
    { id: "account", providerId: "provider", label: "account", createdAt: now, updatedAt: now },
  ],
  commands: [
    {
      id: "command",
      name: "command",
      argv: ["echo"],
      appendPrompt: true,
      providerId: "provider",
      createdAt: now,
      updatedAt: now,
    },
  ],
};

describe("catalog delete references in every route shape", () => {
  it("discovers provider, account, command, and repository dependents through fallbacks and overrides", () => {
    expect(dependenciesForProvider(refs, "provider")).toEqual(
      expect.arrayContaining([
        { kind: "schedule", id: "schedule" },
        { kind: "session", id: "running", status: "running" },
      ]),
    );
    expect(dependenciesForAccount(refs, "account")).toEqual(
      expect.arrayContaining([
        { kind: "host-inventory", id: "host" },
        { kind: "session", id: "running", status: "running" },
      ]),
    );
    expect(dependenciesForCommand(refs, "command")).toEqual(
      expect.arrayContaining([
        { kind: "provider", id: "provider" },
        { kind: "host-inventory", id: "host" },
        { kind: "schedule", id: "schedule" },
        { kind: "session", id: "running", status: "running" },
      ]),
    );
    expect(dependenciesForRepository(refs, "repository")).toEqual(
      expect.arrayContaining([
        { kind: "schedule", id: "schedule" },
        { kind: "session", id: "running", status: "running" },
        { kind: "worktree", id: "worktree" },
        { kind: "host-inventory", id: "host" },
      ]),
    );
  });
});
