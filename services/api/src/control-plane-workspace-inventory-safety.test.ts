import { describe, expect, it } from "vitest";

import { syncHostWorkspaceSlots } from "./control-plane-agent-hosts.ts";
import { ControlPlane } from "./control-plane.ts";

function attachment(id = "slot", path = "/work/slot", workspacePoolId = "pool-a") {
  return [{ workspacePoolId, slots: [{ id, name: id, path }] }];
}

describe("workspace inventory safety", () => {
  it("rejects pool changes and same-path identity replacement while a slot is leased", () => {
    const plane = new ControlPlane();
    for (const id of ["pool-a", "pool-b"]) {
      expect(plane.createWorkspacePool({ id, name: id }).ok).toBe(true);
    }
    plane.state.hostInventories.set("host", {
      hostId: "host",
      version: 1,
      updatedAt: "now",
      repositories: [],
      providerAccounts: [],
      workspacePools: attachment(),
    });
    plane.state.workspaceSlots.set("slot", {
      id: "slot",
      name: "slot",
      path: "/work/slot",
      hostId: "host",
      workspacePoolId: "pool-a",
      status: "busy",
      online: true,
      currentSessionId: "session",
    });

    expect(
      plane.putHostInventory("host", {
        version: 1,
        repositories: [],
        workspacePools: attachment("slot", "/work/slot", "pool-b"),
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("path or pool") });
    expect(
      plane.putHostInventory("host", {
        version: 1,
        repositories: [],
        workspacePools: attachment("replacement"),
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("replace the id") });
  });

  it("keeps new and edited slots offline until the daemon advertises the exact slot", () => {
    const plane = new ControlPlane();
    expect(plane.createWorkspacePool({ id: "pool-a", name: "pool-a" }).ok).toBe(true);
    plane.state.hostConnection.set("host", "connection");

    const created = plane.putHostInventory("host", {
      repositories: [],
      workspacePools: attachment(),
    });
    if (!created.ok) throw new Error(created.error);
    expect(plane.state.workspaceSlots.get("slot")).toMatchObject({ online: false });

    syncHostWorkspaceSlots(plane.state, created.config, attachment());
    expect(plane.state.workspaceSlots.get("slot")).toMatchObject({
      online: true,
      connectionId: "connection",
    });

    const edited = plane.putHostInventory("host", {
      version: created.config.version,
      repositories: [],
      workspacePools: attachment("slot", "/work/new-path"),
    });
    if (!edited.ok) throw new Error(edited.error);
    expect(plane.state.workspaceSlots.get("slot")).toMatchObject({ online: false });

    syncHostWorkspaceSlots(plane.state, edited.config, attachment());
    expect(plane.state.workspaceSlots.get("slot")).toMatchObject({ online: false });
    syncHostWorkspaceSlots(plane.state, edited.config, attachment("slot", "/work/new-path"));
    expect(plane.state.workspaceSlots.get("slot")).toMatchObject({ online: true });
  });
});
