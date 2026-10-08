import { randomUUID } from "node:crypto";
import { normalizeControlPlaneSessionLogSettings } from "@auto-harness/shared";

import type { ControlPlaneState } from "./control-plane-state.ts";
import {
  sessionRetentionEligible,
  type DynamoSessionRetentionStore,
  type RetentionJob,
} from "./db/plane-storage-session-retention.ts";

const TERMINAL_STATUSES = ["completed", "failed", "cancelled", "timed_out"] as const;
const memoryObjectCursors = new WeakMap<ControlPlaneState, Map<string, Iterator<string>>>();

export type SessionRetentionOptions = {
  maxSessions?: number;
  maxObjectVersions?: number;
  shouldContinue?: () => boolean;
};

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return value === undefined
    ? fallback
    : Number.isSafeInteger(value)
      ? Math.max(1, Math.min(value, maximum))
      : fallback;
}

function deleteMemoryObjectPage(
  state: ControlPlaneState,
  job: RetentionJob,
  limit: number,
): boolean {
  let cursors = memoryObjectCursors.get(state);
  if (!cursors) {
    cursors = new Map();
    memoryObjectCursors.set(state, cursors);
  }
  let cursor = cursors.get(job.token);
  if (!cursor) {
    cursor = state.logObjects.keys();
    cursors.set(job.token, cursor);
  }
  for (let examined = 0; examined < limit; examined++) {
    const next = cursor.next();
    if (next.done) {
      cursors.delete(job.token);
      return true;
    }
    if (next.value.startsWith(`sessions/${job.sessionId}/`)) state.logObjects.delete(next.value);
  }
  return false;
}

async function processJob(
  state: ControlPlaneState,
  store: DynamoSessionRetentionStore,
  job: RetentionJob,
  objectLimit: number,
): Promise<{ deleted: number; objects: number }> {
  const owner = randomUUID();
  if (!(await store.lease(job, state.now(), owner))) return { deleted: 0, objects: 0 };
  const session = await store.getSession(job.sessionId);
  if (!session || session.retentionToken !== job.token || !sessionRetentionEligible(session)) {
    throw new Error("session retention claim no longer matches its session");
  }
  if (state.archiveWriter) {
    if (!state.archiveWriter.deleteSessionObjectsPage)
      throw new Error("object store does not support session retention");
    const page = await state.archiveWriter.deleteSessionObjectsPage(job.sessionId, objectLimit);
    if (!page.done) return { deleted: 0, objects: page.deleted };
  }
  if (!deleteMemoryObjectPage(state, job, objectLimit)) return { deleted: 0, objects: objectLimit };
  if (!(await store.deleteRelatedPage(job.sessionId, "usage"))) return { deleted: 0, objects: 0 };
  if (!(await store.deleteRelatedPage(job.sessionId, "logs"))) return { deleted: 0, objects: 0 };
  if (!(await store.finish(job, owner, state.now()))) return { deleted: 0, objects: 0 };
  state.sessions.delete(job.sessionId);
  state.logs.delete(job.sessionId);
  state.pendingLogPersists.delete(job.sessionId);
  state.archives.delete(`sessions/${job.sessionId}/logs.jsonl.gz`);
  return { deleted: 1, objects: 0 };
}

/** One due-job page plus one rotating terminal-index page, never a Sessions Scan. */
export async function runSessionRetention(
  state: ControlPlaneState,
  options: SessionRetentionOptions = {},
): Promise<number> {
  if (!state.storage || typeof state.storage.getSessionRetentionStore !== "function") return 0;
  const store = state.storage.getSessionRetentionStore();
  const limit = bounded(options.maxSessions, 25, 100);
  let objectsRemaining = bounded(options.maxObjectVersions, 1000, 1000);
  const shouldContinue = options.shouldContinue ?? (() => true);
  const now = state.now();
  let deleted = 0;
  try {
    let cursor = await store.loadCursor("JOBS");
    const jobs = await store.listJobs(now, limit, cursor);
    let processed = 0;
    for (const job of jobs.records) {
      if (!shouldContinue() || objectsRemaining < 1) break;
      try {
        const result = await processJob(state, store, job, objectsRemaining);
        deleted += result.deleted;
        objectsRemaining -= result.objects;
      } catch (error) {
        console.error("session retention cleanup failed", { sessionId: job.sessionId, error });
      }
      processed += 1;
      cursor = { scopeKey: job.scopeKey, recordKey: job.recordKey };
    }
    await store.saveCursor("JOBS", processed === jobs.records.length ? jobs.nextKey : cursor);
    if (!shouldContinue()) return deleted;

    const settings =
      typeof state.storage.getSessionLogSettings === "function"
        ? await state.storage.getSessionLogSettings()
        : state.sessionLogSettings;
    const days = normalizeControlPlaneSessionLogSettings(
      settings ?? undefined,
    ).sessionRetentionDays;
    const cutoff = new Date(Date.parse(now) - days * 86_400_000).toISOString();
    const partition = await store.nextPartition(TERMINAL_STATUSES.length * state.shardCount);
    const status = TERMINAL_STATUSES[Math.floor(partition / state.shardCount)]!;
    const shard = partition % state.shardCount;
    const name = `CANDIDATES#${status}#${shard}`;
    cursor = await store.loadCursor(name);
    const candidates = await store.listCandidates(status, shard, cutoff, limit, cursor);
    processed = 0;
    for (const candidate of candidates.records) {
      if (!shouldContinue()) break;
      const session = await store.getSession(candidate.id);
      if (session && sessionRetentionEligible(session) && session.completedAt! <= cutoff) {
        await store.claim(session, now, days);
      }
      processed += 1;
      cursor = {
        id: candidate.id,
        completedAt: candidate.completedAt,
        statusShard: candidate.statusShard,
      };
    }
    await store.saveCursor(
      name,
      processed === candidates.records.length ? candidates.nextKey : cursor,
    );
  } catch (error) {
    console.error("session retention sweep unavailable", error);
  }
  return deleted;
}
