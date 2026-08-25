export type TargetRef =
  | { commandId: string; providerId?: never }
  | { providerId: string; commandId?: never };

/** Values accepted for a session metadata entry. */
export type SessionMetadataValue = string | number | boolean | null;

/** Whether a session was created directly or fired by a schedule. */
export type SessionType = "prompt" | "scheduled";

/** Origin that requested the session. */
export type SessionSource = "api" | "ui" | "webhook" | "schedule";

/** `source` values `POST /sessions` honors; anything else collapses to `"api"`. */
export type CreatableSessionSource = "api" | "ui" | "webhook";

export type CreateSessionInput = {
  repositoryId: string;
  prompt: string;
  target: TargetRef;
  fallbacks?: TargetRef[];
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

/** Body accepted by `POST /sessions/:id/resume`. */
export type ResumeSessionInput = {
  prompt?: string;
  concurrencyId?: string;
  timeout?: number;
  priority?: number;
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

/** Bounded, durable progress for the authenticated principal's repository session drain. */
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

export type AutoHarnessClientOptions = {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
  /** Per-request deadline in milliseconds (default 30,000; maximum 300,000). */
  requestTimeoutMs?: number;
};

export class AutoHarnessClient {
  constructor(options: AutoHarnessClientOptions);
  createSession(input: CreateSessionInput): Promise<Session & { created: boolean }>;
  getSession(id: string): Promise<Session>;
  cancelSession(id: string): Promise<Session>;
  resumeSession(id: string, input?: ResumeSessionInput): Promise<Session>;
  listSessions(options?: ListSessionsOptions): Promise<SessionPage>;
  startSessionDrain(
    repositoryId: string,
    options?: { idempotencyKey?: string },
  ): Promise<SessionDrain>;
  getSessionDrain(repositoryId: string, operationId: string): Promise<SessionDrain>;
  releaseSessionDrain(repositoryId: string, operationId: string): Promise<SessionDrain>;
  listRepositories(options?: ListRepositoriesOptions): Promise<RepositoryPage>;
  pauseRepository(id: string): Promise<Repository>;
  drainRepository(id: string): Promise<Repository>;
  activateRepository(id: string): Promise<Repository>;
}
