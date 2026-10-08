/* eslint-disable max-lines -- focused worker scenarios share one typed in-memory store fixture. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import { runSessionRetention } from "./control-plane-session-retention.ts";
import type { RetentionJob } from "./db/plane-storage-session-retention.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const COMPLETED_AT = "2025-12-01T00:00:00.000Z";
const SESSION: SessionRecord = {
  id: "retention-candidate",
  repositoryId: "repo",
  prompt: "prompt",
  target: { commandId: "command" },
  fallbacks: [],
  targetDisplayNames: ["command"],
  queueTtlSeconds: 60,
  queueExpiresAt: "2026-01-01T01:00:00.000Z",
  timeout: 60,
  priority: 0,
  requiredLabels: [],
  status: "completed",
  queueShard: 0,
  createdAt: "2025-11-30T23:00:00.000Z",
  completedAt: "2025-12-01T00:00:00.000Z",
};

afterEach(() => vi.restoreAllMocks());

function job(sessionId = "retention-job"): RetentionJob {
  return {
    scopeKey: "__retention#v1#jobs",
    recordKey: `2026-01-01T00:02:00.000Z#${sessionId}`,
    sessionId,
    repositoryId: "repo",
    principalId: "owner",
    queueShard: 0,
    activityGeneration: "attempt-1",
    createdAt: SESSION.createdAt,
    completedAt: SESSION.completedAt!,
    token: `token-${sessionId}`,
    readyAt: "2026-01-01T00:02:00.000Z",
    retentionDays: 30,
  };
}

type Store = {
  loadCursor: (name: string) => Promise<Record<string, unknown> | undefined>;
  listJobs: (
    now: string,
    limit: number,
    cursor?: Record<string, unknown>,
  ) => Promise<{ records: RetentionJob[]; nextKey?: Record<string, unknown> }>;
  saveCursor: (name: string, cursor?: Record<string, unknown>) => Promise<void>;
  lease: (job: RetentionJob, now: string, owner: string) => Promise<boolean>;
  getSession: (id: string) => Promise<SessionRecord | null>;
  deleteRelatedPage: (id: string, kind: "usage" | "logs") => Promise<boolean>;
  finish: (job: RetentionJob, owner: string, now: string) => Promise<boolean>;
  nextPartition: (count: number) => Promise<number>;
  listCandidates: (
    status: string,
    shard: number,
    cutoff: string,
    limit: number,
    cursor?: Record<string, unknown>,
  ) => Promise<{
    records: Array<{ id: string; completedAt: string; statusShard: string }>;
    nextKey?: Record<string, unknown>;
  }>;
  claim: (session: SessionRecord, now: string, days: number) => Promise<boolean>;
};

function makeRun(input: {
  store?: Partial<Store>;
  settings?: { sessionRetentionDays: number };
  now?: string;
  archiveWriter?: {
    deleteSessionObjectsPage?: (
      sessionId: string,
      limit: number,
    ) => Promise<{ deleted: number; done: boolean }>;
  };
  shouldContinue?: () => boolean;
}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const fullStore: Store = {
    loadCursor: async (name) => {
      calls.push({ method: "loadCursor", args: [name] });
      return undefined;
    },
    listJobs: async (now, limit, cursor) => {
      calls.push({ method: "listJobs", args: [now, limit, cursor] });
      return { records: [] };
    },
    saveCursor: async (name, cursor) => {
      calls.push({ method: "saveCursor", args: [name, cursor] });
    },
    lease: async (current, now, owner) => {
      calls.push({ method: "lease", args: [current, now, owner] });
      return true;
    },
    getSession: async (id) => {
      calls.push({ method: "getSession", args: [id] });
      return SESSION;
    },
    deleteRelatedPage: async (id, kind) => {
      calls.push({ method: "deleteRelatedPage", args: [id, kind] });
      return true;
    },
    finish: async (current, owner, now) => {
      calls.push({ method: "finish", args: [current, owner, now] });
      return true;
    },
    nextPartition: async (count) => {
      calls.push({ method: "nextPartition", args: [count] });
      return 0;
    },
    listCandidates: async (status, shard, cutoff, limit, cursor) => {
      calls.push({ method: "listCandidates", args: [status, shard, cutoff, limit, cursor] });
      return { records: [] };
    },
    claim: async (session, now, days) => {
      calls.push({ method: "claim", args: [session, now, days] });
      return true;
    },
    ...input.store,
  };
  const storage = {
    getSessionRetentionStore: () => fullStore,
    ...(input.settings ? { getSessionLogSettings: async () => input.settings } : {}),
  };
  const state = createControlPlaneState({
    storage: storage as never,
    now: () => input.now ?? NOW,
    shardCount: 2,
    ...(input.archiveWriter ? { archiveWriter: input.archiveWriter as never } : {}),
  });
  return {
    state,
    calls,
    store: fullStore,
    run: (options?: {
      maxSessions?: number;
      maxObjectVersions?: number;
      shouldContinue?: () => boolean;
    }) =>
      runSessionRetention(state, {
        ...options,
        shouldContinue: options?.shouldContinue ?? input.shouldContinue,
      }),
  };
}

describe("runSessionRetention", () => {
  it("does nothing when the process has no durable retention store", async () => {
    const state = createControlPlaneState();
    await expect(runSessionRetention(state)).resolves.toBe(0);
  });

  it("uses safe default bounds for non-integer page options", async () => {
    const harness = makeRun({
      archiveWriter: {
        deleteSessionObjectsPage: async (_sessionId, limit) => {
          expect(limit).toBe(1000);
          return { deleted: 0, done: false };
        },
      },
      store: {
        listJobs: async (_now, limit) => {
          expect(limit).toBe(25);
          return { records: [job("bounded")] };
        },
        getSession: async (id) => ({ ...SESSION, id, retentionToken: "token-bounded" }),
      },
    });
    await harness.run({ maxSessions: 2.5, maxObjectVersions: Number.NaN });
    expect(harness.calls.filter((call) => call.method === "lease")).toHaveLength(1);
  });

  it("uses the configured retention cutoff and bounds both query pages", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const oldSession = { ...SESSION, completedAt: "2025-09-01T00:00:00.000Z" };
    const candidate = {
      id: oldSession.id,
      completedAt: oldSession.completedAt!,
      statusShard: "completed#0",
    };
    const harness = makeRun({
      settings: { sessionRetentionDays: 90 },
      store: {
        loadCursor: async (name) => {
          calls.push({ method: "cursor", args: [name] });
          return name === "JOBS" ? { scopeKey: "jobs", recordKey: "last" } : undefined;
        },
        listJobs: async (now, limit, cursor) => {
          calls.push({ method: "jobs", args: [now, limit, cursor] });
          return { records: [] };
        },
        nextPartition: async (count) => {
          calls.push({ method: "partition", args: [count] });
          return 5;
        },
        listCandidates: async (status, shard, cutoff, limit, cursor) => {
          calls.push({ method: "candidates", args: [status, shard, cutoff, limit, cursor] });
          return { records: [candidate], nextKey: { id: "next" } };
        },
        getSession: async () => oldSession,
        claim: async (session, now, days) => {
          calls.push({ method: "claim", args: [session, now, days] });
          return true;
        },
      },
    });

    await expect(harness.run({ maxSessions: 4 })).resolves.toBe(0);
    expect(calls.find((call) => call.method === "jobs")?.args).toEqual([
      NOW,
      4,
      { scopeKey: "jobs", recordKey: "last" },
    ]);
    expect(calls.find((call) => call.method === "partition")?.args).toEqual([8]);
    expect(calls.find((call) => call.method === "candidates")?.args).toEqual([
      "cancelled",
      1,
      "2025-10-03T00:00:00.000Z",
      4,
      undefined,
    ]);
    expect(calls.find((call) => call.method === "claim")?.args).toEqual([oldSession, NOW, 90]);
  });

  it("defaults the legacy retention policy and does not claim candidates newer than its cutoff", async () => {
    const newer = { ...SESSION, completedAt: "2025-12-15T00:00:00.000Z" };
    const harness = makeRun({
      store: {
        listCandidates: async (_status, _shard, cutoff, limit) => {
          expect(cutoff).toBe("2025-12-02T00:00:00.000Z");
          expect(limit).toBe(25);
          return {
            records: [
              { id: newer.id, completedAt: newer.completedAt!, statusShard: "completed#0" },
            ],
          };
        },
        getSession: async () => newer,
      },
    });
    await harness.run();
    expect(harness.calls.some((call) => call.method === "claim")).toBe(false);
  });

  it("keeps a per-job failure retryable after the bounded page wraps", async () => {
    const currentJob = job("retry-me");
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    let sessionReads = 0;
    const harness = makeRun({
      store: {
        listJobs: async () => ({ records: [currentJob] }),
        getSession: async () => {
          sessionReads += 1;
          if (sessionReads === 1) throw new Error("temporary read failure");
          return { ...SESSION, id: currentJob.sessionId, retentionToken: currentJob.token };
        },
      },
    });
    await expect(harness.run()).resolves.toBe(0);
    await expect(harness.run()).resolves.toBe(1);
    expect(logError).toHaveBeenCalledWith("session retention cleanup failed", {
      sessionId: currentJob.sessionId,
      error: expect.any(Error),
    });
    expect(sessionReads).toBe(2);
    expect(
      harness.calls
        .filter((call) => call.method === "saveCursor" && call.args[0] === "JOBS")
        .map((call) => call.args[1]),
    ).toEqual([undefined, undefined]);
    expect(harness.state.sessions.has(currentJob.sessionId)).toBe(false);
  });

  it("continues after lease loss and rejects stale or ineligible claimed sessions", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = job("lease-lost");
    const second = job("stale-claim");
    let sessionReads = 0;
    const harness = makeRun({
      store: {
        listJobs: async () => ({ records: [first, second] }),
        lease: async (current) => current.sessionId !== first.sessionId,
        getSession: async (id) => {
          sessionReads += 1;
          return id === second.sessionId
            ? { ...SESSION, id, retentionToken: "different-token" }
            : SESSION;
        },
      },
    });
    await expect(harness.run()).resolves.toBe(0);
    expect(errors).toHaveBeenCalledWith("session retention cleanup failed", {
      sessionId: second.sessionId,
      error: expect.any(Error),
    });
    expect(sessionReads).toBe(1);
  });

  it("fails closed when the object writer cannot delete versions", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const currentJob = job("no-object-delete");
    const harness = makeRun({
      archiveWriter: {},
      store: {
        listJobs: async () => ({ records: [currentJob] }),
        getSession: async (id) => ({ ...SESSION, id, retentionToken: currentJob.token }),
      },
    });
    await expect(harness.run()).resolves.toBe(0);
    expect(errors).toHaveBeenCalledWith("session retention cleanup failed", {
      sessionId: currentJob.sessionId,
      error: expect.objectContaining({
        message: "object store does not support session retention",
      }),
    });
    expect(harness.calls.some((call) => call.method === "finish")).toBe(false);
  });

  it("pages in-memory objects before clearing session state", async () => {
    const currentJob = job("memory-objects");
    const harness = makeRun({
      store: {
        listJobs: async () => ({ records: [currentJob] }),
        getSession: async (id) => ({ ...SESSION, id, retentionToken: currentJob.token }),
        finish: async () => {
          return true;
        },
      },
    });
    harness.state.logObjects.set("sessions/other/logs.jsonl.gz", Buffer.from("other"));
    harness.state.logObjects.set("sessions/memory-objects/logs.jsonl.gz", Buffer.from("target"));
    harness.state.sessions.set(currentJob.sessionId, { ...SESSION, id: currentJob.sessionId });
    harness.state.logs.set(currentJob.sessionId, []);
    harness.state.archives.set(`sessions/${currentJob.sessionId}/logs.jsonl.gz`, {
      key: `sessions/${currentJob.sessionId}/logs.jsonl.gz`,
      status: "ready",
      contentType: "application/gzip",
      bodyBytes: 0,
      objectStored: true,
      updatedAt: NOW,
    });

    await expect(harness.run({ maxObjectVersions: 1 })).resolves.toBe(0);
    expect(harness.state.logObjects.has("sessions/memory-objects/logs.jsonl.gz")).toBe(true);
    await expect(harness.run({ maxObjectVersions: 1 })).resolves.toBe(0);
    expect(harness.state.logObjects.has("sessions/memory-objects/logs.jsonl.gz")).toBe(false);
    await expect(harness.run({ maxObjectVersions: 1 })).resolves.toBe(1);
    expect(harness.state.sessions.has(currentJob.sessionId)).toBe(false);
    expect(harness.state.logs.has(currentJob.sessionId)).toBe(false);
    expect(harness.state.archives.has(`sessions/${currentJob.sessionId}/logs.jsonl.gz`)).toBe(
      false,
    );
  });

  it("leaves the job retryable when a related-row page or final transaction is incomplete", async () => {
    const currentJob = job("related-pages-incomplete");
    for (const phase of ["usage", "logs", "finish"] as const) {
      let finishAttempts = 0;
      const harness = makeRun({
        store: {
          listJobs: async () => ({ records: [currentJob] }),
          getSession: async (id) => ({ ...SESSION, id, retentionToken: currentJob.token }),
          deleteRelatedPage: async (_id, kind) => kind !== phase,
          finish: async () => {
            finishAttempts += 1;
            return phase !== "finish";
          },
        },
      });
      await expect(harness.run()).resolves.toBe(0);
      expect(finishAttempts).toBe(phase === "finish" ? 1 : 0);
    }
  });

  it("spends the object version budget before advancing later jobs", async () => {
    const first = job("object-job-1");
    const second = job("object-job-2");
    const archiveLimits: number[] = [];
    const harness = makeRun({
      archiveWriter: {
        deleteSessionObjectsPage: async (_sessionId, limit) => {
          archiveLimits.push(limit);
          return { deleted: 2, done: false };
        },
      },
      store: {
        listJobs: async () => ({ records: [first, second], nextKey: { scopeKey: "next" } }),
        getSession: async (id) => ({ ...SESSION, id, retentionToken: `token-${id}` }),
      },
    });
    await harness.run({ maxSessions: 5, maxObjectVersions: 2 });
    expect(archiveLimits).toEqual([2]);
    expect(harness.calls.filter((call) => call.method === "lease")).toHaveLength(1);
    expect(harness.calls.some((call) => call.method === "deleteRelatedPage")).toBe(false);
    expect(harness.calls.some((call) => call.method === "finish")).toBe(false);
    expect(
      harness.calls.find((call) => call.method === "saveCursor" && call.args[0] === "JOBS")
        ?.args[1],
    ).toEqual({
      scopeKey: first.scopeKey,
      recordKey: first.recordKey,
    });
  });

  it("continues to record cleanup after an object page is complete", async () => {
    const currentJob = job("complete-object-page");
    const harness = makeRun({
      archiveWriter: {
        deleteSessionObjectsPage: async () => ({ deleted: 1, done: true }),
      },
      store: {
        listJobs: async () => ({ records: [currentJob] }),
        getSession: async (id) => ({ ...SESSION, id, retentionToken: currentJob.token }),
      },
    });
    await expect(harness.run()).resolves.toBe(1);
    expect(harness.calls.filter((call) => call.method === "deleteRelatedPage")).toHaveLength(2);
    expect(harness.calls.some((call) => call.method === "finish")).toBe(true);
  });

  it("saves the unprocessed candidate cursor when continuation is stopped", async () => {
    let checks = 0;
    const candidates = [
      { id: "first", completedAt: COMPLETED_AT, statusShard: "completed#0" },
      { id: "second", completedAt: COMPLETED_AT, statusShard: "completed#0" },
    ];
    const harness = makeRun({
      store: {
        listCandidates: async () => ({ records: candidates, nextKey: { id: "third" } }),
        getSession: async (id) => ({ ...SESSION, id }),
      },
    });
    await harness.run({
      shouldContinue: () => {
        checks += 1;
        return checks !== 3;
      },
    });
    expect(
      harness.calls.find(
        (call) => call.method === "saveCursor" && String(call.args[0]).startsWith("CANDIDATES#"),
      )?.args[1],
    ).toEqual({
      id: "first",
      completedAt: COMPLETED_AT,
      statusShard: "completed#0",
    });
  });

  it("stores the current job cursor when work is stopped and skips the candidate phase", async () => {
    const currentJob = job("stop-before-job");
    const harness = makeRun({
      store: { listJobs: async () => ({ records: [currentJob], nextKey: { scopeKey: "more" } }) },
      shouldContinue: () => false,
    });
    await expect(harness.run()).resolves.toBe(0);
    expect(harness.calls.find((call) => call.method === "saveCursor")?.args).toEqual([
      "JOBS",
      undefined,
    ]);
    expect(harness.calls.some((call) => call.method === "listCandidates")).toBe(false);
  });

  it("retries an unavailable sweep from its durable cursor on the next invocation", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("candidate index unavailable");
    let sweeps = 0;
    const harness = makeRun({
      store: {
        listCandidates: async () => {
          sweeps += 1;
          if (sweeps === 1) throw failure;
          return { records: [] };
        },
      },
    });
    await expect(harness.run()).resolves.toBe(0);
    await expect(harness.run()).resolves.toBe(0);
    expect(errors).toHaveBeenCalledWith("session retention sweep unavailable", failure);
    expect(sweeps).toBe(2);
  });
});
