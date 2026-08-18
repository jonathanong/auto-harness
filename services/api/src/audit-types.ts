import type { Principal, Role } from "./auth-types.ts";

export type AuditOutcome = "success" | "denied" | "failed";

export type AuditActor = {
  id: string;
  kind: Principal["kind"] | "system" | "anonymous";
  role: Role | "system" | "anonymous";
};

/** Intentionally small JSON subset: audit events are not a second log store. */
export type AuditMetadata = Record<string, boolean | number | string | string[]>;

export type AuditLogRecord = {
  id: string;
  createdAt: string;
  actor: AuditActor;
  action: string;
  resourceType: string;
  resourceId: string;
  // `| undefined` since callers commonly forward an already-optional value verbatim
  // (e.g. a possibly-null resource's repositoryId, or a parsed query-string param).
  repositoryId?: string | undefined;
  outcome: AuditOutcome;
  metadata: AuditMetadata;
};

export type AuditLogInput = Omit<AuditLogRecord, "id" | "createdAt" | "metadata"> & {
  metadata?: Record<string, unknown>;
};

export type AuditLogListQuery = {
  limit?: number;
  cursor?: string | undefined;
  actorId?: string | undefined;
  action?: string | undefined;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  repositoryId?: string | undefined;
  outcome?: AuditOutcome;
};

export type AuditLogPage = {
  items: AuditLogRecord[];
  nextCursor?: string | undefined;
};
