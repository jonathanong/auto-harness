import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { HostWireMessage } from "@auto-harness/shared";
import { ControlPlane } from "./control-plane.ts";
import { createControlPlane } from "./create-plane.ts";
import { createBlackboardReporting, type BlackboardReporting } from "./blackboard-reporting.ts";
import { assignQueuedDurable } from "./control-plane-assign.ts";
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

describe("production Blackboard assignment races", () => {
  beforeEach(async () => {
    expect(ctx.available).toBe(true);
    await ctx.storage!.clearAll();
  });
  it("cannot assign cancelled work after a delayed fresh online admission", async () => {
    const server = await blackboardServer();
    const gate = reporting(server.url, true);
    try {
      const run = await createTestPlane(gate.controller);
      const id = await queued(run);
      const messages: HostWireMessage[] = [];
      run.setOnHostMessage((_host, message) => messages.push(message));
      const assigning = assignQueuedDurable(run.state);
      await gate.entered;
      expect(messages).toEqual([]);
      expect(await run.cancelSessionDurable(id)).toMatchObject({
        ok: true,
        session: { status: "cancelled" },
      });
      gate.release();
      expect(await assigning).toEqual([]);
      expect(await ctx.storage!.getSession(id)).toMatchObject({ status: "cancelled" });
      expect((await ctx.storage!.getWorktree("worktree"))?.status).toBe("idle");
      expect(server.entries.get(id)).toHaveLength(1);
      expect(messages.filter((message) => message.type === "session:assign")).toEqual([]);
    } finally {
      gate.release();
      await server.close();
    }
  });
  it("cannot overwrite a competing committed assignment after a delayed probe", async () => {
    const server = await blackboardServer();
    const slow = reporting(server.url, true);
    try {
      const first = await createTestPlane(slow.controller);
      const id = await queued(first);
      const messages: HostWireMessage[] = [];
      first.setOnHostMessage((_host, message) => messages.push(message));
      const assigning = assignQueuedDurable(first.state);
      await slow.entered;
      const fast = reporting(server.url);
      const second = await createControlPlane({
        tablePrefix: ctx.prefix,
        skipEnsureTables: true,
        blackboardReporting: fast.controller,
        now: () => NOW,
        shardCount: 1,
        onHostMessage: (_host, message) => messages.push(message),
      });
      const won = await assignQueuedDurable(second.plane.state);
      expect(won).toHaveLength(1);
      slow.release();
      expect(await assigning).toEqual([]);
      expect(await ctx.storage!.getSession(id)).toMatchObject({
        status: "running",
        attemptId: won[0]!.session.attemptId,
      });
      expect(messages.filter((message) => message.type === "session:assign")).toHaveLength(1);
      expect(server.entries.get(id)).toHaveLength(2);
    } finally {
      slow.release();
      await server.close();
    }
  });
});
