import { randomUUID } from "node:crypto";

import type { ControlPlaneState } from "./control-plane-state.ts";

type MarkerResult<T> = T | { ok: false; error: string; conflict: true };

/** Acquire all subjects in sorted order, then always release the exact ownership rows. */
export async function withDeletionMarkers<T extends { ok: boolean }>(
  state: ControlPlaneState,
  keys: readonly string[],
  operation: (owner: string) => Promise<T>,
): Promise<MarkerResult<T>> {
  if (!state.storage) return operation("");
  if (!("acquireDeletionMarker" in state.storage) || !("releaseDeletionMarker" in state.storage)) {
    return operation("");
  }
  const owner = randomUUID();
  const acquired: string[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let leaseLost = false;
  try {
    for (const key of [...new Set(keys)].toSorted()) {
      if (!(await state.storage.acquireDeletionMarker(key, owner, state.now()))) {
        return { ok: false, conflict: true, error: "catalog deletion is busy; retry the request" };
      }
      acquired.push(key);
    }
    if ("renewDeletionMarker" in state.storage) {
      timer = setInterval(() => {
        void Promise.all(
          acquired.map((key) => state.storage!.renewDeletionMarker!(key, owner, state.now())),
        )
          .then((renewed) => {
            if (renewed.some((ok) => !ok)) leaseLost = true;
          })
          .catch(() => {
            leaseLost = true;
          });
      }, 5_000);
    }
    const result = await operation(owner);
    return leaseLost
      ? { ok: false, conflict: true, error: "catalog deletion lease was lost; retry the request" }
      : result;
  } finally {
    if (timer) clearInterval(timer);
    await Promise.all(
      acquired.map(async (key) => {
        try {
          await state.storage!.releaseDeletionMarker(key, owner);
        } catch {
          // A best-effort release must not hide the completed delete result.
        }
      }),
    );
  }
}
