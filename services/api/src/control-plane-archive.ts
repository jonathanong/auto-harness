import type { ControlPlaneState } from "./control-plane-state.ts";
import type { ArchiveMetadata, ArchiveObject } from "./control-plane-types.ts";

export async function archiveSessionLogs(
  state: ControlPlaneState,
  sessionId: string,
  retryClaim?: { retryState: "pending" | "processing"; retryOrder: string },
): Promise<ArchiveObject> {
  // Only this session's log writes. Awaiting every pending log write made archive cost
  // scale with total output since process start rather than with the session's own.
  await Promise.all(state.pendingLogPersists.get(sessionId) ?? []);
  const body = await archiveBody(state, sessionId);
  const object: ArchiveObject = {
    key: `${state.archivePrefix}${sessionId}/logs.jsonl`,
    body,
    contentType: "application/x-ndjson",
  };
  const pending: ArchiveMetadata = {
    key: object.key,
    contentType: object.contentType,
    bodyBytes: Buffer.byteLength(object.body),
    status: "pending",
    objectStored: false,
    updatedAt: state.now(),
    retryState: retryClaim?.retryState ?? "pending",
    retryOrder: retryClaim?.retryOrder ?? `${state.now()}#${object.key}`,
  };
  if (state.storage && !retryClaim) await state.storage.putArchive(pending);
  if (!retryClaim) state.archives.set(object.key, pending);
  if (state.archiveWriter) await state.archiveWriter.putArchive(object);
  const storedMetadata = { ...pending };
  delete storedMetadata.retryState;
  delete storedMetadata.retryOrder;
  const complete: ArchiveMetadata = {
    ...storedMetadata,
    status: "complete",
    objectStored: state.archiveWriter !== undefined,
    updatedAt: state.now(),
    ...(state.archiveWriter
      ? {}
      : { retryState: "pending" as const, retryOrder: `${state.now()}#${object.key}` }),
  };
  if (state.storage && retryClaim && typeof state.storage.completeArchiveRetry === "function") {
    const committed = await state.storage.completeArchiveRetry(complete, retryClaim.retryOrder);
    if (committed) state.archives.set(object.key, complete);
    else await restoreCompletedArchiveObject(state, object, sessionId);
  } else if (retryClaim) {
    // In-memory mode has no conditional write primitive, so apply the same fence locally.
    // A newer claim may have replaced this row while the object upload was in flight.
    const current = state.archives.get(object.key);
    if (current?.retryState === "processing" && current.retryOrder === retryClaim.retryOrder) {
      if (state.storage) await state.storage.putArchive(complete);
      state.archives.set(object.key, complete);
    } else if (current?.status === "complete" && current.objectStored) {
      await restoreCompletedArchiveObject(state, object, sessionId);
    }
  } else {
    if (state.storage) await state.storage.putArchive(complete);
    state.archives.set(object.key, complete);
  }
  return object;
}

async function archiveBody(state: ControlPlaneState, sessionId: string): Promise<string> {
  const logs = state.storage
    ? await state.storage.listLogs(sessionId)
    : [...(state.logs.get(sessionId) ?? [])];
  const body = logs
    .map(({ timestamp, stream, content }) => JSON.stringify({ timestamp, stream, content }))
    .join("\n");
  return body ? `${body}\n` : "";
}

/** A stale worker may finish its same-key upload after a newer fenced generation. */
async function restoreCompletedArchiveObject(
  state: ControlPlaneState,
  object: ArchiveObject,
  sessionId: string,
): Promise<void> {
  if (!state.archiveWriter) return;
  await state.archiveWriter.putArchive({ ...object, body: await archiveBody(state, sessionId) });
}

/** Retry an interrupted object upload after the session transition already committed. */
export async function retrySessionArchiveIfNeeded(
  state: ControlPlaneState,
  sessionId: string,
  retryClaim?: { retryState: "pending" | "processing"; retryOrder: string },
): Promise<void> {
  if (!state.archiveWriter) return;
  const key = `${state.archivePrefix}${sessionId}/logs.jsonl`;
  const metadata = state.storage ? await state.storage.getArchive(key) : state.archives.get(key);
  if (metadata?.status === "complete" && metadata.objectStored) return;
  await archiveSessionLogs(state, sessionId, retryClaim);
}

