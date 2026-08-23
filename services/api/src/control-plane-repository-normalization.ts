import { repositoryAdmissionState } from "@auto-harness/shared";

import type { RepositoryRecord } from "./db/plane-storage.ts";

/** Apply the catalog's locked legacy and malformed-row behavior to durable reads. */
export function normalizeRepositoryRecords(
  records: Iterable<RepositoryRecord>,
): RepositoryRecord[] {
  return [...records].flatMap((repository) => {
    try {
      return [
        { ...repository, admissionState: repositoryAdmissionState(repository.admissionState) },
      ];
    } catch {
      // A malformed persisted row must not hide healthy repositories from the catalog.
      // Omit the invalid row until an operator repairs it; admission checks still fail closed.
      return [];
    }
  });
}
