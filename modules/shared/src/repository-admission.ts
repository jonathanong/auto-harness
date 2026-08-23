export const REPOSITORY_ADMISSION_STATES = ["active", "paused", "draining"] as const;

export type RepositoryAdmissionState = (typeof REPOSITORY_ADMISSION_STATES)[number];

/** Rows written before repository admission controls are treated as active. */
export function repositoryAdmissionState(value: unknown): RepositoryAdmissionState {
  if (value === undefined || value === "active") return "active";
  if (value === "paused" || value === "draining") return value;
  throw new TypeError("invalid repository admission state");
}

export function repositoryAdmissionClosedMessage(state: RepositoryAdmissionState): string {
  return `repository admission is ${state}`;
}
