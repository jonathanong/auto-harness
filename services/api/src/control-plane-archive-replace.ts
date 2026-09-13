import type { ControlPlaneState } from "./control-plane-state.ts";
import type { ArchiveMetadata } from "./control-plane-types.ts";

type ArchiveGeneration = {
  versionId?: string;
  updatedAt: string;
};

export function isCompleteStoredArchive(
  metadata: ArchiveMetadata | null | undefined,
): metadata is ArchiveMetadata {
  return metadata?.status === "complete" && metadata.objectStored === true;
}

export function archiveGeneration(metadata: ArchiveMetadata): ArchiveGeneration {
  return metadata.versionId
    ? { versionId: metadata.versionId, updatedAt: metadata.updatedAt }
    : { updatedAt: metadata.updatedAt };
}

function matchesArchiveGeneration(
  current: ArchiveMetadata | null | undefined,
  expected: ArchiveGeneration,
): boolean {
  if (!isCompleteStoredArchive(current)) return false;
  if (expected.versionId) return current.versionId === expected.versionId;
  return current.versionId === undefined && current.updatedAt === expected.updatedAt;
}

export async function readArchiveMetadata(
  state: ControlPlaneState,
  key: string,
): Promise<ArchiveMetadata | null> {
  if (state.storage && typeof state.storage.getArchive === "function") {
    const stored = await state.storage.getArchive(key);
    if (stored) state.archives.set(key, stored);
    return stored;
  }
  return state.archives.get(key) ?? null;
}

/** Publish replacement complete metadata only while the previous complete generation still wins. */
export async function publishCompleteArchiveReplacement(
  state: ControlPlaneState,
  complete: ArchiveMetadata,
  expected: ArchiveGeneration,
): Promise<boolean> {
  if (state.storage && typeof state.storage.replaceCompleteArchive === "function") {
    const published = await state.storage.replaceCompleteArchive(complete, expected);
    if (published) state.archives.set(complete.key, complete);
    return published;
  }
  const current =
    state.storage && typeof state.storage.getArchive === "function"
      ? await state.storage.getArchive(complete.key)
      : state.archives.get(complete.key);
  if (!matchesArchiveGeneration(current, expected)) return false;
  if (state.storage) await state.storage.putArchive(complete);
  state.archives.set(complete.key, complete);
  return true;
}
