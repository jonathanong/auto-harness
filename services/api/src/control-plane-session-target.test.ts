/* eslint-disable max-lines */
import { describe, expect, it } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import {
  buildProviderCatalog,
  resolveSessionTargetArgv,
  resolveSessionTargetRoute,
  resolveSessionTargetRouteAt,
} from "./control-plane-session-target.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s1",
    repositoryId: "repo-1",
    prompt: "hello",
    target: { commandId: "missing" },
    fallbacks: [],
    targetLabels: ["x"],
    queueTtlSeconds: 60,
    queueExpiresAt: "2099-01-01T00:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "queued",
    queueShard: 0,
    createdAt: "t",
    ...over,
  };
}

function worktree(over: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id: "wt-1",
    name: "wt-1",
    hostId: "host-1",
    repositoryId: "repo-1",
    path: "/w",
    labels: [],
    status: "idle",
    online: true,
    ...over,
  };
}

describe("resolveSessionTargetArgv", () => {
  it("resolves a standalone command, appending the prompt", () => {
    const state = createControlPlaneState();
    state.commands.set("cmd-1", {
      id: "cmd-1",
      name: "echo",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
      createdAt: "t",
      updatedAt: "t",
    });
    const catalog = buildProviderCatalog(state);
    const argv = resolveSessionTargetArgv(
      state,
      catalog,
      session({ target: { commandId: "cmd-1" } }),
      worktree(),
    );
    expect(argv).toEqual(["echo", "--", "hello"]);
  });

  it("resolves a standalone command without appending the prompt", () => {
    const state = createControlPlaneState();
    state.commands.set("cmd-1", {
      id: "cmd-1",
      name: "fixed",
      argv: ["fixed", "argv"],
      appendPrompt: false,
      providerId: null,
      createdAt: "t",
      updatedAt: "t",
    });
    const catalog = buildProviderCatalog(state);
    const argv = resolveSessionTargetArgv(
      state,
      catalog,
      session({ target: { commandId: "cmd-1" } }),
      worktree(),
    );
    expect(argv).toEqual(["fixed", "argv"]);
  });

  it("returns null for a standalone command that no longer exists", () => {
    const state = createControlPlaneState();
    const catalog = buildProviderCatalog(state);
    const argv = resolveSessionTargetArgv(
      state,
      catalog,
      session({ target: { commandId: "missing" } }),
      worktree(),
    );
    expect(argv).toBeNull();
  });

  it("returns null when the configured command target is unavailable", () => {
    const state = createControlPlaneState();
    const catalog = buildProviderCatalog(state);
    expect(
      resolveSessionTargetArgv(
        state,
        catalog,
        session({ target: { commandId: "missing" } }),
        worktree(),
      ),
    ).toBeNull();
  });

  it("resolves provider-owned command targets and rejects empty command argv", () => {
    const state = createControlPlaneState({ now: () => "2026-01-01T00:00:00.000Z" });
    state.providers.set("prov-1", {
      id: "prov-1",
      name: "claude",
      defaultCommandId: "cmd-provider",
      createdAt: "t",
      updatedAt: "t",
    });
    state.providerAccounts.set("acct-b", {
      id: "acct-b",
      providerId: "prov-1",
      label: "b",
      lastAssignedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "t",
      updatedAt: "t",
    });
    state.providerAccounts.set("acct-a", {
      id: "acct-a",
      providerId: "prov-1",
      label: "a",
      lastAssignedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "t",
      updatedAt: "t",
    });
    state.hostInventories.set("host-1", {
      hostId: "host-1",
      repositories: [],
      providerAccounts: [{ providerAccountId: "acct-a" }, { providerAccountId: "acct-b" }],
      commandProfiles: {},
      updatedAt: "t",
    });
    state.commands.set("cmd-provider", {
      id: "cmd-provider",
      name: "provider command",
      argv: ["claude", "--print"],
      appendPrompt: true,
      providerId: "prov-1",
      createdAt: "t",
      updatedAt: "t",
    });
    const catalog = buildProviderCatalog(state);
    const resolved = resolveSessionTargetRoute(
      state,
      catalog,
      session({ target: { commandId: "cmd-provider" } }),
      worktree(),
      Date.parse("2026-01-01T00:00:00.000Z"),
    );
    expect(resolved).toMatchObject({
      targetIndex: 0,
      providerAccountId: "acct-a",
      commandId: "cmd-provider",
      resolvedArgv: ["claude", "--print", "--", "hello"],
    });

    state.providerAccounts.get("acct-a")!.usageLimitedUntil = "2026-01-02T00:00:00.000Z";
    expect(
      resolveSessionTargetRoute(
        state,
        catalog,
        session({ target: { commandId: "cmd-provider" } }),
        worktree(),
        Date.parse("2026-01-01T00:00:00.000Z"),
      ),
    ).toMatchObject({ providerAccountId: "acct-b" });
    state.providerAccounts.get("acct-a")!.usageLimitedUntil = "2025-12-31T00:00:00.000Z";
    expect(
      resolveSessionTargetRoute(
        state,
        catalog,
        session({ target: { commandId: "cmd-provider" } }),
        worktree(),
        Date.parse("2026-01-01T00:00:00.000Z"),
      ),
    ).toMatchObject({ providerAccountId: "acct-a" });

    state.commands.get("cmd-provider")!.argv = [];
    expect(
      resolveSessionTargetArgv(
        state,
        catalog,
        session({ target: { commandId: "cmd-provider" } }),
        worktree(),
      ),
    ).toBeNull();
  });

  it("skips suppressed and native-fenced routes", () => {
    const state = createControlPlaneState({ now: () => "2026-01-01T00:00:00.000Z" });
    for (const id of ["cmd-primary", "cmd-fallback"]) {
      state.commands.set(id, {
        id,
        name: id,
        argv: [id],
        appendPrompt: false,
        providerId: null,
        createdAt: "t",
        updatedAt: "t",
      });
    }
    const catalog = buildProviderCatalog(state);
    const base = session({
      target: { commandId: "cmd-primary" },
      fallbacks: [{ commandId: "cmd-fallback" }],
      suppressedTargetIndexes: [0],
    });
    expect(
      resolveSessionTargetRoute(state, catalog, base, worktree(), Date.parse(state.now())),
    ).toMatchObject({ targetIndex: 1, commandId: "cmd-fallback" });
    expect(
      resolveSessionTargetRouteAt(state, catalog, base, worktree(), Date.parse(state.now()), 0),
    ).toBeNull();
    expect(
      resolveSessionTargetRouteAt(state, catalog, base, worktree(), Date.parse(state.now()), 9),
    ).toBeNull();
    expect(
      resolveSessionTargetRouteAt(state, catalog, base, worktree(), Date.parse(state.now()), 1),
    ).toMatchObject({ targetIndex: 1, commandId: "cmd-fallback" });
    expect(
      resolveSessionTargetRoute(
        state,
        catalog,
        session({
          target: { commandId: "cmd-primary" },
          pinnedHostId: "host-1",
          pinnedTargetIndex: 1,
          pinnedCommandId: "cmd-other",
        }),
        worktree(),
        Date.parse(state.now()),
      ),
    ).toBeNull();
  });
});

// Provider-account cascade cases (enablement + command override walk) live in
// control-plane-session-target-cascade.test.ts — split to stay under max-lines.
