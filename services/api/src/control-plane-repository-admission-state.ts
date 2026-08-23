import { repositoryAdmissionClosedMessage, repositoryAdmissionState } from "@auto-harness/shared";

import type { ControlPlaneState } from "./control-plane-state.ts";

export type RepositoryAdmissionFailure = { ok: false; error: string; code: string };

export function repositoryAdmissionFailure(
  state: ControlPlaneState,
  repositoryId: string,
): RepositoryAdmissionFailure | null {
  const repository = state.repositories.get(repositoryId);
  const admission = repositoryAdmissionState(repository?.admissionState);
  return admission === "active"
    ? null
    : {
        ok: false,
        error: repositoryAdmissionClosedMessage(admission),
        code: "REPOSITORY_ADMISSION_CLOSED",
      };
}
