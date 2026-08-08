import { describe, expect, it } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import { buildProviderCatalog, resolveSessionTargetArgv } from "./control-plane-session-target.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s1",
    repositoryId: "repo-1",
    prompt: "hello",
    targetLabel: "x",
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

describe("resolveSessionTargetArgv: provider-account cascade", () => {
  it("returns null for a provider account not attached to the target host", () => {
    const state = createControlPlaneState();
    state.providers.set("prov-1", {
      id: "prov-1",
      name: "claude",
      defaultCommandId: "cmd-1",
      createdAt: "t",
      updatedAt: "t",
    });
    state.providerAccounts.set("acct-1", {
      id: "acct-1",
      providerId: "prov-1",
      label: "x@y.com",
      createdAt: "t",
      updatedAt: "t",
    });
    state.commands.set("cmd-1", {
      id: "cmd-1",
      name: "claude-print",
      argv: ["claude", "-p"],
      appendPrompt: true,
      providerId: "prov-1",
      createdAt: "t",
      updatedAt: "t",
    });
    // No HostInventoryRecord seeded for host-1 at all.
    const catalog = buildProviderCatalog(state);
    const argv = resolveSessionTargetArgv(
      state,
      catalog,
      session({ providerAccountId: "acct-1" }),
      worktree(),
    );
    expect(argv).toBeNull();
  });

  it("resolves a provider account attached at host level via the provider default command", () => {
    const state = createControlPlaneState();
    state.providers.set("prov-1", {
      id: "prov-1",
      name: "claude",
      defaultCommandId: "cmd-1",
      createdAt: "t",
      updatedAt: "t",
    });
    state.providerAccounts.set("acct-1", {
      id: "acct-1",
      providerId: "prov-1",
      label: "x@y.com",
      createdAt: "t",
      updatedAt: "t",
    });
    state.commands.set("cmd-1", {
      id: "cmd-1",
      name: "claude-print",
      argv: ["claude", "-p"],
      appendPrompt: true,
      providerId: "prov-1",
      createdAt: "t",
      updatedAt: "t",
    });
    state.agentHosts.set("host-1", {
      hostId: "host-1",
      repositories: [],
      providerAccounts: [{ providerAccountId: "acct-1" }],
      commandProfiles: {},
      updatedAt: "t",
    });
    const catalog = buildProviderCatalog(state);
    const argv = resolveSessionTargetArgv(
      state,
      catalog,
      session({ providerAccountId: "acct-1", prompt: "do it" }),
      worktree(),
    );
    expect(argv).toEqual(["claude", "-p", "do it"]);
  });
});
