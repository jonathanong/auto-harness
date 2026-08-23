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
  let admission: ReturnType<typeof repositoryAdmissionState>;
  try {
    admission = repositoryAdmissionState(repository?.admissionState);
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
