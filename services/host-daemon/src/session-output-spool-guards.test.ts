import { describe, expect, it } from "vitest";

import {
  artifactEntryKind,
  artifactReadExceedsLimit,
  assertArtifactComponent,
  assertArtifactEntryUnchanged,
  assertArtifactParentUnchanged,
  assertArtifactReadMatches,
  assertArtifactRootUnchanged,
  assertOpenedArtifactUnchanged,
  assertRealArtifactDirectory,
  isOutputTooLarge,
  isRegularArtifactFile,
  isSafeArtifactComponent,
  outputFileChanged,
  type ArtifactStat,
  type ArtifactStatSnapshot,
} from "./session-output-spool-guards.ts";

function stat(overrides: Partial<ArtifactStat> = {}): ArtifactStat {
  return {
    dev: 1,
    ino: 2,
    size: 3,
    mtimeMs: 4,
    mode: 0,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ArtifactStatSnapshot> = {}): ArtifactStatSnapshot {
  return { dev: 1, ino: 2, size: 3, mtimeMs: 4, mode: 0, ...overrides };
}

describe("session output filesystem guards", () => {
  it("checks output sizes and detects a file that changed while read", () => {
    expect(isOutputTooLarge(10, 10)).toBe(false);
    expect(isOutputTooLarge(11, 10)).toBe(true);
    expect(outputFileChanged(stat(), stat())).toBe(false);
    expect(outputFileChanged(stat(), stat({ dev: 9 }))).toBe(true);
    expect(outputFileChanged(stat(), stat({ ino: 9 }))).toBe(true);
    expect(outputFileChanged(stat(), stat({ size: 9 }))).toBe(true);
    expect(outputFileChanged(stat(), stat({ mtimeMs: 9 }))).toBe(true);
    expect(outputFileChanged(stat(), stat({ isFile: () => false }))).toBe(true);
    expect(isRegularArtifactFile(stat())).toBe(true);
    expect(isRegularArtifactFile(stat({ isSymbolicLink: () => true }))).toBe(false);
  });

  it("rejects path components that cannot safely enter an archive tree", () => {
    expect(isSafeArtifactComponent("safe-name.txt")).toBe(true);
    expect(isSafeArtifactComponent("")).toBe(false);
    expect(isSafeArtifactComponent("..")).toBe(false);
    expect(isSafeArtifactComponent("a/b")).toBe(false);
    expect(isSafeArtifactComponent("a\\b")).toBe(false);
    expect(() => assertArtifactComponent("nested/name", "unsafe component")).toThrow(
      "unsafe component",
    );
    expect(() => assertArtifactComponent("safe-name", "unsafe component")).not.toThrow();
  });

  it("validates real directory and stable root snapshots", () => {
    expect(() =>
      assertRealArtifactDirectory(stat({ isDirectory: () => true }), "directory"),
    ).not.toThrow();
    expect(() => assertRealArtifactDirectory(stat(), "directory")).toThrow("directory");
    const root = { path: "/spool/artifacts", dev: 1, ino: 2 };
    expect(() => assertArtifactRootUnchanged(root, root, "root changed")).not.toThrow();
    expect(() => assertArtifactRootUnchanged(root, { ...root, ino: 3 }, "root changed")).toThrow(
      "root changed",
    );
    expect(() => assertArtifactRootUnchanged(root, { ...root, dev: 3 }, "root changed")).toThrow(
      "root changed",
    );
    expect(() =>
      assertArtifactRootUnchanged(root, { ...root, path: "/elsewhere" }, "root changed"),
    ).toThrow("root changed");
  });

  it("validates artifact parent, entry, and streamed byte snapshots", () => {
    const expected = snapshot();
    expect(() =>
      assertArtifactParentUnchanged(expected, stat({ isDirectory: () => true }), "parent changed"),
    ).not.toThrow();
    expect(() => assertArtifactParentUnchanged(expected, stat(), "parent changed")).toThrow(
      "parent changed",
    );
    expect(() =>
      assertArtifactParentUnchanged(
        expected,
        stat({ dev: 9, isDirectory: () => true }),
        "parent changed",
      ),
    ).toThrow("parent changed");
    expect(() =>
      assertArtifactParentUnchanged(
        expected,
        stat({ ino: 9, isDirectory: () => true }),
        "parent changed",
      ),
    ).toThrow("parent changed");
    expect(() =>
      assertArtifactParentUnchanged(
        expected,
        stat({ mtimeMs: 99, isDirectory: () => true }),
        "parent changed",
      ),
    ).toThrow("parent changed");
    expect(() =>
      assertArtifactEntryUnchanged(expected, stat(), "file", "file changed"),
    ).not.toThrow();
    expect(() =>
      assertArtifactEntryUnchanged(expected, stat({ size: 9 }), "file", "file changed"),
    ).toThrow("file changed");
    expect(() =>
      assertArtifactEntryUnchanged(expected, stat({ dev: 9 }), "file", "file changed"),
    ).toThrow("file changed");
    expect(() =>
      assertArtifactEntryUnchanged(expected, stat({ ino: 9 }), "file", "file changed"),
    ).toThrow("file changed");
    expect(() =>
      assertArtifactEntryUnchanged(expected, stat({ mtimeMs: 9 }), "file", "file changed"),
    ).toThrow("file changed");
    expect(() =>
      assertArtifactEntryUnchanged(expected, stat({ isFile: () => false }), "file", "file changed"),
    ).toThrow("file changed");
    expect(() =>
      assertArtifactEntryUnchanged(
        expected,
        stat({ isDirectory: () => true }),
        "directory",
        "directory changed",
      ),
    ).not.toThrow();
    expect(() =>
      assertArtifactEntryUnchanged(expected, stat(), "directory", "directory changed"),
    ).toThrow("directory changed");
    expect(() =>
      assertArtifactEntryUnchanged(
        expected,
        stat({ isSymbolicLink: () => true }),
        "file",
        "link found",
      ),
    ).toThrow("link found");
    expect(artifactEntryKind(stat({ isDirectory: () => true }), "special file")).toBe("directory");
    expect(artifactEntryKind(stat(), "special file")).toBe("file");
    expect(() => artifactEntryKind(stat({ isSymbolicLink: () => true }), "special file")).toThrow(
      "special file",
    );
    expect(() =>
      assertOpenedArtifactUnchanged(expected, stat(), "opened file changed"),
    ).not.toThrow();
    expect(() =>
      assertOpenedArtifactUnchanged(expected, stat({ ino: 99 }), "opened file changed"),
    ).toThrow("opened file changed");
    expect(() => assertArtifactReadMatches(10, 10, "short read")).not.toThrow();
    expect(() => assertArtifactReadMatches(10, 9, "short read")).toThrow("short read");
    expect(artifactReadExceedsLimit(3, 4, 10)).toBe(false);
    expect(artifactReadExceedsLimit(5, 4, 10)).toBe(true);
    expect(artifactReadExceedsLimit(10, 20, 9)).toBe(true);
  });
});
