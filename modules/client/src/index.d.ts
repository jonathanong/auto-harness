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

export class AutoHarnessError extends Error {
  status: number;
  code: string;
  retryAfter?: string;
  constructor(message: string, options: { status: number; code: string; retryAfter?: string });
}

export class AutoHarnessClient {
  constructor(options: { baseUrl: string; apiKey?: string; fetch?: typeof fetch });
  createSession(input: CreateSessionInput): Promise<Session & { created: boolean }>;
  getSession(id: string): Promise<Session>;
  cancelSession(id: string): Promise<Session>;
  listRepositories(): Promise<{ items: Repository[] }>;
  pauseRepository(id: string): Promise<Repository>;
  drainRepository(id: string): Promise<Repository>;
  activateRepository(id: string): Promise<Repository>;
}
