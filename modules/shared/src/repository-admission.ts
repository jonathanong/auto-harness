export const REPOSITORY_ADMISSION_STATES = ["active", "paused", "draining"] as const;

export type RepositoryAdmissionState = (typeof REPOSITORY_ADMISSION_STATES)[number];

/** Rows written before repository admission controls are treated as active. */
export function repositoryAdmissionState(value: unknown): RepositoryAdmissionState {
  return value === "paused" || value === "draining" ? value : "active";
}

export function repositoryAdmissionClosedMessage(state: RepositoryAdmissionState): string {
  return `repository admission is ${state}`;
}
