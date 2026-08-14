import type { ControlPlaneState } from "./control-plane-state.ts";
import type { ArchiveMetadata, ArchiveObject } from "./control-plane-types.ts";

export async function archiveSessionLogs(
  state: ControlPlaneState,
  sessionId: string,
): Promise<ArchiveObject> {
  const precedingLogWrites = [...state.pendingLogPersists];
  await Promise.all(precedingLogWrites);
  const logs = state.storage
    ? await state.storage.listLogs(sessionId)
    : [...(state.logs.get(sessionId) ?? [])];
  const body = logs
    .map(({ timestamp, stream, content }) => JSON.stringify({ timestamp, stream, content }))
    .join("\n");
  const object: ArchiveObject = {
    key: `${state.archivePrefix}${sessionId}/logs.jsonl`,
    body: body ? `${body}\n` : "",
    contentType: "application/x-ndjson",
  };
  const pending: ArchiveMetadata = {
    key: object.key,
    contentType: object.contentType,
    bodyBytes: Buffer.byteLength(object.body),
    status: "pending",
    objectStored: false,
    updatedAt: state.now(),
  };
  if (state.storage) await state.storage.putArchive(pending);
  state.archives.set(object.key, pending);
  if (state.archiveWriter) await state.archiveWriter.putArchive(object);
  const complete: ArchiveMetadata = {
    ...pending,
    status: "complete",
    objectStored: state.archiveWriter !== undefined,
    updatedAt: state.now(),
  };
  if (state.storage) await state.storage.putArchive(complete);
  state.archives.set(object.key, complete);
  return object;
}

/** Retry an interrupted object upload after the session transition already committed. */
export async function retrySessionArchiveIfNeeded(
  state: ControlPlaneState,
  sessionId: string,
): Promise<void> {
  if (!state.archiveWriter) return;
  const key = `${state.archivePrefix}${sessionId}/logs.jsonl`;
  const metadata = state.storage ? await state.storage.getArchive(key) : state.archives.get(key);
  if (metadata?.status === "complete" && metadata.objectStored) return;
  await archiveSessionLogs(state, sessionId);
}

export function queueSessionArchive(state: ControlPlaneState, sessionId: string): void {
  state.pendingPersists.push(archiveSessionLogs(state, sessionId));
}

export function getArchive(state: ControlPlaneState, sessionId: string): ArchiveMetadata | null {
  return state.archives.get(`${state.archivePrefix}${sessionId}/logs.jsonl`) ?? null;
}

export function listArchives(state: ControlPlaneState): ArchiveMetadata[] {
  return [...state.archives.values()];
}
