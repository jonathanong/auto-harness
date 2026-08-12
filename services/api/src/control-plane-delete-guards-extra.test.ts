/* eslint-disable max-lines */
import { describe, expect, it } from "vitest";

import {
  dependenciesForAccount,
  dependenciesForCommand,
  dependenciesForProvider,
  dependenciesForRepository,
  refreshDeleteReferences,
  type DeleteReferences,
} from "./control-plane-delete-guards.ts";
import { createControlPlaneState } from "./control-plane-state.ts";

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
          worktrees: [
            {
              id: "worktree",
              providerAccountOverrides: { account: { commandId: "command" } },
            },
          ],
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
        {
          kind: "host-inventory",
          id: "host",
          scope: "repository",
          hostId: "host",
          repositoryId: "repository",
        },
        {
          kind: "host-inventory",
          id: "host",
          scope: "worktree",
          hostId: "host",
          repositoryId: "repository",
          worktreeId: "worktree",
        },
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

  it("treats absent override maps as no account dependency and reads in-memory references without storage", async () => {
    expect(
      dependenciesForAccount(
        {
          ...refs,
          inventories: [
            {
              hostId: "host",
              repositories: [{ id: "repository", worktrees: [{ id: "worktree" }] }],
              providerAccounts: [],
            },
          ],
        },
        "account",
      ),
    ).toEqual([{ kind: "session", id: "running", status: "running" }]);
    const state = createControlPlaneState();
    await expect(refreshDeleteReferences(state)).resolves.toMatchObject({ schedules: [] });
  });

  it("does not mistake an active session without a resolved route for a pinned catalog reference", () => {
    const unresolved = { ...refs.sessions[0] };
    delete unresolved.resolvedRoute;
    delete unresolved.pinnedProviderAccountId;
    delete unresolved.pinnedCommandId;
    expect(
      dependenciesForAccount({ ...refs, sessions: [unresolved], inventories: [] }, "account"),
    ).toEqual([]);
    expect(
      dependenciesForCommand(
        { ...refs, sessions: [unresolved], inventories: [], providers: [] },
        "other",
      ),
    ).toEqual([]);
  });

  it("keeps unrelated catalog rows out while recognizing direct account and command inventory attachments", () => {
    const mixed: DeleteReferences = {
      ...refs,
      schedules: [
        ...refs.schedules,
        {
          id: "other-schedule",
          repositoryId: "other",
          target: { commandId: "other" },
          fallbacks: [],
        },
      ],
      sessions: [
        ...refs.sessions,
        { ...refs.sessions[0], id: "other-session", target: { commandId: "other" }, fallbacks: [] },
      ],
      inventories: [
        {
          hostId: "direct-host",
          repositories: [{ id: "other", worktrees: [] }],
          providerAccounts: [{ providerAccountId: "account", commandId: "command" }],
        },
      ],
      accounts: [
        ...refs.accounts,
        { ...refs.accounts[0], id: "other-account", providerId: "other" },
      ],
      commands: [
        ...refs.commands,
        { ...refs.commands[0], id: "other-command", providerId: "other" },
      ],
    };
    expect(dependenciesForProvider(mixed, "provider")).not.toContainEqual({
      kind: "provider-account",
      id: "other-account",
    });
    expect(dependenciesForAccount(mixed, "account")).toContainEqual({
      kind: "host-inventory",
      id: "direct-host",
    });
    expect(dependenciesForCommand(mixed, "command")).toContainEqual({
      kind: "host-inventory",
      id: "direct-host",
      scope: "host",
      hostId: "direct-host",
    });
  });
});
