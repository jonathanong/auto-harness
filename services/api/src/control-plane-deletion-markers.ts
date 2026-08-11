import { randomUUID } from "node:crypto";

import type { ControlPlaneState } from "./control-plane-state.ts";

type MarkerResult<T> = T | { ok: false; error: string; conflict: true };

/** Acquire all subjects in sorted order, then always release the exact ownership rows. */
export async function withDeletionMarkers<T extends { ok: boolean }>(
  state: ControlPlaneState,
  keys: readonly string[],
  operation: () => Promise<T>,
): Promise<MarkerResult<T>> {
  if (!state.storage) return operation();
  if (!("acquireDeletionMarker" in state.storage) || !("releaseDeletionMarker" in state.storage)) {
    return operation();
  }
  const owner = randomUUID();
  const acquired: string[] = [];
  try {
    for (const key of [...new Set(keys)].toSorted()) {
      if (!(await state.storage.acquireDeletionMarker(key, owner, state.now()))) {
        return { ok: false, conflict: true, error: "catalog deletion is busy; retry the request" };
      }
      acquired.push(key);
    }
    return await operation();
  } finally {
    await Promise.all(acquired.map((key) => state.storage!.releaseDeletionMarker(key, owner)));
  }
}
