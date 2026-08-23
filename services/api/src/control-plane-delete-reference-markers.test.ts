import { describe, expect, it } from "vitest";

import {
  principalDeletionMarker,
  referenceMarkers,
} from "./control-plane-delete-reference-markers.ts";

describe("principal deletion markers", () => {
  it("fences durable authenticated ownership but not the local system actor", () => {
    expect(principalDeletionMarker(undefined)).toBeUndefined();
    expect(principalDeletionMarker("system")).toBeUndefined();
    expect(principalDeletionMarker("user:alice")).toBe("principal:user:alice");

    expect(
      referenceMarkers("2026-08-23T00:00:00.000Z", {
        repositoryId: "repo",
        principalId: "user:alice",
      }),
    ).toEqual([
      { key: "principal:user:alice", now: "2026-08-23T00:00:00.000Z" },
      { key: "repository:repo", now: "2026-08-23T00:00:00.000Z" },
    ]);
  });
});
