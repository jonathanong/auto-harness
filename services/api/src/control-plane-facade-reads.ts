import type { ControlPlaneState } from "./control-plane-state.ts";
import * as durableCatalog from "./control-plane-durable-read-catalog.ts";
import * as durableRuntime from "./control-plane-durable-read-runtime.ts";

function indexUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "ValidationException" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string" &&
    /index|backfill/i.test((error as { message: string }).message)
  );
}

async function repositoryWorktreeCounts(
  state: ControlPlaneState,
  repositoryIds: readonly string[],
  hostId?: string,
): Promise<number[]> {
  const storage = state.storage;
  if (storage && typeof storage.countWorktreesByRepository === "function") {
    try {
      return await Promise.all(
        repositoryIds.map((repositoryId) =>
          storage.countWorktreesByRepository(repositoryId, hostId),
        ),
      );
    } catch (error) {
      if (!indexUnavailable(error)) throw error;
    }
  }
  const records = await durableRuntime.listWorktreesDurable(state);
  return repositoryIds.map(
    (repositoryId) =>
      records.filter(
        (worktree) =>
          worktree.repositoryId === repositoryId && (!hostId || worktree.hostId === hostId),
      ).length,
  );
}

async function repositorySessionCounts(
  state: ControlPlaneState,
  repositoryIds: readonly string[],
  hostId?: string,
): Promise<number[]> {
  if (state.storage) {
    try {
      return await Promise.all(
        repositoryIds.map((repositoryId) =>
          state.storage!.countSessionsByRepository(repositoryId, hostId),
        ),
      );
    } catch (error) {
      if (!indexUnavailable(error)) throw error;
    }
  }
  const records = state.storage
    ? await durableRuntime.listSessionsDurable(state)
    : [...state.sessions.values()];
  return repositoryIds.map(
    (repositoryId) =>
      records.filter(
        (session) =>
          session.repositoryId === repositoryId && (!hostId || session.hostId === hostId),
      ).length,
  );
}

async function repositoryScheduleCounts(
  state: ControlPlaneState,
  repositoryIds: readonly string[],
): Promise<number[]> {
  const storage = state.storage;
  if (storage && typeof storage.countSchedulesByRepository === "function") {
    try {
      return await Promise.all(
        repositoryIds.map((repositoryId) => storage.countSchedulesByRepository(repositoryId)),
      );
    } catch (error) {
      if (!indexUnavailable(error)) throw error;
    }
  }
  const records = await durableCatalog.listSchedulesDurable(state);
  return repositoryIds.map(
    (repositoryId) => records.filter((schedule) => schedule.repositoryId === repositoryId).length,
  );
}

export async function listRepositoryCountsDurable(
  state: ControlPlaneState,
  repositoryIds: readonly string[],
  hostId?: string,
): Promise<Map<string, { sessionCount: number; worktreeCount: number; scheduleCount: number }>> {
  if (repositoryIds.length === 0) return new Map();
  const [sessionCounts, worktreeCounts, scheduleCounts] = await Promise.all([
    repositorySessionCounts(state, repositoryIds, hostId),
    repositoryWorktreeCounts(state, repositoryIds, hostId),
    repositoryScheduleCounts(state, repositoryIds),
  ]);
  return new Map(
    repositoryIds.map((repositoryId, index) => [
      repositoryId,
      {
        sessionCount: sessionCounts[index] ?? 0,
        worktreeCount: worktreeCounts[index] ?? 0,
        scheduleCount: scheduleCounts[index] ?? 0,
      },
    ]),
  );
}
