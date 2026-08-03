import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createControlPlane } from "../create-plane.js";
import {
  createDynamoClients,
  createDynamoDocumentClient,
  DEFAULT_DYNAMODB_ENDPOINT,
  statusShardAttr,
  tableNames,
} from "./dynamo.js";
import { ensureControlPlaneTables } from "./ensure-tables.js";
import { DynamoPlaneStorage } from "./plane-storage.js";

async function dynamoAvailable(): Promise<boolean> {
  try {
    const { client } = createDynamoClients();
    await client.send(new ListTablesCommand({}));
    return true;
  } catch {
    return false;
  }
}

const prefix = `AhCov${process.pid}`;
let storage: DynamoPlaneStorage | null = null;
let available = false;

beforeAll(async () => {
  available = await dynamoAvailable();
  if (!available) {
    return;
  }
  const { client, doc } = createDynamoClients();
  const names = await ensureControlPlaneTables({ client, prefix });
  storage = new DynamoPlaneStorage(doc, names);
  await storage.clearAll();
});

afterAll(async () => {
  if (storage) {
    await storage.clearAll();
  }
});

describe("DynamoDB Local integration", () => {
  it("exports client helpers and table naming", () => {
    expect(statusShardAttr("queued", 2)).toBe("queued#2");
    expect(tableNames("AH").sessions).toBe("AH-Sessions");
    expect(tableNames("").sessions).toContain("Sessions");
    expect(DEFAULT_DYNAMODB_ENDPOINT).toContain("8000");
    const doc = createDynamoDocumentClient();
    expect(doc).toBeTruthy();
  });

  it("persists sessions, worktrees, claims, locks, logs, schedules, archives", async () => {
    if (!available || !storage) {
      expect(true).toBe(true);
      return;
    }
    const s = storage;

    await s.putSession({
      id: "sess-1",
      repositoryId: "r1",
      prompt: "hi",
      commandProfile: "c",
      timeout: 10,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      ref: "main",
    });
    expect((await s.getSession("sess-1"))?.ref).toBe("main");
    expect(await s.getSession("missing")).toBeNull();
    expect((await s.listAllSessions()).length).toBeGreaterThan(0);
    expect((await s.listSessionsByStatus("queued", 0)).some((x) => x.id === "sess-1")).toBe(true);

    await s.putWorktree({
      id: "wt-1",
      agentId: "a1",
      repositoryId: "r1",
      path: "/w",
      labels: ["echo"],
      status: "idle",
      online: true,
    });
    expect((await s.getWorktree("wt-1"))?.path).toBe("/w");
    expect(await s.getWorktree("nope")).toBeNull();
    expect((await s.listWorktreesForRepo("r1")).length).toBe(1);
    expect((await s.listAllWorktrees()).length).toBeGreaterThan(0);

    expect(await s.tryClaimWorktree({ worktreeId: "wt-1", sessionId: "sess-1", now: "t0" })).toBe(
      true,
    );
    expect(await s.tryClaimWorktree({ worktreeId: "wt-1", sessionId: "sess-2", now: "t1" })).toBe(
      false,
    );
    await s.releaseWorktree("wt-1");
    expect((await s.getWorktree("wt-1"))?.status).toBe("idle");
    await s.releaseWorktree("missing-wt");
    await s.setWorktreeOnline("wt-1", false);
    expect((await s.getWorktree("wt-1"))?.online).toBe(false);
    await s.setWorktreeOnline("wt-1", true);

    expect(
      await s.tryAcquireAgentLock({
        agentId: "ag1",
        connectionId: "c1",
        replaceExisting: false,
      }),
    ).toBe(true);
    expect(
      await s.tryAcquireAgentLock({
        agentId: "ag1",
        connectionId: "c2",
        replaceExisting: false,
      }),
    ).toBe(false);
    expect(await s.getAgentLock("ag1")).toBe("c1");
    await s.releaseAgentLock("ag1", "wrong");
    expect(await s.getAgentLock("ag1")).toBe("c1");
    await s.releaseAgentLock("ag1", "c1");
    expect(await s.getAgentLock("ag1")).toBeNull();
    expect(
      await s.tryAcquireAgentLock({
        agentId: "ag1",
        connectionId: "c3",
        replaceExisting: true,
      }),
    ).toBe(true);

    await s.putConnection({
      connectionId: "c3",
      type: "agent",
      agentId: "ag1",
      connectedAt: "t",
      lastHeartbeatAt: "t",
      commandProfiles: ["echo"],
    });
    expect((await s.getConnection("c3"))?.agentId).toBe("ag1");
    expect((await s.listConnections()).length).toBeGreaterThan(0);
    await s.deleteConnection("c3");
    expect(await s.getConnection("c3")).toBeNull();

    await s.putLog({
      sessionId: "sess-1",
      timestampSeq: "2026-01-01T00:00:00.000Z#0000000001",
      stream: "stdout",
      content: "line",
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 1,
    });
    await s.putLog({
      sessionId: "sess-1",
      timestampSeq: "2026-01-01T00:00:00.000Z#0000000002",
      stream: "stdout",
      content: "line2",
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 2,
    });
    expect((await s.listLogs("sess-1")).map((l) => l.seq)).toEqual([1, 2]);

    await s.putSchedule({
      id: "sch-1",
      repositoryId: "r1",
      name: "job",
      commandProfile: "c",
      cron: "* * * * *",
      enabled: true,
      timeout: 10,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      lastRunAt: null,
      createdAt: "t",
      ref: "main",
    });
    expect((await s.getSchedule("sch-1"))?.name).toBe("job");
    expect(await s.getSchedule("nope")).toBeNull();
    expect((await s.listSchedules()).length).toBeGreaterThan(0);
    await s.putRepository({
      id: "repo-1",
      name: "Repo",
      url: "/tmp/r",
      defaultBranch: "main",
      createdAt: "t",
      updatedAt: "t",
    });
    expect((await s.getRepository("repo-1"))?.name).toBe("Repo");
    expect(await s.getRepository("nope")).toBeNull();
    expect((await s.listRepositories()).length).toBeGreaterThan(0);
    expect(
      await s.tryClaimSchedule(
        "sch-1",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:01:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      await s.tryClaimSchedule(
        "sch-1",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:02:00.000Z",
        "t",
      ),
    ).toBe(false);

    await s.putArchive({
      key: "session-logs/sess-1.json",
      body: "[]",
      contentType: "application/json",
    });
    expect((await s.getArchive("session-logs/sess-1.json"))?.body).toBe("[]");
    expect(await s.getArchive("missing")).toBeNull();
    expect((await s.listArchives()).length).toBeGreaterThan(0);

    // createControlPlane hydrates from DynamoDB
    const { plane, storage: st2 } = await createControlPlane({
      tablePrefix: prefix,
      skipEnsureTables: true,
      publicBaseUrl: "http://ui",
      idFactory: () => "sess-plane",
      now: () => "2026-01-02T00:00:00.000Z",
    });
    plane.seedWorktree({
      id: "wt-p",
      agentId: "ap",
      repositoryId: "r1",
      path: "/p",
      labels: [],
      status: "idle",
      online: true,
    });
    const reg = plane.registerAgent({
      agentId: "ap",
      worktrees: [{ id: "wt-p", repositoryId: "r1", path: "/p", labels: [] }],
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
      tablePrefix: prefix,
      skipEnsureTables: true,
    });
    expect(again.plane.getSession("sess-plane")?.prompt).toBe("from plane");
    expect(again.plane.listWorktrees().some((w) => w.id === "wt-p")).toBe(true);
    expect(again.plane.listAgents().some((a) => a.agentId === "ap")).toBe(true);
    expect(again.plane.getArchive("sess-plane")).toBeTruthy();
    await st2.clearAll();
  });

  it("ensureControlPlaneTables is idempotent", async () => {
    if (!available) {
      expect(true).toBe(true);
      return;
    }
    const { client } = createDynamoClients();
    const a = await ensureControlPlaneTables({ client, prefix });
    const b = await ensureControlPlaneTables({ client, prefix });
    expect(a.sessions).toBe(b.sessions);
  });
});
