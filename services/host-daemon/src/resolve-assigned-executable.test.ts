import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveAssignedExecutable } from "./resolve-executable.ts";

function stubBinary(dir: string, filename: string): void {
  writeFileSync(join(dir, filename), "", { mode: 0o755 });
}

describe("resolveAssignedExecutable", () => {
  it("keeps bare assigned commands on trusted PATH", () => {
    const binDir = mkdtempSync(join(tmpdir(), "auto-harness-assigned-path-"));
    stubBinary(binDir, "tool");
    expect(resolveAssignedExecutable("tool", "/checkout", { PATH: binDir }, "linux")).toBe(
      join(binDir, "tool"),
    );
  });

  it("resolves POSIX relative commands lexically from the assigned checkout", () => {
    expect(resolveAssignedExecutable("scripts/run", "/checkout/worktree", {}, "linux")).toBe(
      "/checkout/worktree/scripts/run",
    );
    // No existence/access/realpath check is performed: a checkout symlink is
    // deliberately left for the native spawn boundary to follow.
    expect(resolveAssignedExecutable("./missing", "/checkout/worktree", {}, "linux")).toBe(
      "/checkout/worktree/missing",
    );
  });

  it("uses Windows lexical path semantics for Windows relative commands", () => {
    expect(
      resolveAssignedExecutable("tools\\runner.cmd", "C:\\checkout\\worktree", {}, "win32"),
    ).toBe(win32.resolve("C:\\checkout\\worktree", "tools\\runner.cmd"));
  });

  it.each([
    "/opt/tool",
    "C:\\Tools\\tool.exe",
    "C:/Tools/tool.exe",
    "\\\\server\\share\\tool.exe",
    "\\rooted-on-current-drive.exe",
    "..",
    "../tool",
    "tools/../tool",
    "tools\\..\\tool",
  ])("rejects absolute and parent-traversing direct assignments: %s", (command) => {
    expect(() => resolveAssignedExecutable(command, "/checkout", {}, "linux")).toThrow(
      /absolute or drive-qualified path|'\.\.' path segments/,
    );
  });
});
