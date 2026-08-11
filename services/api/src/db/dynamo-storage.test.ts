import { describe, expect, it } from "vitest";

import { createDynamoTestCtx } from "./dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("Sto");

describe("DynamoDB Local storage", () => {
  it("persists sessions worktrees claims locks logs schedules", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    const s = ctx.storage;

    await s.putSession({
      id: "sess-1",
      repositoryId: "r1",
      prompt: "hi",
      target: { commandId: "c" },
      fallbacks: [],
      targetLabels: ["c"],
      queueTtlSeconds: 691200,
      queueExpiresAt: "2026-01-09T00:00:00.000Z",
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
    expect((await s.getSession("sess-1", true))?.ref).toBe("main");
    expect(await s.getSession("missing")).toBeNull();
    expect((await s.listAllSessions()).length).toBeGreaterThan(0);
    expect((await s.listSessionsByStatus("queued", 0)).some((x) => x.id === "sess-1")).toBe(true);

    await s.putWorktree({
      id: "wt-1",
      name: "wt-1",
      hostId: "a1",
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
      await s.tryAcquireHostLock({
        hostId: "ag1",
        connectionId: "c1",
        replaceExisting: false,
      }),
    ).toBe(true);
    expect(
      await s.tryAcquireHostLock({
        hostId: "ag1",
        connectionId: "c2",
        replaceExisting: false,
      }),
    ).toBe(false);
    expect(await s.getHostLock("ag1")).toBe("c1");
    await s.releaseHostLock("ag1", "wrong");
    expect(await s.getHostLock("ag1")).toBe("c1");
    await s.releaseHostLock("ag1", "c1");
    expect(await s.getHostLock("ag1")).toBeNull();
    expect(
      await s.tryAcquireHostLock({
        hostId: "ag1",
        connectionId: "c3",
        replaceExisting: true,
      }),
    ).toBe(true);

    await s.putConnection({
      connectionId: "c3",
      type: "host",
      hostId: "ag1",
      connectedAt: "t",
      lastHeartbeatAt: "t",
      commandProfiles: ["echo"],
    });
    expect((await s.getConnection("c3"))?.hostId).toBe("ag1");
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
      target: { commandId: "c" },
      fallbacks: [],
      targetLabels: ["c"],
      queueTtlSeconds: 691200,
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
    await expect(
      s.updateScheduleManagement(
        {
          ...(await s.getSchedule("sch-1"))!,
          name: "renamed job",
          nextRunAt: "2026-01-01T00:30:00.000Z",
          lastRunAt: "stale-last-run",
        },
        "2026-01-01T00:01:00.000Z",
      ),
    ).resolves.toMatchObject({
      name: "renamed job",
      nextRunAt: "2026-01-01T00:30:00.000Z",
      lastRunAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(
      s.updateScheduleManagement(
        { ...(await s.getSchedule("sch-1"))!, name: "stale rename" },
        "2026-01-01T00:01:00.000Z",
      ),
    ).resolves.toBeNull();
    await expect(s.getSchedule("sch-1")).resolves.toMatchObject({
      name: "renamed job",
      nextRunAt: "2026-01-01T00:30:00.000Z",
    });
    await s.deleteWorktree("wt-1");
    expect(await s.getWorktree("wt-1")).toBeNull();

    await s.putArchive({
      key: "session-logs/sess-1.json",
      body: "[]",
      contentType: "application/json",
    });
    expect((await s.getArchive("session-logs/sess-1.json"))?.body).toBe("[]");
    expect(await s.getArchive("missing")).toBeNull();
    expect((await s.listArchives()).length).toBeGreaterThan(0);
  });
});
