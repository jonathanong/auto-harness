import type { ControlPlaneState } from "./control-plane-state.ts";
import type { ArchiveMetadata } from "./control-plane-types.ts";
import { SESSION_LOGS_TTL_SECONDS } from "./db/dynamo.ts";

type ArchiveExpirePersistResult = "expired" | "complete" | "pending";

/** True when the newest finite anchor is at least one log-retention window behind `now`. */
export function archiveRetentionElapsed(now: string, anchors: Array<string | undefined>): boolean {
  const parsedAnchors = anchors
    .filter((anchor): anchor is string => anchor !== undefined)
    .map(Date.parse)
    .filter(Number.isFinite);
  const retainedAtMs = parsedAnchors.length ? Math.max(...parsedAnchors) : Number.NaN;
  const nowMs = Date.parse(now);
  return (
    Number.isFinite(retainedAtMs) &&
    Number.isFinite(nowMs) &&
    nowMs >= retainedAtMs + SESSION_LOGS_TTL_SECONDS * 1_000
  );
}

export function expiredArchiveMetadata(
  current: ArchiveMetadata,
  updatedAt: string,
): ArchiveMetadata {
  const expired: ArchiveMetadata = {
    ...current,
    status: "expired",
    objectStored: false,
    updatedAt,
  };
  delete expired.retryState;
  delete expired.retryOrder;
  return expired;
}

function mirrorExpired(state: ControlPlaneState, key: string, current: ArchiveMetadata): void {
  state.archives.set(key, expiredArchiveMetadata(current, state.now()));
}

/** Persist a terminal expired fence, or report that a complete winner already exists. */
export async function persistExpiredArchive(
  state: ControlPlaneState,
  key: string,
  metadata: ArchiveMetadata,
): Promise<ArchiveExpirePersistResult> {
  if (metadata.status === "complete") return "complete";
  if (metadata.status === "expired") {
    mirrorExpired(state, key, metadata);
    return "expired";
  }
  const storage = state.storage;
  if (storage && typeof storage.expireArchive === "function") {
    try {
      if (await storage.expireArchive(key, state.now())) {
        mirrorExpired(state, key, metadata);
        return "expired";
      }
    } catch {
      return "pending";
    }
    const latest = await storage.getArchive(key);
    if (latest) state.archives.set(key, latest);
    if (latest?.status === "expired") return "expired";
    if (latest?.status === "complete") return "complete";
    return "pending";
  }
  const current = state.archives.get(key) ?? metadata;
  if (current.status === "complete") return "complete";
  mirrorExpired(state, key, current);
  return "expired";
}
