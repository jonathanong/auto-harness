import type { ControlPlaneState } from "./control-plane-state.ts";
import { prepareUpdateSchedule, updateSchedule } from "./control-plane-schedules.ts";
import {
  getScheduleDurable,
  refreshTargetCatalogDurable,
} from "./control-plane-durable-read-catalog.ts";
import { referenceMarkers } from "./control-plane-delete-reference-markers.ts";

/** Persist a schedule update before replacing the cache entry. */
export async function updateScheduleDurable(
  state: ControlPlaneState,
  id: string,
  patch: Parameters<typeof updateSchedule>[2],
): Promise<ReturnType<typeof updateSchedule>> {
  if (!state.storage) return updateSchedule(state, id, patch);
  await getScheduleDurable(state, id);
  await refreshTargetCatalogDurable(state);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = state.schedules.get(id);
    if (!existing) return { ok: false, error: "schedule not found" };
    const result = prepareUpdateSchedule(state, id, patch);
    if (!result.ok) return result;
    const saved = await state.storage.updateScheduleManagement(
      { ...result.schedule },
      existing.nextRunAt,
      referenceMarkers(state.now(), result.schedule),
    );
    if (saved) {
      state.schedules.set(id, saved);
      return { ok: true, schedule: { ...saved } };
    }
    const authoritative = await state.storage.getSchedule(id);
    if (!authoritative) {
      state.schedules.delete(id);
      return { ok: false, error: "schedule not found" };
    }
    state.schedules.set(id, authoritative);
  }
  return { ok: false, error: "schedule changed concurrently; retry" };
}
