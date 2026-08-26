import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveTrustedExecutable } from "./resolve-executable.ts";

function stubBinary(dir: string, filename: string): void {
  // Mode 0o755: resolution requires POSIX candidates to actually be
  // executable, not merely present.
  writeFileSync(join(dir, filename), "", { mode: 0o755 });
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

  it("rejects a non-absolute command containing a path separator", () => {
    // path.join normalizes ".." segments, so a bare command name with
    // traversal segments could otherwise escape the intended PATH directory
    // entirely. A bare command must never contain a separator; an operator
    // who wants a specific path can already pass one as an absolute command.
    const binDir = mkdtempSync(join(tmpdir(), "auto-harness-resolve-traversal-"));
    expect(() =>
      resolveTrustedExecutable("../../untrusted/evil", { PATH: binDir }, "linux"),
    ).toThrow(
      'Cannot resolve trusted executable "../../untrusted/evil": contains a path separator',
    );
    expect(() =>
      resolveTrustedExecutable("..\\..\\untrusted\\evil", { PATH: binDir }, "win32"),
    ).toThrow(
      'Cannot resolve trusted executable "..\\..\\untrusted\\evil": contains a path separator',
    );
  });

  it("throws when PATH is unset", () => {
    expect(() => resolveTrustedExecutable("git", {}, "linux")).toThrow(
      'Cannot resolve trusted executable "git": not found on PATH',
    );
  });

  it("skips a relative PATH directory entry and resolves from a later absolute one", () => {
    // A relative PATH entry resolves against whatever cwd the eventual spawn
    // happens to use — for this daemon that's the untrusted checkout, so
    // honoring it could reintroduce the cwd-search vulnerability. Only
    // absolute directories are trustworthy search roots.
    const absolute = mkdtempSync(join(tmpdir(), "auto-harness-resolve-relative-abs-"));
    stubBinary(absolute, "git");
    const env = { PATH: `relative-bin-dir:${absolute}` };
    expect(resolveTrustedExecutable("git", env, "linux")).toBe(join(absolute, "git"));
  });

  it("throws when every PATH directory entry is relative", () => {
    const env = { PATH: "relative-bin-dir:./another-relative-dir" };
    expect(() => resolveTrustedExecutable("git", env, "linux")).toThrow(
      'Cannot resolve trusted executable "git": not found on PATH',
    );
  });

  it("skips a PATH candidate that exists but is not executable, on posix", () => {
    const nonExecutableDir = mkdtempSync(join(tmpdir(), "auto-harness-resolve-non-exec-"));
    writeFileSync(join(nonExecutableDir, "git"), "", { mode: 0o644 });
    const executableDir = mkdtempSync(join(tmpdir(), "auto-harness-resolve-exec-"));
    stubBinary(executableDir, "git");
    const env = { PATH: `${nonExecutableDir}:${executableDir}` };
    expect(resolveTrustedExecutable("git", env, "linux")).toBe(join(executableDir, "git"));
  });

  it("skips a same-named directory on an earlier PATH entry, on posix", () => {
    // A searchable directory passes an X_OK access check the same as a real
    // executable would. Without an explicit regular-file check, a same-named
    // directory (e.g. checked-out build output) on an earlier PATH entry
    // would be wrongly returned instead of continuing the search.
    const decoyDir = mkdtempSync(join(tmpdir(), "auto-harness-resolve-decoy-parent-"));
    mkdirSync(join(decoyDir, "git"), { mode: 0o755 });
    const realDir = mkdtempSync(join(tmpdir(), "auto-harness-resolve-real-"));
    stubBinary(realDir, "git");
    const env = { PATH: `${decoyDir}:${realDir}` };
    expect(resolveTrustedExecutable("git", env, "linux")).toBe(join(realDir, "git"));
  });

  it("never considers the current working directory, only env.PATH", () => {
    // Regression guard for the vulnerability itself: actually chdir() into a
    // directory containing a same-named file (simulating an untrusted
    // checkout used as cwd) and confirm resolution still requires a real
    // PATH match — a future resolver that fell back to process.cwd() the
    // way Windows' native resolution does must still fail this test.
    const untrustedCwd = mkdtempSync(join(tmpdir(), "auto-harness-resolve-untrusted-cwd-"));
    stubBinary(untrustedCwd, "git");
    const emptyBinDir = mkdtempSync(join(tmpdir(), "auto-harness-resolve-empty-path-"));
    const originalCwd = process.cwd();
    process.chdir(untrustedCwd);
    try {
      expect(() => resolveTrustedExecutable("git", { PATH: emptyBinDir }, "linux")).toThrow(
        'Cannot resolve trusted executable "git": not found on PATH',
      );
    } finally {
      process.chdir(originalCwd);
    }
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

    it("skips a same-named directory on an earlier PATH entry", () => {
      const decoyDir = mkdtempSync(join(tmpdir(), "auto-harness-resolve-win32-decoy-parent-"));
      mkdirSync(join(decoyDir, "pnpm.cmd"));
      const realDir = mkdtempSync(join(tmpdir(), "auto-harness-resolve-win32-real-"));
      stubBinary(realDir, "pnpm.cmd");
      const env = { PATH: `${decoyDir};${realDir}` };
      expect(resolveTrustedExecutable("pnpm", env, "win32")).toBe(join(realDir, "pnpm.cmd"));
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

    it("resolves an explicit extension even when a custom PATHEXT omits it", () => {
      // A custom PATHEXT that happens to omit e.g. ".EXE" must not make an
      // already-fully-qualified filename like "cmd.exe" unresolvable.
      const binDir = mkdtempSync(join(tmpdir(), "auto-harness-resolve-win32-explicit-ext-"));
      stubBinary(binDir, "cmd.exe");
      expect(
        resolveTrustedExecutable("cmd.exe", { PATH: binDir, PATHEXT: ".COM;.BAT;.CMD" }, "win32"),
      ).toBe(join(binDir, "cmd.exe"));
    });

    it("resolves PATH/PATHEXT under Windows' native env-key casing (Path/Pathext)", () => {
      // NodeJS.ProcessEnv property access is case-sensitive even though the
      // env vars it wraps are not; Windows commonly reports these as
      // "Path"/"Pathext" rather than "PATH"/"PATHEXT".
      const binDir = mkdtempSync(join(tmpdir(), "auto-harness-resolve-win32-casing-"));
      stubBinary(binDir, "pnpm.foo");
      expect(resolveTrustedExecutable("pnpm", { Path: binDir, Pathext: ".FOO" }, "win32")).toBe(
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
      // spawns with as cwd. Actually chdir() into that directory: resolution
      // must still never look at any cwd-like value at all, so a directory
      // that merely happens to contain a same-named file is never
      // consulted, regardless of what the caller's actual cwd is set to.
      const untrustedCheckout = mkdtempSync(join(tmpdir(), "auto-harness-resolve-malicious-"));
      stubBinary(untrustedCheckout, "pnpm.cmd");
      stubBinary(untrustedCheckout, "git.exe");
      const trustedBinDir = mkdtempSync(join(tmpdir(), "auto-harness-resolve-trusted-"));
      stubBinary(trustedBinDir, "pnpm.cmd");
      stubBinary(trustedBinDir, "git.exe");
      const originalCwd = process.cwd();
      process.chdir(untrustedCheckout);
      try {
        expect(resolveTrustedExecutable("pnpm", { PATH: trustedBinDir }, "win32")).toBe(
          join(trustedBinDir, "pnpm.cmd"),
        );
        expect(resolveTrustedExecutable("git", { PATH: trustedBinDir }, "win32")).toBe(
          join(trustedBinDir, "git.exe"),
        );
      } finally {
        process.chdir(originalCwd);
      }
    });
  });
});
