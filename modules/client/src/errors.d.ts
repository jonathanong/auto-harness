/**
 * Thrown for a failed HTTP response, and also, with `status: 400`, when `createSession()`
 * cannot resolve a `TargetSpec` or `RepositoryRef` name: `code === "UNKNOWN_PROVIDER_NAME"` /
 * `"UNKNOWN_COMMAND_NAME"` / `"UNKNOWN_REPOSITORY_NAME"` for no match, `"AMBIGUOUS_PROVIDER_NAME"`
 * / `"AMBIGUOUS_COMMAND_NAME"` / `"AMBIGUOUS_REPOSITORY_NAME"` for more than one match sharing a
 * name — that message never includes the matched ids.
 */
export class AutoHarnessError extends Error {
  status: number;
  code: string;
  retryAfter?: string;
  /** Present when a 409 DRAINING admission response identifies its durable drain. */
  operationId?: string;
  /** API-relative URL for the drain that fenced this request. */
  statusUrl?: string;
  constructor(
    message: string,
    options: {
      status: number;
      code: string;
      retryAfter?: string;
      operationId?: string;
      statusUrl?: string;
    },
  );
}

export class AutoHarnessRequestTimeoutError extends Error {
  code: "REQUEST_TIMEOUT";
  timeoutMs: number;
  constructor(timeoutMs: number);
}

/** Thrown by `waitForSessionDrain()` when `timeoutMs` elapses before the drain leaves `"draining"`. */
export class AutoHarnessDrainWaitTimeoutError extends Error {
  code: "DRAIN_WAIT_TIMEOUT";
  repositoryId: string;
  operationId: string;
  timeoutMs: number;
  constructor(repositoryId: string, operationId: string, timeoutMs: number);
}
