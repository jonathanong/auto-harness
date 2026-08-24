import { HOST_PROTOCOL_VERSION } from "@auto-harness/shared";
import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { seedBaseCommand, baseSessionBody } from "./control-plane-test-helpers.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
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

  it("does not refresh durable catalogs when the queue is empty", async () => {
    const state = createControlPlaneState({ now: () => NOW, shardCount: 1 });
    let catalogReads = 0;
    setDurableReadStorage(state, {
      listConnections: async () => {
        catalogReads += 1;
        return [];
      },
    });

    await expect(requestAssignment(state)).resolves.toBeUndefined();
    expect(catalogReads).toBe(0);
  });

  it("loads the durable queue once for a multi-session assignment sweep", async () => {
    const plane = new ControlPlane({ now: () => NOW, shardCount: 1 });
    seedBaseCommand(plane);
    expect(plane.createSession(baseSessionBody({ prompt: "first" })).ok).toBe(true);
    expect(plane.createSession(baseSessionBody({ prompt: "second" })).ok).toBe(true);
    let queuedReads = 0;
    let backfills = 0;
    setDurableReadStorage(plane.state, {
      backfillQueuedSessionQueueOrder: async () => {
        backfills += 1;
      },
      listSessionsByStatus: async (status: string, shard: number) => {
        if (status === "queued") queuedReads += 1;
        return [...plane.state.sessions.values()].filter(
          (session) => session.status === status && session.queueShard === shard,
        );
      },
    });

    await requestAssignment(plane.state);

    expect(queuedReads).toBe(2);
    expect(backfills).toBe(1);
  });

  it("handles scheduled queue entries and isolates a per-session failure", async () => {
    const plane = new ControlPlane({ now: () => NOW, shardCount: 1 });
    seedBaseCommand(plane);
    expect(plane.createSession(baseSessionBody({ prompt: "prompt" })).ok).toBe(true);
    expect(plane.createSession(baseSessionBody({ prompt: "scheduled" })).ok).toBe(true);
    const scheduled = [...plane.state.sessions.values()][1]!;
    scheduled.type = "scheduled";
    scheduled.source = "schedule";
    scheduled.principalId = "system";
    setDurableReadStorage(plane.state, {
      listWorktreesForRepo: async () => {
        throw new Error("assignment read failed");
      },
    });

    await expect(requestAssignment(plane.state)).resolves.toBeUndefined();
    expect(plane.state.sessions.get(scheduled.id)?.status).toBe("queued");
  });
});
