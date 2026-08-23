export type TargetRef =
  | { commandId: string; providerId?: never }
  | { providerId: string; commandId?: never };

export type CreateSessionInput = {
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
  metadata?: Record<string, unknown>;
};

export type Session = CreateSessionInput & {
  id: string;
  status: string;
  createdAt: string;
  url: string;
  created?: boolean;
};

export type Repository = {
  id: string;
  name: string;
  url: string;
  defaultBranch: string;
  admissionState?: "active" | "paused" | "draining";
  admissionStateChangedAt?: string;
  drainRequestedAt?: string;
  drainCompletedAt?: string;
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

export class AutoHarnessClient {
  constructor(options: { baseUrl: string; apiKey?: string; fetch?: typeof fetch });
  createSession(input: CreateSessionInput): Promise<Session & { created: boolean }>;
  getSession(id: string): Promise<Session>;
  cancelSession(id: string): Promise<Session>;
  startSessionDrain(
    repositoryId: string,
    options?: { idempotencyKey?: string },
  ): Promise<SessionDrain>;
  getSessionDrain(repositoryId: string, operationId: string): Promise<SessionDrain>;
  releaseSessionDrain(repositoryId: string, operationId: string): Promise<SessionDrain>;
  listRepositories(): Promise<{ items: Repository[] }>;
  pauseRepository(id: string): Promise<Repository>;
  drainRepository(id: string): Promise<Repository>;
  activateRepository(id: string): Promise<Repository>;
}
