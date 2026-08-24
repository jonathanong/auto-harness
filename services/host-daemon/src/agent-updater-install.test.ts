import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createFileUpdateInstaller,
  readInstalledVersion,
  removeStagedVersion,
} from "./agent-updater-install.ts";

function runnableExtract(_archivePath: string, destination: string): void {
  const launcher = join(destination, "services/host-daemon/bin");
  mkdirSync(launcher, { recursive: true });
  writeFileSync(join(destination, "package.json"), "{}\n");
  writeFileSync(join(launcher, "auto-harness-host-daemon.mjs"), "// launcher\n");
}

function tempRoot(): { rootDir: string; cleanup: () => void } {
  const rootDir = mkdtempSync(join(tmpdir(), "ah-update-"));
  return { rootDir, cleanup: () => rmSync(rootDir, { recursive: true, force: true }) };
}

describe("file update installer", () => {
  it("stages runnable directories, switches a pointer, and rolls back", async () => {
    const { rootDir, cleanup } = tempRoot();
    try {
      const installer = createFileUpdateInstaller({ rootDir, extract: runnableExtract });
      await installer.stage({ version: "1.2.0", artifact: new Uint8Array([1]) });
      await installer.activate("1.2.0");
      expect(lstatSync(join(rootDir, "current")).isSymbolicLink()).toBe(true);
      expect(readInstalledVersion(rootDir)).toBe("1.2.0");

      await installer.stage({ version: "1.3.0", artifact: new Uint8Array([2]) });
      await installer.activate("1.3.0");
      expect(readInstalledVersion(rootDir)).toBe("1.3.0");
      expect(readFileSync(join(rootDir, "previous-version"), "utf8")).toBe(
        join("versions", "1.2.0"),
      );

      await installer.rollback();
      expect(readInstalledVersion(rootDir)).toBe("1.2.0");
      removeStagedVersion(rootDir, "1.3.0");
      expect(existsSync(join(rootDir, "versions", "1.3.0"))).toBe(false);
      await expect(installer.restart()).rejects.toThrow("supervisor restart adapter is required");
    } finally {
      cleanup();
    }
  });

  it("migrates a legacy current checkout before switching", async () => {
    const { rootDir, cleanup } = tempRoot();
    try {
      runnableExtract("", join(rootDir, "current"));
      const installer = createFileUpdateInstaller({
        rootDir,
        currentVersion: "1.0.0",
        extract: runnableExtract,
      });
      await installer.stage({ version: "2.0.0", artifact: new Uint8Array() });
      await installer.activate("2.0.0");
      expect(readInstalledVersion(rootDir)).toBe("2.0.0");
      expect(existsSync(join(rootDir, "versions", "1.0.0", "package.json"))).toBe(true);
      await installer.rollback();
      expect(readInstalledVersion(rootDir)).toBe("1.0.0");
    } finally {
      cleanup();
    }
  });

  it("removes a first-install pointer when rollback has no predecessor", async () => {
    const { rootDir, cleanup } = tempRoot();
    try {
      const installer = createFileUpdateInstaller({ rootDir, extract: runnableExtract });
      await installer.stage({ version: "1.0.0", artifact: new Uint8Array() });
      await installer.activate("1.0.0");
      await installer.rollback();
      expect(existsSync(join(rootDir, "current"))).toBe(false);
      expect(readInstalledVersion(rootDir)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("rejects malformed trees, markers, and current files", async () => {
    const { rootDir, cleanup } = tempRoot();
    try {
      const missing = createFileUpdateInstaller({ rootDir, extract: () => undefined });
      await expect(missing.stage({ version: "1.0.0", artifact: new Uint8Array() })).rejects.toThrow(
        "not a runnable",
      );

      const installer = createFileUpdateInstaller({ rootDir, extract: runnableExtract });
      await installer.stage({ version: "1.1.0", artifact: new Uint8Array() });
      writeFileSync(join(rootDir, "versions", "1.1.0", ".auto-harness-version"), "9.9.9\n");
      await expect(installer.activate("1.1.0")).rejects.toThrow("marker does not match");
      writeFileSync(join(rootDir, "current"), "not a directory");
      await installer.stage({ version: "1.2.0", artifact: new Uint8Array() });
      await expect(installer.activate("1.2.0")).rejects.toThrow("not a directory pointer");
      expect(() => removeStagedVersion(rootDir, "../bad")).toThrow("invalid update version");
    } finally {
      cleanup();
    }
  });

  it("validates and extracts archives through the tar boundary", async () => {
    const { rootDir, cleanup } = tempRoot();
    try {
      const calls: string[][] = [];
      const installer = createFileUpdateInstaller({
        rootDir,
        run: (_command, args) => {
          calls.push(args);
          if (args[0] === "-tzf") return { status: 0, stdout: "package.json\n", stderr: "" };
          runnableExtract("", args[3]!);
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      await installer.stage({ version: "3.0.0", artifact: new Uint8Array([3]) });
      expect(calls.map((args) => args[0])).toEqual(["-tzf", "-xzf"]);

      const unsafe = createFileUpdateInstaller({
        rootDir,
        run: () => ({ status: 0, stdout: "../escape\nC:\\escape\n", stderr: "" }),
      });
      await expect(unsafe.stage({ version: "3.0.1", artifact: new Uint8Array() })).rejects.toThrow(
        "unsafe path",
      );

      const badList = createFileUpdateInstaller({
        rootDir,
        run: () => ({ status: 2, stdout: "", stderr: "bad archive" }),
      });
      await expect(badList.stage({ version: "3.0.2", artifact: new Uint8Array() })).rejects.toThrow(
        "listing failed",
      );

      let callsCount = 0;
      const badExtract = createFileUpdateInstaller({
        rootDir,
        run: () =>
          ++callsCount === 1
            ? { status: 0, stdout: "package.json\n", stderr: "" }
            : { status: 2, stdout: "", stderr: "cannot extract" },
      });
      await expect(
        badExtract.stage({ version: "3.0.3", artifact: new Uint8Array() }),
      ).rejects.toThrow("extraction failed");
    } finally {
      cleanup();
    }
  });
});
