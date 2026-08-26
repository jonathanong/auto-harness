import { validateCreateSessionInput } from "@auto-harness/shared";

import type { ControlPlaneState } from "./control-plane-state.ts";
import { hashString } from "./control-plane-state.ts";
import { resolveTargetDisplayNames } from "./control-plane-session-target-display-name.ts";
import type { SessionRecord } from "./db/types.ts";
import { repositoryAdmissionFailure } from "./control-plane-repository-admission-state.ts";

type ValidatedFields = Extract<
  ReturnType<typeof validateCreateSessionInput>,
  { ok: true }
>["value"];

export function validateSessionCreate(
  state: ControlPlaneState,
  body: unknown,
  options: { allowScheduleId?: boolean } = {},
):
  | {
      ok: true;
      fields: ValidatedFields;
      record: Record<string, unknown>;
      targetDisplayNames: string[];
      scheduleId?: string;
    }
  | { ok: false; error: string; code?: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "body must be an object" };
  }
  const record = body as Record<string, unknown>;
  const validated = validateCreateSessionInput({
    repositoryId: record.repositoryId,
    prompt: record.prompt,
    target: record.target,
    fallbacks: record.fallbacks,
    queueTtlSeconds: record.queueTtlSeconds,
    timeout: record.timeout,
    priority: record.priority,
    requiredLabels: record.requiredLabels,
    ref: record.ref,
    concurrencyId: record.concurrencyId,
    metadata: record.metadata,
    type: record.type,
    source: record.source,
  });
  if (!validated.ok) return validated;
  const admissionFailure = repositoryAdmissionFailure(state, validated.value.repositoryId);
  if (admissionFailure) return admissionFailure;
  const targets = resolveTargetDisplayNames(
    state,
    validated.value.target,
    validated.value.fallbacks,
  );
  if (!targets.ok) return { ok: false, error: targets.error, code: "VALIDATION_ERROR" };
  return {
    ok: true,
    fields: validated.value,
    record,
    targetDisplayNames: targets.displayNames,
    ...(options.allowScheduleId && typeof record.scheduleId === "string"
      ? { scheduleId: record.scheduleId }
      : {}),
  };
}

export function buildSessionRecord(
  state: ControlPlaneState,
  prepared: Extract<ReturnType<typeof validateSessionCreate>, { ok: true }>,
  principalId?: string,
): SessionRecord {
  const { fields: v } = prepared;
  const id = state.idFactory();
  const createdAt = state.now();
  return {
    id,
    repositoryId: v.repositoryId,
    prompt: v.prompt,
    target: v.target,
    fallbacks: v.fallbacks,
    targetDisplayNames: prepared.targetDisplayNames,
    queueTtlSeconds: v.queueTtlSeconds,
    queueExpiresAt: new Date(Date.parse(createdAt) + v.queueTtlSeconds * 1000).toISOString(),
    timeout: v.timeout,
    priority: v.priority,
    requiredLabels: v.requiredLabels,
    status: "queued",
    queueShard: Math.abs(hashString(id)) % state.shardCount,
    createdAt,
    ...(v.ref !== undefined ? { ref: v.ref } : {}),
    ...(v.concurrencyId !== undefined ? { concurrencyId: v.concurrencyId } : {}),
    ...(prepared.scheduleId !== undefined ? { scheduleId: prepared.scheduleId } : {}),
    ...(v.metadata !== undefined ? { metadata: v.metadata } : {}),
    ...(principalId ? { principalId } : {}),
    type: v.type,
    source: v.source,
  };
}
