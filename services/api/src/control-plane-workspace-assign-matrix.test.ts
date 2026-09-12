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
});
