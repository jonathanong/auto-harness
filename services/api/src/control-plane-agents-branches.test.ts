/* eslint-disable max-lines */
import { describe, expect, it } from "vitest";

import { drainHostDurable } from "./control-plane-agents.ts";
import { ControlPlane } from "./control-plane.ts";

const inventory = [{ id: "w", name: "w", repositoryId: "r", path: "/w", labels: [] }];

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: "s",
    repositoryId: "r",
    prompt: "p",
    targetLabel: "t",
    timeout: 1,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue" as const,
    status: "running" as const,
    queueShard: 0,
    createdAt: "t",
    hostId: "h",
    worktreeId: "w",
    ackReceivedAt: "t",
    ...overrides,
  };
}

function worktree(overrides: Record<string, unknown> = {}) {
  return {
    id: "w",
    name: "w",
    hostId: "h",
    repositoryId: "r",
    path: "/w",
    labels: [],
    status: "busy" as const,
    online: true,
    currentSessionId: "s",
    ...overrides,
  };
}

describe("agent registration branch boundaries", () => {
  it("rejects every durable running-session ownership mismatch", async () => {
    const cases = [
      [session({ status: "queued" }), worktree()],
      [session({ hostId: "other" }), worktree()],
      [session({ worktreeId: null }), null],
      [session({ ackReceivedAt: undefined }), worktree()],
      [session(), null],
      [session(), worktree({ hostId: "other" })],
      [session(), worktree({ currentSessionId: "other" })],
    ] as const;
    for (const [record, wt] of cases) {
      const plane = new ControlPlane();
      plane.state.storage = {
        getSession: async () => record,
        getWorktree: async () => wt,
      } as never;
      expect(
        await plane.registerHostDurable({
          hostId: "h",
          worktrees: inventory,
          commandProfiles: [],
          runningSessions: ["s"],
        }),
      ).toEqual({ ok: false, error: "running session s is not owned by host h" });
    }
    const duplicate = new ControlPlane();
    duplicate.state.storage = {
      getSession: async () => session({ ackReceivedAt: "t" }),
      getWorktree: async () => worktree(),
    } as never;
    expect(
      await duplicate.registerHostDurable({
        hostId: "h",
        worktrees: inventory,
        commandProfiles: [],
        runningSessions: ["s", "s"],
      }),
    ).toEqual({ ok: false, error: "duplicate running session s" });
  });

  it("rejects replacement registration before an assignment acknowledgement can be replayed", async () => {
    const plane = new ControlPlane();
    let leases = 0;
    plane.state.storage = {
      getSession: async () => session({ ackReceivedAt: undefined }),
      getWorktree: async () => worktree(),
      tryRegisterHost: async () => (leases++, true),
    } as never;
    expect(
      await plane.registerHostDurable({
        hostId: "h",
        worktrees: inventory,
        commandProfiles: [],
        runningSessions: ["s"],
        replaceExisting: true,
      }),
    ).toEqual({ ok: false, error: "running session s is not owned by host h" });
    expect(leases).toBe(0);
  });

  it("preserves prior inventory fields, replaces an old local connection, and drains only idle worktrees", async () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "new" });
    plane.state.hostConnection.set("h", "old");
    plane.state.connections.set("old", {
      connectionId: "old",
      type: "host",
      hostId: "h",
      connectedAt: "t",
      lastHeartbeatAt: "t",
      commandProfiles: [],
    });
    plane.state.worktrees.set("w", {
      ...worktree({ status: "idle", currentSessionId: "legacy", lastAssignedAt: "then" }),
    });
    plane.state.worktrees.set("extra", {
      ...worktree({ id: "extra", name: "extra", status: "idle", currentSessionId: null }),
    });
    expect(
      plane.registerHost({
        hostId: "h",
        worktrees: inventory,
        commandProfiles: [],
        replaceExisting: true,
      }),
    ).toEqual({ ok: true, connectionId: "new" });
    expect(plane.state.connections.has("old")).toBe(false);
    expect(plane.getWorktree("w")).toEqual(
      expect.objectContaining({ currentSessionId: "legacy", lastAssignedAt: "then" }),
    );
    expect(plane.getWorktree("extra")).toEqual(
      expect.objectContaining({ online: true, connectionId: "new" }),
    );

    const drain = new ControlPlane();
    drain.state.worktrees.set("idle", {
      ...worktree({ id: "idle", status: "idle", currentSessionId: null }),
    });
    drain.state.worktrees.set("busy", worktree({ id: "busy" }));
    const online: string[] = [];
    drain.state.storage = {
      getHostLock: async () => "drain-owner",
      markHostDraining: async () => true,
      setWorktreeOnlineFenced: async (id: string) => (online.push(id), true),
    } as never;
    expect(await drainHostDurable(drain.state, "h")).toEqual({ ok: true, runningSessionIds: [] });
    expect(online).toEqual(["idle"]);
  });

  it("keeps a reconnecting drain excluded until a fresh registration clears it", () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "draining" });
    expect(
      plane.registerHost({
        hostId: "h",
        worktrees: inventory,
        commandProfiles: [],
        draining: true,
      }),
    ).toEqual({ ok: true, connectionId: "draining" });
    expect(plane.isDraining("h")).toBe(true);
    expect(plane.getWorktree("w")).toMatchObject({ online: false });
    expect(
      plane.registerHost({
        hostId: "h",
        worktrees: inventory,
        commandProfiles: [],
        replaceExisting: true,
      }),
    ).toEqual({ ok: true, connectionId: "draining" });
    expect(plane.isDraining("h")).toBe(false);
    expect(plane.getWorktree("w")).toMatchObject({ online: true });
  });

  it("does not locally drain when a durable worktree fence loses its owner", async () => {
    const plane = new ControlPlane();
    plane.state.worktrees.set("w", {
      ...worktree({ status: "idle", currentSessionId: null }),
    });
    plane.state.storage = {
      getHostLock: async () => "owner",
      markHostDraining: async () => true,
      setWorktreeOnlineFenced: async () => false,
    } as never;
    expect(await drainHostDurable(plane.state, "h")).toEqual({ ok: false, runningSessionIds: [] });
    expect(plane.isDraining("h")).toBe(false);
    expect(plane.getWorktree("w")).toMatchObject({ online: true });
  });

  it("publishes omitted durable idle inventory even when the process cache is stale", async () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "c" });
    const writes: string[] = [];
    plane.state.storage = {
      tryRegisterHost: async () => true,
      getSession: async () => null,
      listWorktreesByHost: async () => [
        { ...worktree({ id: "idle", name: "idle", status: "idle", currentSessionId: null }) },
        { ...worktree({ id: "busy", name: "busy" }) },
      ],
      putWorktreeFenced: async (row: { id: string; connectionId: string }) => (
        writes.push(`${row.id}:${row.connectionId}`), true
      ),
      putHostInventory: async () => {},
    } as never;
    expect(
      await plane.registerHostDurable({
        hostId: "h",
        worktrees: [],
        commandProfiles: [],
        replaceExisting: true,
      }),
    ).toEqual({ ok: true, connectionId: "c" });
    expect(writes).toEqual(["idle:c"]);
    expect(plane.getWorktree("idle")).toEqual(
      expect.objectContaining({ online: true, connectionId: "c" }),
    );
    expect(plane.getWorktree("busy")).toBeNull();
  });
});
