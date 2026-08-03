import { describe, expect, it, vi } from "vitest";

import type { DynamoPlaneStorage } from "./db/plane-storage.ts";
import { ControlPlane } from "./control-plane.ts";

const noop = async () => undefined;
const emptyList = async () => [];

function mockStorage(): DynamoPlaneStorage {
  return {
    putSession: vi.fn(noop),
    putWorktree: vi.fn(noop),
    putConnection: vi.fn(noop),
    putLog: vi.fn(noop),
    putSchedule: vi.fn(noop),
    putRepository: vi.fn(noop),
    putArchive: vi.fn(noop),
    deleteSchedule: vi.fn(noop),
    deleteRepository: vi.fn(noop),
    tryClaimWorktree: vi.fn(async () => true),
    tryAcquireAgentLock: vi.fn(noop),
    listAllSessions: vi.fn(emptyList),
    listAllWorktrees: vi.fn(emptyList),
    listConnections: vi.fn(async () => [
      {
        connectionId: "c1",
        type: "agent" as const,
        agentId: "a1",
        connectedAt: "t",
        lastHeartbeatAt: "t",
        commandProfiles: ["c"],
      },
    ]),
    listSchedules: vi.fn(async () => [
      {
        id: "sch1",
        repositoryId: "r1",
        name: "n",
        commandProfile: "c",
        cron: "* * * * *",
        enabled: true,
        timeout: 1,
        nextRunAt: "t",
        lastRunAt: null,
        createdAt: "t",
      },
    ]),
    listRepositories: vi.fn(async () => [
      {
        id: "r1",
        name: "repo",
        url: "https://example.com/r.git",
        defaultBranch: "main",
        createdAt: "t",
        updatedAt: "t",
      },
    ]),
    listArchives: vi.fn(async () => [
      { key: "archives/x.json", body: "[]", contentType: "application/json" },
    ]),
  } as unknown as DynamoPlaneStorage;
}

describe("ControlPlane storage write-through paths", () => {
  it("persists through mock storage and hydrates catalog rows", async () => {
    const storage = mockStorage();
    const plane = new ControlPlane({
      storage,
      idFactory: () => "s1",
      connectionIdFactory: () => "c1",
      scheduleIdFactory: () => "sch-new",
      repositoryIdFactory: () => "repo-new",
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });

    plane.registerAgent({
      agentId: "a1",
      worktrees: [{ id: "wt1", repositoryId: "r1", path: "/w", labels: [] }],
      commandProfiles: ["c"],
      replaceExisting: true,
    });
    plane.createSession({
      repositoryId: "r1",
      prompt: "p",
      commandProfile: "c",
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
    plane.handleAgentMessage({
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

    const sch = plane.putSchedule({
      repositoryId: "r1",
      name: "job",
      commandProfile: "c",
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      enabled: true,
      ref: "main",
    });
    expect(
      plane.updateSchedule(sch.id, {
        name: "job2",
        commandProfile: "c2",
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

    // cancel non-running session that still holds a worktree id
    plane.state.sessions.set("queued-held", {
      id: "queued-held",
      repositoryId: "r1",
      prompt: "p",
      commandProfile: "c",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "t",
      retryCount: 0,
      worktreeId: "wt1",
      agentId: null,
      type: "prompt",
      source: "api",
    });
    plane.state.worktrees.set("wt-held", {
      id: "wt-held",
      agentId: "a1",
      repositoryId: "r1",
      path: "/h",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "queued-held",
      lastAssignedAt: "t",
    });
    // Point held session at a real worktree id that release can free
    plane.state.sessions.get("queued-held")!.worktreeId = "wt-held";
    expect(plane.cancelSession("queued-held").ok).toBe(true);

    await plane.settleStorage();
    await plane.hydrateFromStorage();
    expect(plane.listSchedules().some((s) => s.id === "sch1")).toBe(true);
    expect(plane.listRepositories().some((r) => r.id === "r1")).toBe(true);
    expect(plane.listArchives().length).toBeGreaterThan(0);
    expect(plane.listAgents().some((a) => a.agentId === "a1")).toBe(true);

    expect(vi.mocked(storage.putSession).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(storage.putWorktree).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(storage.putConnection).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(storage.putLog).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(storage.putArchive).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(storage.tryClaimWorktree).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(storage.tryAcquireAgentLock).mock.calls.length).toBeGreaterThan(0);
  });
});
