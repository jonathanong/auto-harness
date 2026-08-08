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
      session({ commandId: "cmd-1" }),
      worktree(),
    );
    expect(argv).toEqual(["echo", "hello"]);
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
      session({ commandId: "cmd-1" }),
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
      session({ commandId: "missing" }),
      worktree(),
    );
    expect(argv).toBeNull();
  });

  it("returns null when neither commandId nor providerAccountId is set", () => {
    const state = createControlPlaneState();
    const catalog = buildProviderCatalog(state);
    expect(resolveSessionTargetArgv(state, catalog, session(), worktree())).toBeNull();
  });
});

// Provider-account cascade cases (enablement + command override walk) live in
// control-plane-session-target-cascade.test.ts — split to stay under max-lines.
