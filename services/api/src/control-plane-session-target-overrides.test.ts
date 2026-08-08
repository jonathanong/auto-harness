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
    agentId: "host-1",
    repositoryId: "repo-1",
    path: "/w",
    labels: [],
    status: "idle",
    online: true,
    ...over,
  };
}

describe("resolveSessionTargetArgv: repo/worktree overrides", () => {
  it("returns null when disabled at repository scope despite host attachment", () => {
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
      agentId: "host-1",
      repositories: [
        {
          id: "repo-1",
          path: "/repo",
          defaultBranch: "main",
          providerAccountOverrides: { "acct-1": { enabled: false } },
          worktrees: [{ id: "wt-1", name: "wt-1", path: "/repo/wt-1", labels: [] }],
        },
      ],
      providerAccounts: [{ providerAccountId: "acct-1" }],
      commandProfiles: {},
      updatedAt: "t",
    });
    const catalog = buildProviderCatalog(state);
    const argv = resolveSessionTargetArgv(
      state,
      catalog,
      session({ providerAccountId: "acct-1" }),
      worktree(),
    );
    expect(argv).toBeNull();
  });

  it("resolves the worktree-level command override over the provider default", () => {
    const state = createControlPlaneState();
    state.providers.set("prov-1", {
      id: "prov-1",
      name: "claude",
      defaultCommandId: "cmd-default",
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
    state.commands.set("cmd-default", {
      id: "cmd-default",
      name: "claude-print",
      argv: ["claude", "-p"],
      appendPrompt: true,
      providerId: "prov-1",
      createdAt: "t",
      updatedAt: "t",
    });
    state.commands.set("cmd-override", {
      id: "cmd-override",
      name: "claude-verbose",
      argv: ["claude", "-p", "--verbose"],
      appendPrompt: true,
      providerId: "prov-1",
      createdAt: "t",
      updatedAt: "t",
    });
    state.agentHosts.set("host-1", {
      agentId: "host-1",
      repositories: [
        {
          id: "repo-1",
          path: "/repo",
          defaultBranch: "main",
          worktrees: [
            {
              id: "wt-1",
              name: "wt-1",
              path: "/repo/wt-1",
              labels: [],
              providerAccountOverrides: { "acct-1": { commandId: "cmd-override" } },
            },
          ],
        },
      ],
      providerAccounts: [{ providerAccountId: "acct-1" }],
      commandProfiles: {},
      updatedAt: "t",
    });
    const catalog = buildProviderCatalog(state);
    const argv = resolveSessionTargetArgv(
      state,
      catalog,
      session({ providerAccountId: "acct-1", prompt: "go" }),
      worktree(),
    );
    expect(argv).toEqual(["claude", "-p", "--verbose", "go"]);
  });

  it("returns null when enabled but the provider has no default command anywhere", () => {
    const state = createControlPlaneState();
    state.providers.set("prov-1", {
      id: "prov-1",
      name: "claude",
      defaultCommandId: null,
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
    state.agentHosts.set("host-1", {
      agentId: "host-1",
      repositories: [],
      providerAccounts: [{ providerAccountId: "acct-1" }],
      commandProfiles: {},
      updatedAt: "t",
    });
    const catalog = buildProviderCatalog(state);
    const argv = resolveSessionTargetArgv(
      state,
      catalog,
      session({ providerAccountId: "acct-1" }),
      worktree(),
    );
    expect(argv).toBeNull();
  });
});
