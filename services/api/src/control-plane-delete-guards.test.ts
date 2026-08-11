import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import {
  deleteConflict,
  dependenciesForAccount,
  dependenciesForCommand,
  dependenciesForProvider,
  referencesFromState,
} from "./control-plane-delete-guards.ts";
import {
  inventoryReferenceMarkers,
  markersFor,
  referenceMarkers,
} from "./control-plane-delete-reference-markers.ts";

function setup() {
  const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
  plane.createProvider({ id: "provider", name: "claude" });
  plane.createCommand({ id: "command", name: "claude", argv: ["claude"], providerId: "provider" });
  plane.createProviderAccount({ id: "account", providerId: "provider", label: "a@example.test" });
  plane.createRepository({ id: "repository", name: "repo", url: "https://example.test/repo" });
  return plane;
}

describe("catalog delete references", () => {
  it("reports live provider, command, and account dependencies", () => {
    const plane = setup();
    plane.putSchedule({
      id: "schedule",
      repositoryId: "repository",
      name: "nightly",
      target: { commandId: "command" },
      cron: "* * * * *",
      timeout: 1,
    });
    const created = plane.createSession({
      repositoryId: "repository",
      prompt: "fix",
      target: { providerId: "provider" },
      timeout: 1,
    });
    plane.putHostInventory("host", {
      repositories: [],
      providerAccounts: [{ providerAccountId: "account", commandId: "command" }],
      commandProfiles: {},
    });
    const refs = referencesFromState(plane.state);
    expect(dependenciesForProvider(refs, "provider")).toEqual(
      expect.arrayContaining([
        { kind: "provider-account", id: "account" },
        { kind: "command", id: "command" },
        { kind: "session", id: created.ok ? created.session.id : "", status: "queued" },
      ]),
    );
    expect(dependenciesForCommand(refs, "command")).toEqual(
      expect.arrayContaining([
        { kind: "schedule", id: "schedule" },
        { kind: "host-inventory", id: "host" },
      ]),
    );
    expect(dependenciesForAccount(refs, "account")).toEqual([
      { kind: "host-inventory", id: "host" },
    ]);
  });

  it("blocks direct deletes while targets are still live", () => {
    const plane = setup();
    plane.putSchedule({
      id: "schedule",
      repositoryId: "repository",
      name: "nightly",
      target: { commandId: "command" },
      cron: "* * * * *",
      timeout: 1,
    });
    plane.createSession({
      repositoryId: "repository",
      prompt: "fix",
      target: { commandId: "command" },
      timeout: 1,
    });
    plane.seedWorktree({
      id: "worktree",
      name: "worktree",
      hostId: "host",
      repositoryId: "repository",
      path: "/repo/wt",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.putHostInventory("host", {
      repositories: [
        {
          id: "repository",
          path: "/repo",
          worktrees: [{ id: "worktree", name: "worktree", path: "/repo/wt", labels: [] }],
        },
      ],
      commandProfiles: {},
    });
    expect(plane.deleteCommand("command")).toMatchObject({ ok: false, conflict: true });
    expect(plane.deleteRepository("repository")).toMatchObject({
      ok: false,
      conflict: true,
      dependencies: expect.arrayContaining([
        { kind: "schedule", id: "schedule" },
        { kind: "worktree", id: "worktree" },
      ]),
    });
  });

  it("does not preserve terminal session history as a delete reference", () => {
    const plane = setup();
    plane.state.sessions.set("history", {
      id: "history",
      repositoryId: "repository",
      prompt: "done",
      target: { commandId: "command" },
      fallbacks: [],
      targetLabels: [],
      queueTtlSeconds: 1,
      queueExpiresAt: "2026-01-01T00:01:00.000Z",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      status: "completed",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(plane.deleteCommand("command")).toEqual({ ok: true });
  });

  it("formats a conflict and reports an empty dependency set as safe", () => {
    expect(deleteConflict("command", [])).toEqual({ ok: true });
    expect(
      deleteConflict("command", [{ kind: "session", id: "session", status: "running" }]),
    ).toEqual({
      ok: false,
      conflict: true,
      dependencies: [{ kind: "session", id: "session", status: "running" }],
      error: "cannot delete command; referenced by session session (running)",
    });
  });

  it("derives stable Dynamo marker keys for every catalog reference shape", () => {
    expect(referenceMarkers("now", {})).toEqual([]);
    expect(
      referenceMarkers("now", {
        repositoryId: "repo",
        target: { providerId: "provider" },
        fallbacks: [{ commandId: "command" }],
      }),
    ).toEqual([
      { key: "command:command", now: "now" },
      { key: "provider:provider", now: "now" },
      { key: "repository:repo", now: "now" },
    ]);
    expect(markersFor("now", ["command:c", "command:c", "provider:p"])).toEqual([
      { key: "command:c", now: "now" },
      { key: "provider:p", now: "now" },
    ]);
    expect(
      inventoryReferenceMarkers("now", {
        hostId: "host",
        repositories: [
          {
            id: "repo",
            providerAccountOverrides: { account: { commandId: "repo-command" } },
            worktrees: [
              { providerAccountOverrides: { account: { commandId: "worktree-command" } } },
            ],
          },
        ],
        providerAccounts: [{ providerAccountId: "account", commandId: "account-command" }],
      }),
    ).toEqual([
      { key: "command:account-command", now: "now" },
      { key: "command:repo-command", now: "now" },
      { key: "command:worktree-command", now: "now" },
      { key: "provider-account:account", now: "now" },
      { key: "repository:repo", now: "now" },
    ]);
  });
});
