import {
  isActiveSessionStatus,
  nextCronOccurrence,
  repositoryAdmissionState,
  type RepositoryAdmissionState,
} from "@auto-harness/shared";

import { cancelSessionDurable } from "./control-plane-cancel-durable.ts";
import { cancelSession } from "./control-plane-lifecycle.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import type { RepositoryRecord } from "./db/plane-storage.ts";
import type { RepositoryAdmissionFailure } from "./control-plane-repository-admission-state.ts";

function cache(state: ControlPlaneState, repository: RepositoryRecord): RepositoryRecord {
  state.repositories.set(repository.id, { ...repository });
  return { ...repository };
}

function transitionInMemory(
  state: ControlPlaneState,
  id: string,
  admissionState: RepositoryAdmissionState,
): { ok: true; repository: RepositoryRecord } | RepositoryAdmissionFailure {
  const current = state.repositories.get(id);
  if (!current) return { ok: false, error: "repository not found", code: "NOT_FOUND" };
  if (
    admissionState !== "draining" &&
    repositoryAdmissionState(current.admissionState) === "draining"
  ) {
    return { ok: false, error: "repository drain is not complete", code: "CONFLICT" };
  }
  const now = state.now();
  const repository: RepositoryRecord = {
    ...current,
    admissionState,
    admissionStateChangedAt: now,
    updatedAt: now,
    ...(admissionState === "draining" ? { drainRequestedAt: now } : {}),
  };
  if (admissionState === "active") {
    delete repository.drainRequestedAt;
    delete repository.drainCompletedAt;
  }
  return { ok: true, repository: cache(state, repository) };
}

async function skipDueSchedulesBeforeActivation(
  state: ControlPlaneState,
  repositoryId: string,
): Promise<void> {
  const now = state.now();
  const schedules = state.storage
    ? await state.storage.listSchedules()
    : [...state.schedules.values()];
  for (const schedule of schedules) {
    if (
      schedule.repositoryId !== repositoryId ||
      !schedule.enabled ||
      Date.parse(schedule.nextRunAt) > Date.parse(now)
    )
      continue;
    const nextRunAt = nextCronOccurrence(schedule.cron, now);
    if (!nextRunAt) continue;
    if (
      !state.storage ||
      (await state.storage.skipScheduleForClosedRepository({
        scheduleId: schedule.id,
        repositoryId,
        expectedNextRunAt: schedule.nextRunAt,
        newNextRunAt: nextRunAt,
      }))
    ) {
      state.schedules.set(schedule.id, { ...schedule, nextRunAt });
    }
  }
}

export async function setRepositoryAdmissionDurable(
  state: ControlPlaneState,
  id: string,
  admissionState: "active" | "paused",
): Promise<{ ok: true; repository: RepositoryRecord } | RepositoryAdmissionFailure> {
  if (!state.storage) {
    if (admissionState === "active") await skipDueSchedulesBeforeActivation(state, id);
    return transitionInMemory(state, id, admissionState);
  }
  if (admissionState === "active") {
    const current = await state.storage.getRepository(id);
    if (!current) return { ok: false, error: "repository not found", code: "NOT_FOUND" };
    cache(state, current);
    if (repositoryAdmissionState(current.admissionState) === "draining") {
      return { ok: false, error: "repository drain is not complete", code: "CONFLICT" };
    }
    await skipDueSchedulesBeforeActivation(state, id);
  }
  const repository = await state.storage.setRepositoryAdmissionState(
    id,
    admissionState,
    state.now(),
  );
  if (repository) return { ok: true, repository: cache(state, repository) };
  const current = await state.storage.getRepository(id);
  if (!current) return { ok: false, error: "repository not found", code: "NOT_FOUND" };
  cache(state, current);
  return { ok: false, error: "repository drain is not complete", code: "CONFLICT" };
}

async function reconcileOne(
  state: ControlPlaneState,
  repository: RepositoryRecord,
): Promise<RepositoryRecord> {
  if (!state.storage || !repository.drainRequestedAt) return repository;
  const sessions = (await state.storage.listAllSessions(true)).filter(
    (session) => session.repositoryId === repository.id,
  );
  for (const session of sessions
    .filter((item) => isActiveSessionStatus(item.status))
    .slice(0, 100)) {
    await cancelSessionDurable(state, session.id);
  }
  const remaining = (await state.storage.listAllSessions(true)).filter(
    (session) => session.repositoryId === repository.id,
  );
  const worktrees = await state.storage.listWorktreesForRepo(repository.id, true);
  const leased =
    remaining.some(
      (session) => isActiveSessionStatus(session.status) || session.mainCheckoutLease === true,
    ) || worktrees.some((worktree) => !!worktree.currentSessionId);
  if (leased) return repository;
  const completed = await state.storage.completeRepositoryDrain(
    repository.id,
    repository.drainRequestedAt,
    state.now(),
  );
  return completed ? cache(state, completed) : repository;
}

function hasInMemoryRepositoryLease(state: ControlPlaneState, repositoryId: string): boolean {
  return (
    [...state.mainCheckoutLeases.keys()].some((key) => key.endsWith(`\0${repositoryId}`)) ||
    [...state.worktrees.values()].some(
      (worktree) => worktree.repositoryId === repositoryId && !!worktree.currentSessionId,
    )
  );
}

function reconcileInMemory(
  state: ControlPlaneState,
  repository: RepositoryRecord,
): RepositoryRecord {
  for (const session of state.sessions.values()) {
    if (session.repositoryId === repository.id && isActiveSessionStatus(session.status)) {
      cancelSession(state, session.id);
    }
  }
  if (hasInMemoryRepositoryLease(state, repository.id)) return repository;
  const now = state.now();
  return cache(state, {
    ...repository,
    admissionState: "paused",
    admissionStateChangedAt: now,
    drainCompletedAt: now,
    updatedAt: now,
  });
}

export async function drainRepositoryDurable(
  state: ControlPlaneState,
  id: string,
): Promise<{ ok: true; repository: RepositoryRecord } | RepositoryAdmissionFailure> {
  if (!state.storage) {
    const transitioned = transitionInMemory(state, id, "draining");
    if (!transitioned.ok) return transitioned;
    return { ok: true, repository: reconcileInMemory(state, transitioned.repository) };
  }
  const draining = await state.storage.setRepositoryAdmissionState(id, "draining", state.now());
  if (!draining) return { ok: false, error: "repository not found", code: "NOT_FOUND" };
  cache(state, draining);
  return { ok: true, repository: await reconcileOne(state, draining) };
}

/** Scheduler reconciliation is idempotent and bounded by the set of draining repositories. */
export async function reconcileRepositoryDrainsDurable(
  state: ControlPlaneState,
): Promise<RepositoryRecord[]> {
  const repositories = (
    state.storage ? await state.storage.listRepositories() : [...state.repositories.values()]
  ).filter((repository) => repositoryAdmissionState(repository.admissionState) === "draining");
  const reconciled: RepositoryRecord[] = [];
  for (const repository of repositories) {
    reconciled.push(
      state.storage ? await reconcileOne(state, repository) : reconcileInMemory(state, repository),
    );
  }
  return reconciled;
}
