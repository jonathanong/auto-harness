import { expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { seedBaseCommand } from "../test-helpers/control-plane-test-helpers.ts";

function workspacePlane(idFactory: () => string) {
  const plane = new ControlPlane({ idFactory });
  seedBaseCommand(plane);
  expect(
    plane.createWorkspacePool({
      id: "pool-1",
      name: "isolated",
      setupProfiles: [{ id: "setup", name: "Setup", script: "pnpm install" }],
      defaultSetupProfileId: "setup",
    }).ok,
  ).toBe(true);
  return plane;
}

function createWorkspaceSource(plane: ControlPlane) {
  const result = plane.createSession({
    repositoryId: null,
    workspacePoolId: "pool-1",
    setupProfileId: "setup",
    prompt: "inspect workspace",
    target: { commandId: "cmd-base" },
    queueTtlSeconds: 60,
    timeout: 30,
    priority: 0,
    type: "workspace",
    source: "api",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.session;
}

it("freezes a workspace source setup script in its clone", () => {
  let id = 0;
  const plane = workspacePlane(() => `workspace-${++id}`);
  const source = createWorkspaceSource(plane);

  plane.state.workspacePools.get("pool-1")!.setupProfiles = [];
  const result = plane.cloneSession(source.id);
  expect(result).toMatchObject({ ok: true, created: true });
  expect(plane.state.sessions.get("workspace-2")).toMatchObject({
    setupProfileId: "setup",
    workspaceSetupScript: "pnpm install",
  });
});

it("rejects a legacy workspace clone when its selected profile was removed", () => {
  const plane = workspacePlane(() => "workspace");
  const source = createWorkspaceSource(plane);
  delete plane.state.sessions.get(source.id)!.workspaceSetupScript;
  plane.state.workspacePools.get("pool-1")!.setupProfiles = [];

  expect(plane.cloneSession(source.id)).toEqual({
    ok: false,
    error: "workspace setup profile not found",
    code: "NOT_FOUND",
  });
});
