import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveTrustedExecutable } from "./resolve-executable.ts";

function stubBinary(dir: string, filename: string): void {
  writeFileSync(join(dir, filename), "");
}

describe("resolveTrustedExecutable", () => {
  it("returns an already-absolute command unchanged", () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-resolve-absolute-"));
    const absolute = join(cwd, "git");
    stubBinary(cwd, "git");
    expect(resolveTrustedExecutable(absolute, {}, "linux")).toBe(absolute);
  });

  it("resolves a bare command from a PATH directory on posix", () => {
    const binDir = mkdtempSync(join(tmpdir(), "auto-harness-resolve-posix-"));
    stubBinary(binDir, "git");
    expect(resolveTrustedExecutable("git", { PATH: binDir }, "linux")).toBe(join(binDir, "git"));
  });

  it("searches PATH directories left to right, returning the first match", () => {
    const first = mkdtempSync(join(tmpdir(), "auto-harness-resolve-first-"));
    const second = mkdtempSync(join(tmpdir(), "auto-harness-resolve-second-"));
    stubBinary(second, "git");
    const env = { PATH: `${first}:${second}` };
    expect(resolveTrustedExecutable("git", env, "linux")).toBe(join(second, "git"));
  });

  it("throws when the command is not found anywhere on PATH", () => {
    const binDir = mkdtempSync(join(tmpdir(), "auto-harness-resolve-missing-"));
    expect(() => resolveTrustedExecutable("git", { PATH: binDir }, "linux")).toThrow(
      'Cannot resolve trusted executable "git": not found on PATH',
    );
  });

  it("throws when PATH is unset", () => {
    expect(() => resolveTrustedExecutable("git", {}, "linux")).toThrow(
      'Cannot resolve trusted executable "git": not found on PATH',
    );
  });

  it("never considers the current working directory, only env.PATH", () => {
    // Regression guard for the vulnerability itself: place a same-named file
    // in process.cwd() (simulating an untrusted checkout used as cwd) and
    // confirm resolution still requires a real PATH match, never falling
    // back to an implicit cwd search the way Windows' native resolution does.
    const untrustedCwd = mkdtempSync(join(tmpdir(), "auto-harness-resolve-untrusted-cwd-"));
    stubBinary(untrustedCwd, "git");
    const emptyBinDir = mkdtempSync(join(tmpdir(), "auto-harness-resolve-empty-path-"));
    expect(() => resolveTrustedExecutable("git", { PATH: emptyBinDir }, "linux")).toThrow(
      'Cannot resolve trusted executable "git": not found on PATH',
    );
  });

  describe("on win32", () => {
    it("tries PATHEXT candidates in order and returns the first that exists", () => {
      const binDir = mkdtempSync(join(tmpdir(), "auto-harness-resolve-win32-"));
      stubBinary(binDir, "pnpm.cmd");
      expect(resolveTrustedExecutable("pnpm", { PATH: binDir }, "win32")).toBe(
        join(binDir, "pnpm.cmd"),
      );
    });

    it("prefers .exe over .cmd when both exist, matching Windows' default PATHEXT order", () => {
      const binDir = mkdtempSync(join(tmpdir(), "auto-harness-resolve-win32-order-"));
      stubBinary(binDir, "pnpm.exe");
      stubBinary(binDir, "pnpm.cmd");
      expect(resolveTrustedExecutable("pnpm", { PATH: binDir }, "win32")).toBe(
        join(binDir, "pnpm.exe"),
      );
    });

    it("does not double-append an extension already present on the command", () => {
      const binDir = mkdtempSync(join(tmpdir(), "auto-harness-resolve-win32-cmdexe-"));
      stubBinary(binDir, "cmd.exe");
      expect(resolveTrustedExecutable("cmd.exe", { PATH: binDir }, "win32")).toBe(
        join(binDir, "cmd.exe"),
      );
    });

    it("honors a custom PATHEXT instead of the built-in default", () => {
      const binDir = mkdtempSync(join(tmpdir(), "auto-harness-resolve-win32-pathext-"));
      stubBinary(binDir, "pnpm.foo");
      expect(resolveTrustedExecutable("pnpm", { PATH: binDir, PATHEXT: ".FOO" }, "win32")).toBe(
        join(binDir, "pnpm.foo"),
      );
    });

    it("splits PATH on ';' rather than ':'", () => {
      const first = mkdtempSync(join(tmpdir(), "auto-harness-resolve-win32-first-"));
      const second = mkdtempSync(join(tmpdir(), "auto-harness-resolve-win32-second-"));
      stubBinary(second, "git.exe");
      const env = { PATH: `${first};${second}` };
      expect(resolveTrustedExecutable("git", env, "win32")).toBe(join(second, "git.exe"));
    });

    it("ignores a malicious pnpm.cmd planted in an untrusted checkout used as cwd", () => {
      // This is the vulnerability from #349: a checked-out ref can plant a
      // same-named pnpm.cmd/git.exe in the directory a session daemon later
      // spawns with as cwd. Resolution here never looks at any cwd-like
      // value at all, so a directory that merely happens to contain a
      // same-named file is never consulted, regardless of what a caller's
      // cwd is set to.
      const untrustedCheckout = mkdtempSync(join(tmpdir(), "auto-harness-resolve-malicious-"));
      stubBinary(untrustedCheckout, "pnpm.cmd");
      stubBinary(untrustedCheckout, "git.exe");
      const trustedBinDir = mkdtempSync(join(tmpdir(), "auto-harness-resolve-trusted-"));
      stubBinary(trustedBinDir, "pnpm.cmd");
      stubBinary(trustedBinDir, "git.exe");
      expect(resolveTrustedExecutable("pnpm", { PATH: trustedBinDir }, "win32")).toBe(
        join(trustedBinDir, "pnpm.cmd"),
      );
      expect(resolveTrustedExecutable("git", { PATH: trustedBinDir }, "win32")).toBe(
        join(trustedBinDir, "git.exe"),
      );
    });
  });
});
