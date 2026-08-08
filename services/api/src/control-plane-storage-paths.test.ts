import { describe, expect, it } from "vitest";

import { createDynamoTestCtx } from "./db/dynamo-test-helpers.ts";
import { ControlPlane } from "./control-plane.ts";
import { putScheduleOrThrow } from "./control-plane-test-helpers.ts";

const ctx = createDynamoTestCtx("StoPaths");

describe("ControlPlane storage write-through paths", () => {
  it("persists through real DynamoDB Local and hydrates catalog rows", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    const storage = ctx.storage;

    // Rows already in Dynamo (e.g. from another process) — hydrateFromStorage must pick these up.
    await storage.putSchedule({
      id: "sch1",
      repositoryId: "r1",
      name: "n",
      commandId: "c",
      targetLabel: "c",
      cron: "* * * * *",
      enabled: true,
      timeout: 1,
      nextRunAt: "t",
      lastRunAt: null,
      createdAt: "t",
    });
    await storage.putRepository({
      id: "r1",
      name: "repo",
      url: "https://example.com/r.git",
      defaultBranch: "main",
      createdAt: "t",
      updatedAt: "t",
    });

    const plane = new ControlPlane({
      storage,
      idFactory: () => "s1",
      connectionIdFactory: () => "c1",
      scheduleIdFactory: () => "sch-new",
      repositoryIdFactory: () => "repo-new",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });

    plane.registerHost({
      hostId: "a1",
      worktrees: [{ id: "wt1", name: "wt1", repositoryId: "r1", path: "/w", labels: [] }],
      commandProfiles: ["c"],
      replaceExisting: true,
    });
    plane.createCommand({ id: "c", name: "c", argv: ["echo"], providerId: null });
    plane.createCommand({ id: "c2", name: "c2", argv: ["echo"], providerId: null });
    plane.createSession({
      repositoryId: "r1",
      prompt: "p",
      commandId: "c",
      timeout: 1,
    });
    plane.assignQueued();
    plane.appendLog({
      sessionId: "s1",
      stream: "stdout",
      content: "hi",
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 1,
    });
    plane.handleHostMessage({
      type: "session:status",
      sessionId: "s1",
      status: "completed",
    });
    expect(plane.archiveSessionLogs("s1")?.body).toContain("hi");

    const repo = plane.createRepository({
      name: "n",
      url: "https://example.com/n.git",
      setupScript: "echo",
      terminalHookScript: "hook",
    });
    expect(repo.ok).toBe(true);
    if (repo.ok) {
      expect(
        plane.updateRepository(repo.repository.id, {
          name: "n2",
          url: "https://example.com/n2.git",
          defaultBranch: "dev",
          setupScript: "s",
          terminalHookScript: "h",
        }).ok,
      ).toBe(true);
      expect(plane.deleteRepository(repo.repository.id).ok).toBe(true);
    }

    const sch = putScheduleOrThrow(plane, {
      repositoryId: "r1",
      name: "job",
      commandId: "c",
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      enabled: true,
      ref: "main",
    });
    expect(
      plane.updateSchedule(sch.id, {
        name: "job2",
        commandId: "c2",
        cron: "0 * * * *",
        timeout: 2,
        nextRunAt: "2026-01-02T00:00:00.000Z",
        enabled: false,
        ref: "dev",
        repositoryId: "r2",
      }).ok,
    ).toBe(true);
    // re-enable and trigger (writes schedule)
    plane.updateSchedule(sch.id, {
      enabled: true,
      nextRunAt: "2026-01-01T00:00:00.000Z",
    });
    expect(plane.triggerSchedule(sch.id, "2026-01-01T00:00:00.000Z").ok).toBe(true);
    expect(plane.deleteSchedule(sch.id).ok).toBe(true);

    plane.putHostInventory("a1", {
      repositories: [
        {
          id: "r1",
          path: "/r",
          defaultBranch: "main",
          worktrees: [{ id: "wt1", name: "wt1", path: "/w", labels: [] }],
        },
      ],
      commandProfiles: { c: { argv: ["echo"], appendPrompt: true } },
    });
    await plane.settleStorage();
    await plane.hydrateFromStorage();
    expect(plane.listSchedules().some((s) => s.id === "sch1")).toBe(true);
    expect(plane.listRepositories().some((r) => r.id === "r1")).toBe(true);
    expect(plane.getHostInventory("a1")?.hostId).toBe("a1");
    expect(plane.listArchives().length).toBeGreaterThan(0);

    // Verify real persistence directly against storage, not just the in-process cache.
    expect(await storage.getSession("s1")).not.toBeNull();
    expect((await storage.getHostInventory("a1"))?.hostId).toBe("a1");
  });
});
