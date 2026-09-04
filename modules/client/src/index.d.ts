import type { Command, Provider } from "./catalog-types.js";
export type { Command, Provider, ResumeRefCapture, UsageRates } from "./catalog-types.js";

export type TargetRef =
  | { commandId: string; providerId?: never }
  | { providerId: string; commandId?: never };

/** A provider target, by id or by `name` — normally unique, checked defensively either way. */
export type ProviderRef =
  | { providerId: string; providerName?: never; commandId?: never; commandName?: never }
  | { providerName: string; providerId?: never; commandId?: never; commandName?: never };

/** A command target, by id or by `name` — checked defensively for legacy/racy duplicates. */
export type CommandRef =
  | { commandId: string; commandName?: never; providerId?: never; providerName?: never }
  | { commandName: string; commandId?: never; providerId?: never; providerName?: never };

/**
 * Input-only target shape for `createSession()`: an id (as `TargetRef`) or a name.
 * `createSession()` resolves a name to its id via `listProviders()`/`listCommands()` before
 * sending the request; a name throws on no match or on more than one match sharing that name.
 */
export type TargetSpec = ProviderRef | CommandRef;

/** A repository target, by id or by unique `name` — checked defensively for legacy/racy duplicates. */
export type RepositoryRef =
  | { repositoryId: string; repositoryName?: never }
  | { repositoryName: string; repositoryId?: never };

/** Values accepted for a session metadata entry. */
export type SessionMetadataValue = string | number | boolean | null;

/** Whether a session was created directly or fired by a schedule. */
export type SessionType = "prompt" | "scheduled";

/** Origin that requested the session. */
export type SessionSource = "api" | "ui" | "webhook" | "schedule";

/** `source` values `POST /sessions` honors; anything else collapses to `"api"`. */
export type CreatableSessionSource = "api" | "ui" | "webhook";

export type CreateSessionInput = RepositoryRef & {
  prompt: string;
  target: TargetSpec;
  fallbacks?: TargetSpec[];
  ref?: string;
  concurrencyId?: string;
  queueTtlSeconds?: number;
  timeout: number;
  priority?: number;
  requiredLabels?: string[];
  metadata?: Record<string, SessionMetadataValue>;
  /** Defaults to `"api"`; `"ui"`/`"webhook"` pass through, anything else becomes `"api"`. */
  source?: CreatableSessionSource;
};

export type Session = {
  id: string;
  repositoryId: string;
  prompt: string;
  target: TargetRef;
  fallbacks?: TargetRef[];
  ref?: string;
  concurrencyId?: string;
  queueTtlSeconds?: number;
  timeout?: number;
  priority?: number;
  requiredLabels?: string[];
  metadata?: Record<string, SessionMetadataValue>;
  status: string;
  /** Absent on sessions persisted before this field existed. */
  type?: SessionType;
  /** Absent on sessions persisted before this field existed. */
  source?: SessionSource;
  createdAt: string;
  url: string;
  created?: boolean;
};

/** Body accepted by `POST /sessions/:id/resume`. `target`/`fallbacks` are an optional
 * rebinding override — passing `target` alone clears any inherited `fallbacks`, and
 * a bare `fallbacks` without `target` is rejected. */
export type ResumeSessionInput = {
  prompt?: string;
  concurrencyId?: string;
  timeout?: number;
  priority?: number;
  target?: TargetSpec;
  fallbacks?: TargetSpec[];
};

/** `status` filter accepted by `GET /sessions`. */
export type SessionStatusFilter =
  | "all"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type SessionListSort = "latest" | "oldest" | "priority_desc" | "priority_asc";

export type ListSessionsOptions = {
  status?: SessionStatusFilter;
  repositoryId?: string;
  hostId?: string;
  source?: SessionSource;
  sort?: SessionListSort;
  /** Number of sessions to return (1–100, default 50). */
  limit?: number;
  /** Opaque cursor returned by a previous page. */
  cursor?: string;
  concurrencyId?: string;
  scheduleId?: string;
};

export type SessionPage = {
  items: Session[];
  nextCursor: string | null;
};

export type Repository = {
  id: string;
  name: string;
  url: string;
  defaultBranch: string;
  createdAt?: string;
  updatedAt?: string;
  sessionCount?: number;
  worktreeCount?: number;
  scheduleCount?: number;
  admissionState?: "active" | "paused" | "draining";
  admissionStateChangedAt?: string;
  drainRequestedAt?: string;
  drainCompletedAt?: string;
};

export type ListRepositoriesOptions = {
  /** Number of repositories to return (1–100, default 50). */
  limit?: number;
  /** Opaque cursor returned by a previous page. */
  cursor?: string;
};

export type RepositoryPage = {
  items: Repository[];
  nextCursor: string | null;
};

