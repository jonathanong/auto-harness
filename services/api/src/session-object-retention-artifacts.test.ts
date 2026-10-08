import { DeleteObjectsCommand, ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import { sessionArtifactKey } from "./session-artifact-key.ts";
import { deleteSessionObjectVersionsPage } from "./session-object-retention.ts";

describe("artifact version retention", () => {
  it("drains mixed transcript and artifact versions, then verifies an empty prefix", async () => {
    const artifact = sessionArtifactKey("sess", "attempt");
    const remaining = [
      { Key: "sessions/sess/logs.jsonl.gz", VersionId: "log-v1" },
      { Key: artifact, VersionId: "artifact-v1" },
      { Key: artifact, VersionId: "artifact-marker" },
    ];
    const client = {
      send: async (command: unknown) => {
        if (command instanceof ListObjectVersionsCommand) {
          return {
            Versions: remaining
              .slice(0, 2)
              .filter((entry) => entry.VersionId !== "artifact-marker"),
            DeleteMarkers: remaining
              .slice(0, 2)
              .filter((entry) => entry.VersionId === "artifact-marker"),
            IsTruncated: remaining.length > 2,
          };
        }
        const deleted = (command as DeleteObjectsCommand).input.Delete?.Objects ?? [];
        for (const entry of deleted) {
          const index = remaining.findIndex(
            (item) => item.Key === entry.Key && item.VersionId === entry.VersionId,
          );
          if (index >= 0) remaining.splice(index, 1);
        }
        return {};
      },
    };
    expect(await deleteSessionObjectVersionsPage(client, "bucket", "sess", 2)).toEqual({
      deleted: 2,
      done: false,
    });
    expect(await deleteSessionObjectVersionsPage(client, "bucket", "sess", 2)).toEqual({
      deleted: 1,
      done: false,
    });
    expect(await deleteSessionObjectVersionsPage(client, "bucket", "sess", 2)).toEqual({
      deleted: 0,
      done: true,
    });
    expect(remaining).toEqual([]);
  });
});
