import {
  isActiveSessionStatus,
  repositoryAdmissionState,
  type RepositoryAdmissionState,
} from "@auto-harness/shared";

import { cancelSessionDurable } from "./control-plane-cancel-durable.ts";
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

export async function setRepositoryAdmissionDurable(
  state: ControlPlaneState,
  id: string,
  admissionState: "active" | "paused",
): Promise<{ ok: true; repository: RepositoryRecord } | RepositoryAdmissionFailure> {
  if (!state.storage) return transitionInMemory(state, id, admissionState);
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
  const sessions = await state.storage.listSessionsByRepository(repository.id);
  for (const session of sessions
    .filter((item) => isActiveSessionStatus(item.status))
    .slice(0, 100)) {
    await cancelSessionDurable(state, session.id);
  }
  const remaining = await state.storage.listSessionsByRepository(repository.id);
  const worktrees = await state.storage.listWorktreesForRepo(repository.id);
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

export async function drainRepositoryDurable(
  state: ControlPlaneState,
  id: string,
): Promise<{ ok: true; repository: RepositoryRecord } | RepositoryAdmissionFailure> {
  if (!state.storage) {
    const transitioned = transitionInMemory(state, id, "draining");
    if (!transitioned.ok) return transitioned;
    for (const session of state.sessions.values()) {
      if (session.repositoryId === id && isActiveSessionStatus(session.status)) {
        const now = state.now();
        session.status = "cancelled";
        session.errorMessage = "cancelled by repository drain";
        session.completedAt = now;
      }
    }
    const completed = {
      ...transitioned.repository,
      admissionState: "paused" as const,
      admissionStateChangedAt: state.now(),
      drainCompletedAt: state.now(),
    };
    return { ok: true, repository: cache(state, completed) };
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
  if (!state.storage) return [];
  const repositories = (await state.storage.listRepositories()).filter(
    (repository) => repositoryAdmissionState(repository.admissionState) === "draining",
  );
  const reconciled: RepositoryRecord[] = [];
  for (const repository of repositories) reconciled.push(await reconcileOne(state, repository));
  return reconciled;
}