export type SessionDrainStatus = "draining" | "succeeded" | "failed" | "released";

/** Bounded, durable progress for a principal session drain: cancels the authenticated principal's own queued/running sessions for one repository (not repository or host drain). */
export type SessionDrain = {
  operationId: string;
  repositoryId: string;
  status: SessionDrainStatus;
  /** API-relative URL for polling this same operation. */
  statusUrl: string;
  requestedAt: string;
  updatedAt: string;
  deadlineAt: string;
  queuedCount: number;
  runningCount: number;
  cancelledCount: number;
  completedAt?: string;
  releasedAt?: string;
  failureCode?: string;
};

/**
 * Thrown for a failed HTTP response, and also, with `status: 400`, when `createSession()` (or a
 * drain method) cannot resolve a `TargetSpec` or `RepositoryRef` name: `code ===
 * "UNKNOWN_PROVIDER_NAME"` / `"UNKNOWN_COMMAND_NAME"` / `"UNKNOWN_REPOSITORY_NAME"` for no match,
 * `"AMBIGUOUS_PROVIDER_NAME"` / `"AMBIGUOUS_COMMAND_NAME"` / `"AMBIGUOUS_REPOSITORY_NAME"` for
 * more than one match sharing a name — that message never includes the matched ids.
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

/**
 * Thrown by `waitForSessionDrain()` when its overall `timeoutMs` budget elapses.
 *
 * `repositoryId` echoes back whatever was passed to `waitForSessionDrain()`: a plain
 * repository id string, or the `RepositoryRef` (e.g. `{ repositoryName }`) that was still
 * unresolved when the deadline hit.
 */
export class AutoHarnessDrainWaitTimeoutError extends Error {
  code: "DRAIN_WAIT_TIMEOUT";
  repositoryId: string | RepositoryRef;
  operationId: string;
  timeoutMs: number;
  constructor(repositoryId: string | RepositoryRef, operationId: string, timeoutMs: number);
}

export type AutoHarnessClientOptions = {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
  /** Per-request deadline in milliseconds (default 30,000; maximum 300,000). */
  requestTimeoutMs?: number;
  /**
   * Allows a non-`https` `baseUrl` while `apiKey` is set, but only when `baseUrl`'s host is
   * genuine loopback (127.0.0.0/8, `::1`, or `localhost`) — see `isLoopbackOrigin()` in
   * `auto-harness-client/loopback`. The constructor independently verifies this and throws for
   * any non-loopback `http:` baseUrl even when this is `true`; a private-network address
   * (RFC1918) still crosses real network hardware and is not loopback. Defaults to `false`.
   */
  allowInsecureHttp?: boolean;
};

export class AutoHarnessClient {
  constructor(options: AutoHarnessClientOptions);
  createSession(input: CreateSessionInput): Promise<Session & { created: boolean }>;
  getSession(id: string): Promise<Session>;
  cancelSession(id: string): Promise<Session>;
  resumeSession(id: string, input?: ResumeSessionInput): Promise<Session & { created: boolean }>;
  listSessions(options?: ListSessionsOptions): Promise<SessionPage>;
  /** Cancels this principal's own queued/running sessions for one repository and fences new admission from it — not repository or host drain. */
  startSessionDrain(
    repositoryId: string | RepositoryRef,
    options?: { idempotencyKey?: string },
  ): Promise<SessionDrain>;
  getSessionDrain(repositoryId: string | RepositoryRef, operationId: string): Promise<SessionDrain>;
  releaseSessionDrain(
    repositoryId: string | RepositoryRef,
    operationId: string,
  ): Promise<SessionDrain>;
  /**
   * Resolves `repositoryId`, then polls `getSessionDrain()` until it reports a terminal status,
   * clamping every request — including each page fetched to resolve a `repositoryName` — to the
   * time remaining before `timeoutMs`. Resolves with the terminal `SessionDrain` for any status;
   * callers classify success themselves. Rejects with `AutoHarnessDrainWaitTimeoutError` when the
   * overall `timeoutMs` budget elapses — including when a clamped request is the thing that
   * times out at that same instant — or with `AutoHarnessRequestTimeoutError` if an individual
   * request times out while budget still remains.
   */
  waitForSessionDrain(
    repositoryId: string | RepositoryRef,
    operationId: string,
    options: { pollIntervalMs: number; timeoutMs: number },
  ): Promise<SessionDrain>;
  listRepositories(options?: ListRepositoriesOptions): Promise<RepositoryPage>;
  pauseRepository(id: string): Promise<Repository>;
  drainRepository(id: string): Promise<Repository>;
  activateRepository(id: string): Promise<Repository>;
  listProviders(): Promise<Provider[]>;
  listCommands(): Promise<Command[]>;
}
