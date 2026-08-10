import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { disconnectHostDurable, heartbeatDurable } from "./control-plane-agents.ts";

const inventory = [{ id: "w", name: "w", repositoryId: "r", path: "/w", labels: [] }];

describe("durable host registration", () => {
  it("publishes fenced inventory only after the lease transaction succeeds", async () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "c", now: () => "now" });
    const calls: string[] = [];
    plane.state.storage = {
      tryRegisterHost: async () => (calls.push("lease"), true),
      getWorktree: async () => null,
      putWorktreeFenced: async (_worktree: { id: string }, fence: { connectionId: string }) => (
        calls.push(`worktree:${fence.connectionId}`), true
      ),
      listWorktreesByHost: async () => [],
    } as never;
    const result = await plane.registerHostDurable({
      hostId: "h",
      worktrees: inventory,
      commandProfiles: ["p"],
      capabilities: ["scheduled-main-checkout"],
      replaceExisting: true,
    });
    expect(result).toEqual({ ok: true, connectionId: "c" });
    expect(calls).toEqual(["lease", "worktree:c"]);
    expect(plane.getWorktree("w")?.connectionId).toBe("c");
    expect(plane.state.connections.get("c")?.capabilities).toEqual(["scheduled-main-checkout"]);
  });

  it("releases a just-acquired lease if fenced inventory loses", async () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "c" });
    const calls: string[] = [];
    plane.state.storage = {
      tryRegisterHost: async () => true,
      getWorktree: async () => null,
      listWorktreesByHost: async () => [],
      putWorktreeFenced: async () => false,
      releaseHostConnection: async (_hostId: string, connectionId: string) => (
        calls.push(connectionId), true
      ),
    } as never;
    await expect(
      plane.registerHostDurable({
        hostId: "h",
        worktrees: inventory,
        commandProfiles: [],
        replaceExisting: true,
      }),
    ).resolves.toEqual({ ok: false, error: "host connection changed while publishing inventory" });
    expect(calls).toEqual(["c"]);
    expect(plane.state.connections.size).toBe(0);
  });

  it("preserves the current cache on duplicate leases and inventory write failures", async () => {
    const duplicate = new ControlPlane({ connectionIdFactory: () => "new" });
    duplicate.state.hostConnection.set("h", "old");
    duplicate.state.storage = {} as never;
    await expect(
      duplicate.registerHostDurable({ hostId: "h", worktrees: inventory, commandProfiles: [] }),
    ).resolves.toEqual({ ok: false, error: "hostId h already has an active connection" });

    const failing = new ControlPlane({ connectionIdFactory: () => "c" });
    const released: string[] = [];
    failing.state.storage = {
      tryRegisterHost: async () => true,
      getWorktree: async () => null,
      listWorktreesByHost: async () => [],
      putWorktreeFenced: async () => {
        throw new Error("write");
      },
      releaseHostConnection: async (_hostId: string, connectionId: string) => (
        released.push(connectionId), true
      ),
    } as never;
    await expect(
      failing.registerHostDurable({
        hostId: "h",
        worktrees: inventory,
        commandProfiles: [],
        replaceExisting: true,
      }),
    ).rejects.toThrow("write");
    expect(released).toEqual(["c"]);
  });

  it("keeps durable heartbeat and disconnect changes fenced to the current lease", async () => {
    const plane = new ControlPlane({ now: () => "now" });
    plane.state.hostConnection.set("h", "c");
    plane.state.connections.set("c", {
      connectionId: "c",
      type: "host",
      hostId: "h",
      connectedAt: "old",
      lastHeartbeatAt: "old",
      commandProfiles: [],
    });
    const calls: string[] = [];
    plane.state.storage = {
      heartbeatConnection: async (_hostId: string, _connectionId: string, at: string) => (
        calls.push(`beat:${at}`), true
      ),
      getHostLock: async () => "c",
      listWorktreesByHost: async () => [],
      releaseHostConnection: async () => (calls.push("release"), false),
      deleteConnection: async () => (calls.push("delete"), undefined),
    } as never;
    expect(await heartbeatDurable(plane.state, "h")).toBe(true);
    expect(await disconnectHostDurable(plane.state, "c")).toEqual([]);
    expect(plane.state.connections.has("c")).toBe(false);
    plane.state.storage.heartbeatConnection = async () => false;
    expect(await heartbeatDurable(plane.state, "h", "later")).toBe(false);
    expect(calls).toContain("beat:now");
    expect(calls).toContain("delete");
  });

  it("rejects invalid reported runs, losing leases, and skips a durably busy inventory row", async () => {
    const invalid = new ControlPlane();
    invalid.state.storage = { getSession: async () => null } as never;
    await expect(
      invalid.registerHostDurable({
        hostId: "h",
        worktrees: inventory,
        commandProfiles: [],
        runningSessions: ["missing"],
      }),
    ).resolves.toEqual({ ok: false, error: "running session missing is not owned by host h" });

    const lost = new ControlPlane();
    lost.state.storage = { tryRegisterHost: async () => false } as never;
    await expect(
      lost.registerHostDurable({ hostId: "h", worktrees: inventory, commandProfiles: [] }),
    ).resolves.toEqual({ ok: false, error: "hostId h already has an active connection" });

    const busy = new ControlPlane({ connectionIdFactory: () => "c" });
    let writes = 0;
    busy.state.storage = {
      tryRegisterHost: async () => true,
      getWorktree: async () => ({ id: "w", status: "busy" }),
      putWorktreeFenced: async () => (writes++, true),
      listWorktreesByHost: async () => [],
    } as never;
    expect(
      await busy.registerHostDurable({
        hostId: "h",
        worktrees: inventory,
        commandProfiles: [],
        replaceExisting: true,
      }),
    ).toEqual({ ok: true, connectionId: "c" });
    expect(writes).toBe(0);
  });

  it("validates every local reported-running ownership boundary", () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "c" });
    const session = {
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
    };
    const worktree = {
      id: "w",
      name: "w",
      hostId: "h",
      repositoryId: "r",
      path: "/w",
      labels: [],
      status: "busy" as const,
      online: true,
      currentSessionId: "s",
    };
    plane.state.sessions.set("s", session);
    plane.state.worktrees.set("w", worktree);
    const register = (runningSessions: string[]) =>
      plane.registerHost({ hostId: "h", worktrees: [], commandProfiles: [], runningSessions });
    expect(register(["s", "s"])).toEqual({ ok: false, error: "duplicate running session s" });
    plane.state.sessions.set("s", { ...session, ackReceivedAt: undefined });
    expect(register(["s"])).toEqual({
      ok: false,
      error: "running session s is not owned by host h",
    });
    plane.state.sessions.set("s", { ...session, status: "queued" });
    expect(register(["s"]).ok).toBe(false);
    plane.state.sessions.set("s", { ...session, hostId: "other" });
    expect(register(["s"]).ok).toBe(false);
    plane.state.sessions.set("s", { ...session, worktreeId: null });
    expect(register(["s"]).ok).toBe(false);
    plane.state.sessions.set("s", session);
    plane.state.worktrees.delete("w");
    expect(register(["s"]).ok).toBe(false);
    plane.state.worktrees.set("w", { ...worktree, hostId: "other" });
    expect(register(["s"]).ok).toBe(false);
    plane.state.worktrees.set("w", { ...worktree, currentSessionId: "other" });
    expect(register(["s"]).ok).toBe(false);
  });
});
