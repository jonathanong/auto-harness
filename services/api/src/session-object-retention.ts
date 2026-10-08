import { DeleteObjectsCommand, ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import { isSessionLogObjectKey } from "@auto-harness/shared";
import { isSessionArtifactKey } from "./session-artifact-key.ts";

export type SessionObjectDeletionPage = { deleted: number; done: boolean };

type ObjectStore = {
  send(command: unknown, options?: { abortSignal: AbortSignal }): Promise<unknown>;
};

/** Delete one bounded page. Removed versions disappear from the next page's work set. */
export async function deleteSessionObjectVersionsPage(
  client: ObjectStore,
  bucket: string,
  sessionId: string,
  limit: number,
): Promise<SessionObjectDeletionPage> {
  if (!sessionId || sessionId.includes("/") || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("invalid session object deletion page");
  }
  const prefix = `sessions/${sessionId}/`;
  const result = (await client.send(
    new ListObjectVersionsCommand({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: Math.min(limit, 1000),
    }),
    { abortSignal: AbortSignal.timeout(5_000) },
  )) as {
    Versions?: Array<{ Key?: string; VersionId?: string }>;
    DeleteMarkers?: Array<{ Key?: string; VersionId?: string }>;
    IsTruncated?: boolean;
  };
  const objects = [...(result.Versions ?? []), ...(result.DeleteMarkers ?? [])].map((entry) => {
    if (
      !entry.Key?.startsWith(prefix) ||
      !(isSessionLogObjectKey(entry.Key) || isSessionArtifactKey(entry.Key, sessionId)) ||
      !entry.VersionId
    ) {
      throw new Error("refusing an invalid session object version");
    }
    return { Key: entry.Key, VersionId: entry.VersionId };
  });
  if (objects.length === 0) {
    if (result.IsTruncated)
      throw new Error("object version listing returned an empty truncated page");
    return { deleted: 0, done: true };
  }
  if (objects.length > Math.min(limit, 1000))
    throw new Error("object version listing exceeded its limit");
  const deleted = (await client.send(
    new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
    { abortSignal: AbortSignal.timeout(5_000) },
  )) as { Errors?: unknown[] };
  if (deleted.Errors?.length) throw new Error("session object version deletion was incomplete");
  // A later empty list verifies completion, including after partial failures or process death.
  return { deleted: objects.length, done: false };
}
