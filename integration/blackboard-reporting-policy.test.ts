import { beforeEach, expect, it } from "vitest";
import { createDynamoTestCtx } from "../services/api/test-helpers/dynamo-test-helpers.ts";
import { blackboardServer } from "../services/api/test-helpers/blackboard-server.ts";
import { ControlPlane } from "../services/api/src/control-plane.ts";
import { createBlackboardReporting } from "../services/api/src/blackboard-reporting.ts";
import { triggerScheduleDurable } from "../services/api/src/control-plane-schedule-fire.ts";
import { createSessionChildDurable } from "../services/api/src/control-plane-session-children.ts";
import { seed, NOW } from "../test-helpers/blackboard-reporting-roundtrip.ts";
const ctx = createDynamoTestCtx("BbPolicy");
beforeEach(async () => {
  await ctx.storage!.clearAll();
});
it("captures workspace schedule and final authenticated child owner policy; missing policy cannot admit", async () => {
  const storage = ctx.storage!;
  const server = await blackboardServer();
  try {
    const reporting = createBlackboardReporting({
      schemaVersion: 1,
      version: 2,
      url: server.url,
      token: "test-writer-credential",
      policies: [
        { workspacePoolId: "pool", repository: "owner/workspaces", principalIds: ["operator"] },
        { repositoryId: "repo", repository: "owner/child", principalIds: ["operator"] },
      ],
    });
    const plane = new ControlPlane({
      storage,
      blackboardReporting: reporting,
      shardCount: 1,
      now: () => NOW,
      idFactory: () => "workspace",
    });
    await seed(plane, storage);
    expect(
      await plane.createWorkspacePoolDurable({
        id: "pool",
        name: "workspace",
        setupProfiles: [],
      }),
    ).toMatchObject({ ok: true });
    expect(
      await plane.putScheduleDurable({
        id: "workspace-nightly",
        name: "inspection",
        repositoryId: null,
        workspacePoolId: "pool",
        principalId: "operator",
        target: { commandId: "command" },
        cron: "* * * * *",
        timeout: 30,
      }),
    ).toMatchObject({ ok: true });
    expect(await triggerScheduleDurable(plane.state, "workspace-nightly")).toMatchObject({
      ok: true,
    });
    const workspace = (await storage.getSession("workspace", true))!;
    expect(workspace).toMatchObject({
      workspacePoolId: "pool",
      reportingRepository: "owner/workspaces",
      reportingPolicyVersion: 2,
    });
    expect(await reporting.authorizeAssignment(workspace, "attempt")).toBe(true);
    expect(
      await reporting.authorizeAssignment(
        { ...workspace, reportingRepository: undefined },
        "attempt",
      ),
    ).toBe(false);
    const parent = {
      ...workspace,
      id: "parent",
      repositoryId: "repo",
      status: "completed" as const,
      principalId: "unconfigured",
    };
    delete parent.workspacePoolId;
    await storage.putSession(parent);
    plane.state.idFactory = () => "child";
    expect(
      await createSessionChildDurable(
        plane.state,
        "parent",
        { prompt: "inspect", spawnKey: "child" },
        { principalId: "operator" },
      ),
    ).toMatchObject({ ok: true });
    expect(await storage.getSession("child", true)).toMatchObject({
      principalId: "operator",
      reportingRepository: "owner/child",
      reportingPolicyVersion: 2,
      parentSessionId: "parent",
    });
  } finally {
    await server.close();
  }
});
