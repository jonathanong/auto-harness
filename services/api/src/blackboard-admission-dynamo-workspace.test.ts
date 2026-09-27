import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ControlPlane } from "./control-plane.ts";
import { createControlPlane } from "./create-plane.ts";
import { createBlackboardReporting, type BlackboardReporting } from "./blackboard-reporting.ts";
import { assignQueuedDurable } from "./control-plane-assign.ts";
import { assignWorkspaceQueuedDurable } from "./control-plane-workspace-assign.ts";
import { blackboardServer } from "../test-helpers/blackboard-server.ts";
import {
  createDynamoTestCtx,
  putActiveTestRepository,
} from "../test-helpers/dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx(`Bbr${randomUUID().slice(0, 6)}`);
const NOW = "2026-09-27T20:00:00.000Z";
function reporting(url: string, deferred = false) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let probes = 0;
  const controller = createBlackboardReporting(
    {
      schemaVersion: 1,
      version: 1,
      url,
      token: "test-only-writer",
      policies: [
        { repositoryId: "repo", repository: "owner/repo", principalIds: ["system"] },
        { workspacePoolId: "pool", repository: "owner/workspace", principalIds: ["system"] },
      ],
    },
    {
      dependencies: {
        loadClient: async () => {
          probes += 1;
          entered.resolve();
          if (deferred) await release.promise;
          return import("agent-blackboard");
        },
      },
    },
  );
  return {
    controller,
    entered: entered.promise,
    release: () => release.resolve(),
    probes: () => probes,
  };
}
async function createTestPlane(controller: BlackboardReporting, workspace = false) {
  if (!ctx.storage) throw new Error("task-isolated DynamoDB Local is required");
  await putActiveTestRepository(ctx.storage, "repo");
  const { plane } = await createControlPlane({
    tablePrefix: ctx.prefix,
    skipEnsureTables: true,
    blackboardReporting: controller,
    now: () => NOW,
    shardCount: 1,
    connectionIdFactory: () => "connection",
  });
  plane.setOnAssignmentRequested(async () => undefined);
  expect(
    plane.createCommand({
      id: "command",
      name: "command",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
    }).ok,
  ).toBe(true);
  if (workspace) expect(plane.createWorkspacePool({ id: "pool", name: "general" }).ok).toBe(true);
  await plane.settleStorage();
  const registered = await plane.registerHostDurable({
    hostId: "host",
    worktrees: workspace
      ? []
      : [{ id: "worktree", name: "one", repositoryId: "repo", path: "/repo", labels: [] }],
    repositories: workspace ? [] : [{ id: "repo", path: "/repo", defaultBranch: "main" }],
    capabilities: workspace ? ["workspace-sessions"] : [],
    ...(workspace
      ? {
          workspacePools: [
            { workspacePoolId: "pool", slots: [{ id: "slot", name: "one", path: "/workspace" }] },
          ],
        }
      : {}),
  });
  expect(registered.ok).toBe(true);
  return plane;
}
async function queued(plane: ControlPlane, workspace = false) {
  const created = await plane.createSessionDurable(
    {
      repositoryId: workspace ? null : "repo",
      ...(workspace ? { workspacePoolId: "pool", type: "workspace" } : {}),
      prompt: "Inspect the task",
      target: { commandId: "command" },
      timeout: 60,
      queueTtlSeconds: 300,
    },
    { principalId: "system" },
  );
  if (!created.ok) throw new Error(created.error);
  return created.session.id;
}

describe("production Blackboard workspace and admission budget", () => {
  beforeEach(async () => {
    expect(ctx.available).toBe(true);
    await ctx.storage!.clearAll();
  });
  it("blocks workspace assignment without readback and without durable terminal storage", async () => {
    const server = await blackboardServer();
    const gate = reporting(server.url);
    try {
      const run = await createTestPlane(gate.controller, true);
      const id = await queued(run, true);
      server.state.hideReadback = true;
      expect(await assignWorkspaceQueuedDurable(run.state)).toEqual([]);
      expect(await ctx.storage!.getSession(id)).toMatchObject({
        status: "queued",
        reportingAdmissionBlocked: true,
      });
      expect((await ctx.storage!.getWorkspaceSlot("slot"))?.status).toBe("idle");
      server.state.hideReadback = false;
      const simulation = new ControlPlane({
        blackboardReporting: gate.controller,
        now: () => NOW,
        shardCount: 1,
      });
      simulation.state.sessions = run.state.sessions;
      simulation.state.connections = run.state.connections;
      simulation.state.hostConnection = run.state.hostConnection;
      simulation.state.commands = run.state.commands;
      simulation.state.workspacePools = run.state.workspacePools;
      simulation.state.workspaceSlots = run.state.workspaceSlots;
      const before = gate.probes();
      expect(await assignWorkspaceQueuedDurable(simulation.state)).toEqual([]);
      expect(gate.probes()).toBe(before);
      expect(await assignWorkspaceQueuedDurable(run.state)).toHaveLength(1);
      expect(await ctx.storage!.getSession(id)).toMatchObject({ status: "running" });
    } finally {
      await server.close();
    }
  });
  it("spends the bounded sweep on one stalled admission rather than probing every queued task", async () => {
    const server = await blackboardServer();
    const gate = reporting(server.url, true);
    try {
      const run = await createTestPlane(gate.controller);
      const ids = await Promise.all([queued(run), queued(run), queued(run)]);
      expect(await assignQueuedDurable(run.state)).toEqual([]);
      expect(gate.probes()).toBe(1);
      for (const id of ids)
        expect(await ctx.storage!.getSession(id)).toMatchObject({ status: "queued" });
      expect(server.entries.size).toBe(0);
    } finally {
      gate.release();
      await server.close();
    }
  });
});
