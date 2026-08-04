import { describe, expect, it } from "vitest";

import { createControlPlane } from "../create-plane.ts";
import { createDynamoTestCtx } from "./dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("Pln");

describe("DynamoDB Local control plane hydrate", () => {
  it("createControlPlane hydrates from DynamoDB", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }

    const { plane, storage: st2 } = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
      publicBaseUrl: "http://ui",
      idFactory: () => "sess-plane",
      now: () => "2026-01-02T00:00:00.000Z",
    });
    plane.seedWorktree({
      id: "wt-p",
      name: "wt-p",
      agentId: "ap",
      repositoryId: "r1",
      path: "/p",
      labels: [],
      status: "idle",
      online: true,
    });
    const reg = plane.registerAgent({
      agentId: "ap",
      worktrees: [{ id: "wt-p", name: "wt-p", repositoryId: "r1", path: "/p", labels: [] }],
      commandProfiles: ["echo-prompt"],
      replaceExisting: true,
    });
    expect(reg.ok).toBe(true);
    const created = plane.createSession({
      repositoryId: "r1",
      prompt: "from plane",
      commandProfile: "c",
      timeout: 5,
    });
    expect(created.ok).toBe(true);
    plane.archiveSessionLogs("sess-plane");
    await plane.settleStorage();
    const again = await createControlPlane({
      tablePrefix: ctx.prefix,
      skipEnsureTables: true,
    });
    expect(again.plane.getSession("sess-plane")?.prompt).toBe("from plane");
    expect(again.plane.listWorktrees().some((w) => w.id === "wt-p")).toBe(true);
    expect(again.plane.listAgents().some((a) => a.agentId === "ap")).toBe(true);
    expect(again.plane.getArchive("sess-plane")).toBeTruthy();
    await st2.clearAll();
  });
});
