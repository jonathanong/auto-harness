import { AutoHarnessError } from "../../index.js";

/** True for a refused delete: a 409 CONFLICT whose body carries `dependencies` (see
 * `AutoHarnessClient#request`, which puts the whole `error` body on `AutoHarnessError#details`).
 * Shared by `repo rm` and `service-account rm`, which both handle this status themselves rather
 * than letting the generic `reportError` print it as an opaque JSON blob. */
export function isDependencyConflict(error) {
  return error instanceof AutoHarnessError && error.status === 409;
}

/** The dependency array from a conflict's error body, or `[]` if absent/malformed. */
export function conflictDependencies(error) {
  const dependencies = error.details?.dependencies;
  return Array.isArray(dependencies) ? dependencies : [];
}
