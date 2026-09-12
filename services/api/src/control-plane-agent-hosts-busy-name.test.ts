import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("busy workspace slot inventory edits", () => {
  it("rejects a name-only edit and preserves the current slot", () => {
    const plane = new ControlPlane();
    expect(plane.createWorkspacePool({ id: "pool", name: "pool" }).ok).toBe(true);
    plane.state.workspaceSlots.set("slot", {
      id: "slot",
      name: "original",
      hostId: "host",
      workspacePoolId: "pool",
      path: "/work/slot",
      status: "busy",
      online: true,
      currentSessionId: "session",
    });

    expect(
      plane.putHostInventory("host", {
        repositories: [],
        workspacePools: [
          {
            workspacePoolId: "pool",
            slots: [{ id: "slot", name: "renamed", path: "/work/slot" }],
          },
        ],
      }),
    ).toEqual({
      ok: false,
      error: "cannot change the name, path, or pool of busy workspace slot: slot",
    });
    expect(plane.state.workspaceSlots.get("slot")).toMatchObject({
      name: "original",
      currentSessionId: "session",
    });
  });
});
