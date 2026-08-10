import { isValidScheduledBranchRef } from "@auto-harness/shared";

import type { ScheduleRecord } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";
import { resolveSessionTargetLabel } from "./control-plane-session-target-label.ts";

export {
  evaluateCron,
  evaluateCronDurable,
  triggerSchedule,
  triggerScheduleDurable,
  tryClaimScheduleFire,
  tryClaimScheduleFireDurable,
} from "./control-plane-schedule-fire.ts";

export function putSchedule(
  state: ControlPlaneState,
  input: {
    repositoryId: string;
    name: string;
    providerAccountId?: string;
    commandId?: string;
    cron: string;
    timeout: number;
    nextRunAt: string;
    enabled?: boolean;
    ref?: string;
    id?: string;
  },
): { ok: true; schedule: ScheduleRecord } | { ok: false; error: string } {
  if (input.ref !== undefined && !isValidScheduledBranchRef(input.ref)) {
    return { ok: false, error: "ref must be a valid scheduled branch name" };
  }
  const target = resolveSessionTargetLabel(state, input.providerAccountId, input.commandId);
  if (!target.ok) {
    return target;
  }
  const id = input.id ?? state.scheduleIdFactory();
  const rec: ScheduleRecord = {
    id,
    repositoryId: input.repositoryId,
    name: input.name,
    ...(input.providerAccountId !== undefined
      ? { providerAccountId: input.providerAccountId }
      : {}),
    ...(input.commandId !== undefined ? { commandId: input.commandId } : {}),
    targetLabel: target.label,
    cron: input.cron,
    enabled: input.enabled ?? true,
    timeout: input.timeout,
    nextRunAt: input.nextRunAt,
    lastRunAt: null,
    createdAt: state.now(),
    ...(input.ref !== undefined ? { ref: input.ref } : {}),
  };
  state.schedules.set(id, rec);
  if (state.storage) {
    queueWrite(state, state.storage.putSchedule({ ...rec }));
  }
  return { ok: true, schedule: { ...rec } };
}

export function getSchedule(state: ControlPlaneState, id: string): ScheduleRecord | null {
  const s = state.schedules.get(id);
  return s ? { ...s } : null;
}

export function listSchedules(state: ControlPlaneState): ScheduleRecord[] {
  return [...state.schedules.values()].map((s) => ({ ...s }));
}

export function updateSchedule(
  state: ControlPlaneState,
  id: string,
  patch: Partial<{
    name: string;
    providerAccountId: string;
    commandId: string;
    cron: string;
    timeout: number;
    nextRunAt: string;
    enabled: boolean;
    ref: string;
    repositoryId: string;
  }>,
): { ok: true; schedule: ScheduleRecord } | { ok: false; error: string } {
  const existing = state.schedules.get(id);
  if (!existing) {
    return { ok: false, error: "schedule not found" };
  }
  if (patch.ref !== undefined && !isValidScheduledBranchRef(patch.ref)) {
    return { ok: false, error: "ref must be a valid scheduled branch name" };
  }
  // Retargeting (either field patched) resets the *other* field — the two are
  // mutually exclusive, so switching to a commandId clears any providerAccountId
  // inherited from `existing`, and vice versa.
  const retargeting = patch.providerAccountId !== undefined || patch.commandId !== undefined;
  let targetLabel = existing.targetLabel;
  if (retargeting) {
    const target = resolveSessionTargetLabel(state, patch.providerAccountId, patch.commandId);
    if (!target.ok) {
      return target;
    }
    targetLabel = target.label;
  }
  const next: ScheduleRecord = {
    ...existing,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    targetLabel,
    ...(patch.cron !== undefined ? { cron: patch.cron } : {}),
    ...(patch.timeout !== undefined ? { timeout: patch.timeout } : {}),
    ...(patch.nextRunAt !== undefined ? { nextRunAt: patch.nextRunAt } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.repositoryId !== undefined ? { repositoryId: patch.repositoryId } : {}),
    ...(patch.ref !== undefined ? { ref: patch.ref } : {}),
  };
  if (retargeting) {
    delete next.providerAccountId;
    delete next.commandId;
    if (patch.providerAccountId !== undefined) {
      next.providerAccountId = patch.providerAccountId;
    }
    if (patch.commandId !== undefined) {
      next.commandId = patch.commandId;
    }
  }
  state.schedules.set(id, next);
  if (state.storage) {
    queueWrite(state, state.storage.putSchedule({ ...next }));
  }
  return { ok: true, schedule: { ...next } };
}

export function deleteSchedule(
  state: ControlPlaneState,
  id: string,
): { ok: true } | { ok: false; error: string } {
  if (!state.schedules.has(id)) {
    return { ok: false, error: "schedule not found" };
  }
  state.schedules.delete(id);
  if (state.storage) {
    queueWrite(state, state.storage.deleteSchedule(id));
  }
  return { ok: true };
}
