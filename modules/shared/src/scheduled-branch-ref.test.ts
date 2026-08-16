import { describe, expect, it } from "vitest";

import { isValidScheduledBranchRef, isValidSessionRef } from "./scheduled-branch-ref.ts";

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

/**
 * The manual session `ref` field reaches `git rev-parse --verify --end-of-options <ref>`
 * in worktree-manager.ts. Unlike the scheduled-branch check, it must accept a revision
 * expression, not just a branch name — a one-shot session can legitimately target a
 * specific commit — while still rejecting shapes that would be argv-hostile if the
 * `--end-of-options` defense were ever bypassed or ported elsewhere.
 */
describe("isValidSessionRef", () => {
  it("accepts branch names, SHAs, HEAD-relative, and fully-qualified refs", () => {
    for (const value of [
      "main",
      "feature/scheduled-maintenance",
      "2c2d2d2",
      "a".repeat(40),
      "HEAD",
      "HEAD~1",
      "HEAD^2",
      "@",
      "main^{commit}",
      "refs/tags/v1.2.3",
      "refs/heads/main",
    ]) {
      expect(isValidSessionRef(value)).toBe(true);
    }
  });

  it("rejects argv-flag-shaped and otherwise unsafe refs", () => {
    for (const value of [
      "",
      "-branch",
      "--upload-pack=evil",
      "feature..broken",
      "feature/.hidden",
      "feature/topic.lock",
      "feature/",
      "/feature",
      "feature//broken",
      "feature.",
      "feature name",
      "featurebroken",
      "feature@{1}",
      "a".repeat(256),
    ]) {
      expect(isValidSessionRef(value)).toBe(false);
    }
    expect(isValidSessionRef(1)).toBe(false);
    expect(isValidSessionRef(null)).toBe(false);
    expect(isValidSessionRef(undefined)).toBe(false);
  });
});
