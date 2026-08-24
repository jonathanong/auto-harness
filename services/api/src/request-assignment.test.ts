import { HOST_PROTOCOL_VERSION } from "@auto-harness/shared";
import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { seedBaseCommand, baseSessionBody } from "./control-plane-test-helpers.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { requestAssignment } from "./request-assignment.ts";

const NOW = "2026-01-01T00:00:00.000Z";

describe("requestAssignment", () => {
  it("assigns a queued prompt session immediately", async () => {
    const plane = new ControlPlane({
      now: () => NOW,
      idFactory: () => "sess-1",
      shardCount: 1,
    });
    seedBaseCommand(plane);
    plane.seedWorktree({
      id: "wt-1",
      name: "wt-1",
      hostId: "host-1",
      repositoryId: "repo-1",
      path: "/wt-1",
      labels: [],
      status: "idle",
      online: true,
    });
    expect(plane.createSession(baseSessionBody()).ok).toBe(true);
    expect(plane.getSession("sess-1")?.status).toBe("queued");
    await requestAssignment(plane.state);
    expect(plane.getSession("sess-1")?.status).toBe("running");
    expect(plane.getSession("sess-1")?.worktreeId).toBe("wt-1");
  });

  it("swallows assignment failures so the originating mutation still succeeds", async () => {
    const state = createControlPlaneState({
      storage: {
        listConnections: async () => {
          throw new Error("ddb unavailable");
        },
        listCommands: async () => [],
        listProviders: async () => [],
        listProviderAccounts: async () => [],
        listRepositories: async () => [],
        listHostInventories: async () => [],
        listSessionsByStatus: async () => {
          throw new Error("ddb unavailable");
        },
      } as never,
    });
    await expect(requestAssignment(state)).resolves.toBeUndefined();
  });

  it("no-ops when nothing is queued", async () => {
    const plane = new ControlPlane({ now: () => NOW, shardCount: 1 });
    plane.registerHost({
      hostId: "host-1",
      worktrees: [],
      protocolVersion: HOST_PROTOCOL_VERSION,
      runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
    });
    await expect(requestAssignment(plane.state)).resolves.toBeUndefined();
  });
});
