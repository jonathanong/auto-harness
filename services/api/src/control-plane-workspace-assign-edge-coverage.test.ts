import { describe, expect, it, vi } from "vitest";

import { assignWorkspaceQueuedDurable } from "./control-plane-workspace-assign.ts";
import { createWorkspaceSession, workspacePlane } from "./test-helpers/workspace-session.ts";

describe("workspace assignment edge coverage", () => {
  it("filters by session id, expires stale capacity, and rejects oversized frames", async () => {
    const selected = workspacePlane();
    const first = createWorkspaceSession(selected.plane);
    const second = createWorkspaceSession(selected.plane);
    await expect(
      assignWorkspaceQueuedDurable(selected.plane.state, second.id),
    ).resolves.toHaveLength(1);
    expect(selected.plane.getSession(first.id)).toMatchObject({ status: "queued" });
    expect(selected.plane.getSession(second.id)).toMatchObject({ status: "running" });

    const expired = workspacePlane();
    const expiredSession = createWorkspaceSession(expired.plane);
    expired.plane.state.sessions.get(expiredSession.id)!.queueExpiresAt =
      "2026-09-11T23:59:59.000Z";
    await expect(assignWorkspaceQueuedDurable(expired.plane.state)).resolves.toEqual([]);
    expect(expired.plane.getSession(expiredSession.id)).toMatchObject({
      status: "failed",
      errorCode: "queue_expired",
    });

    const oversized = workspacePlane();
    const oversizedSession = createWorkspaceSession(oversized.plane);
    oversized.plane.state.sessions.get(oversizedSession.id)!.workspaceSetupScript = "x".repeat(
      130_000,
    );
    await expect(assignWorkspaceQueuedDurable(oversized.plane.state)).resolves.toEqual([]);
    expect(oversized.plane.getSession(oversizedSession.id)).toMatchObject({ status: "queued" });

    const durableExpired = workspacePlane();
    const durableSession = createWorkspaceSession(durableExpired.plane);
    durableExpired.plane.state.sessions.get(durableSession.id)!.queueExpiresAt =
      "2026-09-11T23:59:59.000Z";
    durableExpired.plane.state.storage = {
      listWorkspaceSlots: async () => [],
      listWorkspaceSlotsByPool: async () => [],
      expireQueuedSession: async () => false,
    } as never;
    await expect(
      assignWorkspaceQueuedDurable(durableExpired.plane.state, undefined, {
        readModelLoaded: true,
      }),
    ).resolves.toEqual([]);
    expect(durableExpired.plane.getSession(durableSession.id)).toMatchObject({ status: "queued" });
  });

  it("refreshes the durable scheduler read model before selecting workspace capacity", async () => {
    const { plane } = workspacePlane();
    const reads = vi.fn();
    plane.state.storage = {
      listConnections: async () => (reads(), []),
      listCommands: async () => [],
      listProviders: async () => [],
      listProviderAccounts: async () => [],
      listHostInventories: async () => [],
      listRepositories: async () => [],
      listWorkspacePools: async () => [],
      listWorkspaceSlots: async () => [],
      listWorkspaceSlotsByPool: async () => [],
      listSessionsByStatus: async () => [],
      listAllSessions: async () => [],
    } as never;
    await expect(assignWorkspaceQueuedDurable(plane.state)).resolves.toEqual([]);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(plane.state.workspaceSlots.size).toBe(0);
  });

  it("leaves a provider-account route queued when the host reports it is not ready", async () => {
    const { plane } = workspacePlane();
    expect(plane.createProvider({ id: "provider", name: "provider" }).ok).toBe(true);
    expect(
      plane.createCommand({
        id: "provider-command",
        name: "provider-command",
        argv: ["provider"],
        appendPrompt: true,
        providerId: "provider",
      }).ok,
    ).toBe(true);
    expect(
      plane.createProviderAccount({ id: "account", providerId: "provider", label: "one" }).ok,
    ).toBe(true);
    plane.updateProvider("provider", { defaultCommandId: "provider-command" });
    const inventory = plane.getHostInventory("host-1");
    if (!inventory) throw new Error("workspace inventory missing");
    expect(
      plane.putHostInventory("host-1", {
        ...inventory,
        providerAccounts: [{ providerAccountId: "account" }],
      }).ok,
    ).toBe(true);
    plane.state.connections.get("connection-1")!.providerAccountReadiness = [
      { providerAccountId: "account", ready: false, fingerprint: "a".repeat(64) },
    ];
    const session = plane.createSession({
      repositoryId: null,
      workspacePoolId: "pool-1",
      prompt: "use provider",
      target: { providerId: "provider" },
      timeout: 60,
      type: "workspace",
      source: "api",
    });
    if (!session.ok) throw new Error(session.error);
    await expect(assignWorkspaceQueuedDurable(plane.state)).resolves.toEqual([]);
    expect(plane.getSession(session.session.id)).toMatchObject({ status: "queued" });
  });
});
