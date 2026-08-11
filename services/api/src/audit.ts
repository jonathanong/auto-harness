import { randomBytes } from "node:crypto";

import type { Principal } from "./auth-types.ts";
import type { AuditActor, AuditLogInput, AuditLogRecord, AuditMetadata } from "./audit-types.ts";

const MAX_METADATA_ENTRIES = 16;
const MAX_METADATA_STRING_LENGTH = 256;
const SECRET_FIELD =
  /(?:pass(?:word)?|token|secret|prompt|content|log|authorization|cookie|api.?key|private.?key)/i;

export function auditActor(principal: Principal | undefined): AuditActor {
  if (!principal) return { id: "anonymous", kind: "anonymous", role: "anonymous" };
  return { id: principal.id, kind: principal.kind, role: principal.role };
}

export const SYSTEM_AUDIT_ACTOR: AuditActor = {
  id: "system",
  kind: "system",
  role: "system",
};

/**
 * Keep sensitive request payloads out of an audit event even if a caller
 * accidentally passes one. Audit metadata is deliberately flat and bounded.
 */
export function sanitizeAuditMetadata(input: Record<string, unknown> | undefined): AuditMetadata {
  if (!input) return {};
  const output: AuditMetadata = {};
  for (const [key, value] of Object.entries(input)) {
    if (Object.keys(output).length >= MAX_METADATA_ENTRIES || SECRET_FIELD.test(key)) continue;
    if (typeof value === "boolean") output[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) output[key] = value;
    else if (typeof value === "string") output[key] = value.slice(0, MAX_METADATA_STRING_LENGTH);
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      output[key] = value.slice(0, 16).map((item) => item.slice(0, MAX_METADATA_STRING_LENGTH));
    }
  }
  return output;
}

export function newAuditRecord(
  input: AuditLogInput,
  now: string,
  id = `audit-${randomBytes(12).toString("hex")}`,
): AuditLogRecord {
  return {
    id,
    createdAt: now,
    actor: input.actor,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    ...(input.repositoryId !== undefined ? { repositoryId: input.repositoryId } : {}),
    outcome: input.outcome,
    metadata: sanitizeAuditMetadata(input.metadata),
  };
}
