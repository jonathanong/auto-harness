import { describe, expect, it } from "vitest";

import { isValidScheduledBranchRef } from "./scheduled-branch-ref.ts";

describe("isValidScheduledBranchRef", () => {
  it("accepts ordinary branch names", () => {
    expect(isValidScheduledBranchRef("main")).toBe(true);
    expect(isValidScheduledBranchRef("feature/scheduled-maintenance")).toBe(true);
    expect(isValidScheduledBranchRef("release/v1.2")).toBe(true);
  });

  it("rejects Git-invalid, tag-ref, and SHA-like revisions", () => {
    for (const value of [
      "",
      "HEAD",
      "@",
      "refs/tags/v1.2.3",
      "refs/heads/main",
      "2c2d2d2",
      "a".repeat(40),
      "feature..broken",
      "feature/.hidden",
      "feature/topic.lock",
      "feature/",
      "feature name",
      "feature\\name",
      "feature\u007fbroken",
      "feature@{1}",
      "-branch",
      "a".repeat(256),
    ]) {
      expect(isValidScheduledBranchRef(value)).toBe(false);
    }
  });
});