function archiveSessionId(key: string): string | null {
  const match = /^sessions\/([^/]+)\/logs\.jsonl$/.exec(key);
  return match?.[1] ?? null;
}

/** Retry at most one bounded page of durable archive metadata, isolating failures per item. */
export async function retryPendingArchives(
  state: ControlPlaneState,
  limit = 25,
  shouldContinue: () => boolean = () => true,
): Promise<number> {
  if (!state.archiveWriter) return 0;
  const storage = state.storage;
  const durableRetry = storage !== undefined && typeof storage.listPendingArchives === "function";
  let candidates: ArchiveMetadata[];
  try {
    candidates = durableRetry
      ? await storage.listPendingArchives(limit)
      : [...state.archives.values()]
          .filter(
            (metadata) =>
              !metadata.objectStored &&
              (metadata.retryState === "pending" || metadata.retryState === "processing"),
          )
          .toSorted((left, right) =>
            (left.retryOrder ?? left.key).localeCompare(right.retryOrder ?? right.key),
          )
          .slice(0, Math.min(limit, 25));
  } catch (error) {
    // A newly-created or still-backfilling GSI is temporarily unreadable; the next Cron tick
    // will retry the bounded sweep after the migration/index becomes available.
    console.error("archive retry sweep unavailable", error);
    return 0;
  }
  let retried = 0;
  for (const metadata of candidates) {
    if (!shouldContinue()) break;
    const sessionId = archiveSessionId(metadata.key);
    if (!sessionId || !metadata.retryOrder) continue;
    const claimedOrder = `${state.now()}#${metadata.key}`;
    if (durableRetry && typeof storage.claimArchiveRetry === "function") {
      const claimed = await storage.claimArchiveRetry(
        metadata.key,
        metadata.retryState ?? "pending",
        metadata.retryOrder,
        claimedOrder,
      );
      if (!claimed) continue;
    } else {
      const current = state.archives.get(metadata.key);
      if (!current || current.objectStored || current.retryOrder !== metadata.retryOrder) continue;
      state.archives.set(metadata.key, {
        ...current,
        retryState: "processing",
        retryOrder: claimedOrder,
      });
    }
    try {
      await retrySessionArchiveIfNeeded(state, sessionId, {
        retryState: "processing",
        retryOrder: claimedOrder,
      });
      retried += 1;
    } catch (error) {
      try {
        if (durableRetry && typeof storage.releaseArchiveRetry === "function") {
          await storage.releaseArchiveRetry(
            metadata.key,
            claimedOrder,
            `${state.now()}#${metadata.key}`,
          );
        } else {
          const current = state.archives.get(metadata.key);
          if (current?.retryState === "processing" && current.retryOrder === claimedOrder) {
            state.archives.set(metadata.key, {
              ...current,
              retryState: "pending",
              retryOrder: `${state.now()}#${metadata.key}`,
            });
          }
        }
      } catch (releaseError) {
        console.error(`archive retry release failed for ${metadata.key}`, releaseError);
      }
      console.error(`archive retry failed for ${metadata.key}`, error);
    }
  }
  return retried;
}

export function queueSessionArchive(state: ControlPlaneState, sessionId: string): void {
  // pendingPersists only tracks completion (drain waits on it), never the resolved
  // ArchiveObject — void it explicitly rather than pushing the value-carrying promise.
  state.pendingPersists.push(archiveSessionLogs(state, sessionId).then(() => undefined));
}

export function getArchive(state: ControlPlaneState, sessionId: string): ArchiveMetadata | null {
  return state.archives.get(`${state.archivePrefix}${sessionId}/logs.jsonl`) ?? null;
}

export function listArchives(state: ControlPlaneState): ArchiveMetadata[] {
  return [...state.archives.values()];
}
