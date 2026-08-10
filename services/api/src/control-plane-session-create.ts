import { validateCreateSessionInput } from "@auto-harness/shared";

import type { ControlPlaneState } from "./control-plane-state.ts";
import { hashString } from "./control-plane-state.ts";
import { resolveSessionTargetLabel } from "./control-plane-session-target-label.ts";
import type { SessionRecord } from "./db/types.ts";

type ValidatedFields = Extract<
  ReturnType<typeof validateCreateSessionInput>,
  { ok: true }
>["value"];

export function validateSessionCreate(
  state: ControlPlaneState,
  body: unknown,
):
  | { ok: true; fields: ValidatedFields; record: Record<string, unknown>; targetLabel: string }
  | { ok: false; error: string; code?: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "body must be an object" };
  }
  const record = body as Record<string, unknown>;
  const validated = validateCreateSessionInput({
    repositoryId: record.repositoryId,
    prompt: record.prompt,
    providerAccountId: record.providerAccountId,
    commandId: record.commandId,
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
  const target = resolveSessionTargetLabel(
    state,
    validated.value.providerAccountId,
    validated.value.commandId,
  );
  if (!target.ok) return { ok: false, error: target.error, code: "VALIDATION_ERROR" };
  return { ok: true, fields: validated.value, record, targetLabel: target.label };
}

export function buildSessionRecord(
  state: ControlPlaneState,
  prepared: Extract<ReturnType<typeof validateSessionCreate>, { ok: true }>,
): SessionRecord {
  const { fields: v, record } = prepared;
  const id = state.idFactory();
  return {
    id,
    repositoryId: v.repositoryId,
    prompt: v.prompt,
    ...(v.providerAccountId !== undefined ? { providerAccountId: v.providerAccountId } : {}),
    ...(v.commandId !== undefined ? { commandId: v.commandId } : {}),
    targetLabel: prepared.targetLabel,
    timeout: v.timeout,
    priority: v.priority,
    requiredLabels: v.requiredLabels,
    status: "queued",
    queueShard: Math.abs(hashString(id)) % state.shardCount,
    createdAt: state.now(),
    retryCount: 0,
    ...(v.ref !== undefined ? { ref: v.ref } : {}),
    ...(v.concurrencyId !== undefined ? { concurrencyId: v.concurrencyId } : {}),
    ...(v.metadata !== undefined ? { metadata: v.metadata } : {}),
    type: v.type,
    source: v.source,
  };
}
