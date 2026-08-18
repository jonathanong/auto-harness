import type { ControlPlaneState } from "./control-plane-state.ts";
import type { ArchiveMetadata, ArchiveObject } from "./control-plane-types.ts";

export async function archiveSessionLogs(
  state: ControlPlaneState,
  sessionId: string,
): Promise<ArchiveObject> {
  // Only this session's log writes. Awaiting every pending log write made archive cost
  // scale with total output since process start rather than with the session's own.
  await Promise.all(state.pendingLogPersists.get(sessionId) ?? []);
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
