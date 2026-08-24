import { describe, expect, it } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import {
  buildProviderCatalog,
  resolveScheduledSessionTarget,
  resolveSessionTargetRouteAt,
} from "./control-plane-session-target.ts";
import { listSessionTargets } from "./control-plane-session-targets.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const worktree: WorktreeRecord = {
  id: "w",
  name: "w",
  hostId: "host",
  repositoryId: "repo",
  path: "/repo/w",
  labels: [],
  status: "idle",
  online: true,
};

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetLabels: ["cmd"],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "queued",
    queueShard: 0,
    createdAt: NOW,
    type: "prompt",
    source: "api",
    ...over,
  };
}

function catalogState() {
  const state = createControlPlaneState({ now: () => NOW });
  state.commands.set("cmd", {
    id: "cmd",
    name: "cmd",
    argv: ["tool"],
    appendPrompt: true,
    providerId: null,
  });
  state.hostInventories.set("host", {
    hostId: "host",
    repositories: [{ id: "repo", path: "/repo", defaultBranch: "main", worktrees: [] }],
    providerAccounts: [],
    commandProfiles: {},
    updatedAt: NOW,
  });
  return state;
}

describe("target optional routing residual coverage", () => {
  it("returns a frozen native route with its provider account", () => {
    const state = catalogState();
    state.commands.delete("cmd");
    state.providerAccounts.set("account", {
      id: "account",
      providerId: "provider",
      label: "account",
    });
    state.hostInventories.get("host")!.providerAccounts = [{ providerAccountId: "account" }];
    const row = session({
      resumedFromSessionId: "old",
      resumeFallback: true,
      pinnedTargetIndex: 0,
      pinnedCommandId: "frozen",
      pinnedProviderAccountId: "account",
      resumeSpec: { argv: ["frozen"], appendPrompt: false },
    });
    expect(
      resolveSessionTargetRouteAt(
        state,
        buildProviderCatalog(state),
        row,
        worktree,
        Date.parse(NOW),
        0,
      )?.providerAccountId,
    ).toBe("account");
  });

  it("honors a scheduled host pin when selecting a standalone command", () => {
    const state = catalogState();
    expect(
      resolveScheduledSessionTarget(
        state,
        buildProviderCatalog(state),
        session({
          type: "scheduled",
          source: "schedule",
          pinnedHostId: "host",
          pinnedTargetIndex: 0,
          pinnedCommandId: "cmd",
        }),
        "host",
      ),
    ).toMatchObject({ commandId: "cmd", targetIndex: 0 });
  });

  it("evaluates an attached provider account when the repository inventory is absent", () => {
    const state = createControlPlaneState({ now: () => NOW });
    state.providers.set("provider", {
      id: "provider",
      name: "provider",
      defaultCommandId: "provider-cmd",
    });
    state.providerAccounts.set("account", {
      id: "account",
      providerId: "provider",
      label: "account",
    });
    state.commands.set("provider-cmd", {
      id: "provider-cmd",
      name: "provider-cmd",
      argv: ["provider"],
      appendPrompt: true,
      providerId: "provider",
    });
    state.worktrees.set("w", worktree);
    state.connections.set("host-connection", {
      connectionId: "host-connection",
      type: "host",
      hostId: "host",
      connectedAt: NOW,
      lastHeartbeatAt: NOW,
      capabilities: [],
      repositoryIds: ["repo"],
      runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
      protocolVersion: 1,
      providerAccountReadiness: [
        { providerAccountId: "account", ready: true, fingerprint: "a".repeat(64) },
      ],
    });
    state.hostConnection.set("host", "host-connection");
    state.hostInventories.set("host", {
      hostId: "host",
      repositories: [
        {
          id: "repo",
          path: "/repo",
          defaultBranch: "main",
          worktrees: [{ id: "w", name: "w", path: "/repo/w", labels: [] }],
        },
      ],
      providerAccounts: [{ providerAccountId: "account" }],
      commandProfiles: {},
      updatedAt: NOW,
    });
    expect(listSessionTargets(state).find((target) => target.kind === "provider")?.available).toBe(
      true,
    );
  });
});
