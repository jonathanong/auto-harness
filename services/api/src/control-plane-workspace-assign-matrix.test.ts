import { describe, expect, it } from "vitest";

import { assignWorkspaceQueuedDurable } from "./control-plane-workspace-assign.ts";
import { createWorkspaceSession, workspacePlane } from "./test-helpers/workspace-session.ts";

describe("workspace assignment matrix", () => {
  it("leaves queued sessions unassigned when no eligible slot is available", async () => {
    const cases = [
      (plane: ReturnType<typeof workspacePlane>["plane"]) => plane.state.workspaceSlots.clear(),
      (plane: ReturnType<typeof workspacePlane>["plane"]) => {
        plane.state.connections.get("connection-1")!.capabilities = [];
      },
      (plane: ReturnType<typeof workspacePlane>["plane"]) => {
        plane.state.workspaceSlots.get("slot-1")!.online = false;
      },
      (plane: ReturnType<typeof workspacePlane>["plane"]) => {
        plane.state.workspaceSlots.get("slot-1")!.status = "busy";
      },
    ];
    for (const configure of cases) {
      const { plane } = workspacePlane();
      const session = createWorkspaceSession(plane);
      configure(plane);

      await expect(assignWorkspaceQueuedDurable(plane.state)).resolves.toEqual([]);
      expect(plane.getSession(session.id)).toMatchObject({
        status: "queued",
      });
    }
  });

  it("uses the least-recently-assigned slot and omits a missing profile script", async () => {
    const { plane, messages } = workspacePlane();
    const session = createWorkspaceSession(plane);
    session.setupProfileId = "removed-profile";
    plane.state.sessions.set(session.id, session);
    plane.state.workspaceSlots.set("slot-2", {
      ...plane.state.workspaceSlots.get("slot-1")!,
      id: "slot-2",
      name: "two",
      path: "/srv/workspaces/two",
      lastAssignedAt: "2020-01-01T00:00:00.000Z",
    });
    plane.state.workspaceSlots.get("slot-1")!.lastAssignedAt = "2026-09-11T00:00:00.000Z";

    await expect(assignWorkspaceQueuedDurable(plane.state)).resolves.toHaveLength(1);
    expect(plane.getSession(session.id)).toMatchObject({ workspaceSlotId: "slot-2" });
    expect(messages.at(-1)).toMatchObject({
      workspaceSlotId: "slot-2",
      setupProfileId: "removed-profile",
    });
    expect(messages.at(-1)).not.toHaveProperty("setupScript");
  });

  it("uses local slots when optional storage listing is unavailable and retains queue state on durable loss", async () => {
    const fallback = workspacePlane();
    const fallbackSession = createWorkspaceSession(fallback.plane);
    fallback.plane.state.storage = {
      tryAssignWorkspaceSession: async () => false,
    } as never;
    await expect(
      assignWorkspaceQueuedDurable(fallback.plane.state, undefined, { readModelLoaded: true }),
    ).resolves.toEqual([]);
    expect(fallback.plane.getSession(fallbackSession.id)).toMatchObject({ status: "queued" });

    const failing = workspacePlane();
    const failingSession = createWorkspaceSession(failing.plane);
    failing.plane.state.storage = {
      listWorkspaceSlots: async () => [],
      listWorkspaceSlotsByPool: async () => [failing.plane.state.workspaceSlots.get("slot-1")!],
      tryAssignWorkspaceSession: async () => {
        throw new Error("assignment unavailable");
      },
    } as never;
    await expect(
      assignWorkspaceQueuedDurable(failing.plane.state, undefined, { readModelLoaded: true }),
    ).rejects.toThrow("assignment unavailable");
    expect(failing.plane.getSession(failingSession.id)).toMatchObject({ status: "queued" });
  });

  it("uses durable claims and expires queued sessions through storage", async () => {
    const assigned = workspacePlane();
    const session = createWorkspaceSession(assigned.plane);
    assigned.plane.state.storage = { tryAssignWorkspaceSession: async () => true } as never;
    await expect(
      assignWorkspaceQueuedDurable(assigned.plane.state, undefined, { readModelLoaded: true }),
    ).resolves.toHaveLength(1);
    expect(assigned.plane.getSession(session.id)).toMatchObject({
      status: "running",
      workspaceSlotId: "slot-1",
    });

    const expired = workspacePlane();
    const expiredSession = createWorkspaceSession(expired.plane);
    expired.plane.state.sessions.get(expiredSession.id)!.queueExpiresAt =
      "2026-09-11T23:59:59.000Z";
    expired.plane.state.storage = {
      expireQueuedSession: async () => true,
    } as never;
    await expect(
      assignWorkspaceQueuedDurable(expired.plane.state, undefined, { readModelLoaded: true }),
    ).resolves.toEqual([]);
    expect(expired.plane.getSession(expiredSession.id)).toMatchObject({
      status: "failed",
      errorCode: "queue_expired",
    });
  });

  it("dispatches provider-account workspace routes and updates account recency", async () => {
    const { plane, messages } = workspacePlane();
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
      { providerAccountId: "account", ready: true, fingerprint: "a".repeat(64) },
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
    await expect(assignWorkspaceQueuedDurable(plane.state)).resolves.toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({
      providerAccountId: "account",
      commandId: "provider-command",
    });
    expect(plane.state.providerAccounts.get("account")).toMatchObject({
      lastAssignedAt: "2026-09-12T00:00:00.000Z",
    });
  });

  it("uses a command that does not append the prompt and skips unavailable connections", async () => {
    const { plane, messages } = workspacePlane();
    expect(
      plane.createCommand({
        id: "no-prompt",
        name: "no-prompt",
        argv: ["tool", "--fixed"],
        appendPrompt: false,
        providerId: null,
      }).ok,
    ).toBe(true);
    const created = plane.createSession({
      repositoryId: null,
      workspacePoolId: "pool-1",
      prompt: "must not be sent twice",
      target: { commandId: "no-prompt" },
      timeout: 60,
      type: "workspace",
      source: "api",
    });
    if (!created.ok) throw new Error(created.error);
    plane.state.hostConnection.delete("host-1");
    await expect(assignWorkspaceQueuedDurable(plane.state)).resolves.toEqual([]);
    expect(plane.getSession(created.session.id)).toMatchObject({ status: "queued" });

    plane.state.hostConnection.set("host-1", "connection-1");
    const assigned = await assignWorkspaceQueuedDurable(plane.state);
    expect(assigned).toHaveLength(1);
    expect(messages.at(-1)).toMatchObject({
      resolvedArgv: ["tool", "--fixed"],
      prompt: "",
    });
  });
});
