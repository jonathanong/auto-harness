import { repositoryAdmissionClosedMessage, repositoryAdmissionState } from "@auto-harness/shared";

import type { ControlPlaneState } from "./control-plane-state.ts";

export type RepositoryAdmissionFailure = { ok: false; error: string; code: string };

/** Admission checks are security fences: malformed persisted state is closed, never open. */
export function repositoryAdmissionOpen(value: unknown): boolean {
  try {
    return repositoryAdmissionState(value) === "active";
  } catch {
    return false;
  }
}

export function repositoryAdmissionFailure(
  state: ControlPlaneState,
  repositoryId: string,
): RepositoryAdmissionFailure | null {
  const repository = state.repositories.get(repositoryId);
  // A repository that does not exist is a lookup failure, not a closed admission
  // gate: report it the same way as every other missing catalog reference
  // (workspace pool, provider, command) instead of the fail-closed "paused"
  // verdict below, which is reserved for a repository that exists but whose
  // persisted admission value is malformed.
  if (!repository) return { ok: false, error: "repository not found", code: "NOT_FOUND" };
  let admission: ReturnType<typeof repositoryAdmissionState>;
  try {
    admission = repositoryAdmissionState(repository.admissionState);
  } catch {
    // Unknown persisted values are not an opening. Keep the scheduler and all
    // create paths fail-closed while an operator repairs the row.
    admission = "paused" as const;
  }
  return admission === "active"
    ? null
    : {
        ok: false,
        error: repositoryAdmissionClosedMessage(admission),
        code: "REPOSITORY_ADMISSION_CLOSED",
      };
}
