/* eslint-disable max-lines -- installer staging, activation, rollback, and boot recovery share one tree helper. */
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  confirmPrivilegedPendingUpdateBoot,
  confirmPendingUpdateBoot,
  createFileUpdateInstaller,
  readInstalledVersion,
  recoverPendingUpdateBoot,
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
  it("leaves Linux activation as a signed request in the daemon-writable incoming directory", async () => {
    const { rootDir, cleanup } = tempRoot();
    try {
      const installer = createFileUpdateInstaller({ rootDir, privilegedActivation: true });
      const manifest = {
        version: "1.2.0",
        artifactUrl: "https://updates.example.test/1.2.0.tgz",
        sha256: "a".repeat(64),
        signature: "signature",
      };
      await installer.stage({
        version: manifest.version,
        artifact: new Uint8Array([1, 2]),
        manifest,
      });
      await installer.activate(manifest.version);
      expect(existsSync(join(rootDir, "current"))).toBe(false);
      expect(readFileSync(join(rootDir, "incoming", "manifest.json"), "utf8")).toContain(
        manifest.sha256,
      );
      expect(readFileSync(join(rootDir, "incoming", "activation-request.json"), "utf8")).toContain(
        manifest.version,
      );
      await installer.rollback();
      expect(existsSync(join(rootDir, "incoming", "activation-request.json"))).toBe(false);
      await expect(
        createFileUpdateInstaller({ rootDir, privilegedActivation: true }).stage({
          version: "1.2.1",
          artifact: new Uint8Array(),
        }),
      ).rejects.toThrow("requires the verified update manifest");
    } finally {
      cleanup();
    }
  });

  it("records Linux health acknowledgement for the privileged helper without clearing its marker", () => {
    const { rootDir, cleanup } = tempRoot();
    try {
      runnableExtract("", join(rootDir, "current"));
      mkdirSync(join(rootDir, "incoming"), { recursive: true });
      writeFileSync(join(rootDir, "current", ".auto-harness-version"), "1.2.0\n");
      writeFileSync(
        join(rootDir, ".auto-harness-update-boot.json"),
        '{"version":"1.2.0","attempted":true}\n',
      );
      expect(confirmPrivilegedPendingUpdateBoot(rootDir)).toBe(true);
      expect(existsSync(join(rootDir, ".auto-harness-update-boot.json"))).toBe(true);
      expect(readFileSync(join(rootDir, "incoming", "boot-confirmed.json"), "utf8")).toContain(
        "1.2.0",
      );
    } finally {
      cleanup();
    }
  });

  it("has no privileged acknowledgement to record without a boot marker", () => {
    const { rootDir, cleanup } = tempRoot();
    try {
      expect(confirmPrivilegedPendingUpdateBoot(rootDir)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("stages runnable directories, switches a pointer, and rolls back", async () => {
    const { rootDir, cleanup } = tempRoot();
    try {
      const installer = createFileUpdateInstaller({ rootDir, extract: runnableExtract });
      await installer.stage({ version: "1.2.0", artifact: new Uint8Array([1]) });
      await installer.activate("1.2.0");
      expect(lstatSync(join(rootDir, "current")).isSymbolicLink()).toBe(true);
      expect(readInstalledVersion(rootDir)).toBe("1.2.0");
      expect(() => confirmPendingUpdateBoot(rootDir)).toThrow("was not attempted");

      // A second activation cannot overwrite the durable acknowledgement fence
      // left by the first one.
      await expect(installer.activate("1.3.0")).rejects.toThrow("awaiting health acknowledgement");
      await expect(recoverPendingUpdateBoot({ rootDir })).resolves.toBe("booting");
      writeFileSync(join(rootDir, "current", ".auto-harness-version"), "9.9.9\n");
      expect(() => confirmPendingUpdateBoot(rootDir)).toThrow("does not match the active release");
      writeFileSync(join(rootDir, "current", ".auto-harness-version"), "1.2.0\n");
      expect(confirmPendingUpdateBoot(rootDir)).toBe(true);

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

  it("prunes obsolete release trees only after the replacement boot is confirmed", async () => {
    const { rootDir, cleanup } = tempRoot();
    try {
      const installer = createFileUpdateInstaller({ rootDir, extract: runnableExtract });
      for (const version of ["1.0.0", "1.1.0"]) {
        await installer.stage({ version, artifact: new Uint8Array() });
        await installer.activate(version);
        await expect(recoverPendingUpdateBoot({ rootDir })).resolves.toBe("booting");
        expect(confirmPendingUpdateBoot(rootDir)).toBe(true);
      }
      await installer.stage({ version: "1.2.0", artifact: new Uint8Array() });
      await installer.activate("1.2.0");
      expect(existsSync(join(rootDir, "versions", "1.0.0"))).toBe(true);
      await expect(recoverPendingUpdateBoot({ rootDir })).resolves.toBe("booting");
      expect(confirmPendingUpdateBoot(rootDir)).toBe(true);
      expect(existsSync(join(rootDir, "versions", "1.0.0"))).toBe(false);
      expect(existsSync(join(rootDir, "versions", "1.1.0"))).toBe(true);
      expect(existsSync(join(rootDir, "versions", "1.2.0"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("rolls back a replacement that starts twice without a health acknowledgement", async () => {
    const { rootDir, cleanup } = tempRoot();
    try {
      const installer = createFileUpdateInstaller({ rootDir, extract: runnableExtract });
      await installer.stage({ version: "1.0.0", artifact: new Uint8Array() });
      await installer.activate("1.0.0");
      await expect(recoverPendingUpdateBoot({ rootDir })).resolves.toBe("booting");
      expect(confirmPendingUpdateBoot(rootDir)).toBe(true);

      await installer.stage({ version: "1.1.0", artifact: new Uint8Array() });
      await installer.activate("1.1.0");
      await expect(recoverPendingUpdateBoot({ rootDir })).resolves.toBe("booting");
      await expect(recoverPendingUpdateBoot({ rootDir })).resolves.toBe("rolled-back");
      expect(readInstalledVersion(rootDir)).toBe("1.0.0");
      expect(confirmPendingUpdateBoot(rootDir)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("fails closed for an unreadable boot marker and ignores one after a prior rollback", async () => {
    const { rootDir, cleanup } = tempRoot();
    try {
      const installer = createFileUpdateInstaller({ rootDir, extract: runnableExtract });
      await installer.stage({ version: "1.0.0", artifact: new Uint8Array() });
      await installer.activate("1.0.0");
      await expect(recoverPendingUpdateBoot({ rootDir })).resolves.toBe("booting");
      expect(confirmPendingUpdateBoot(rootDir)).toBe(true);

      const marker = join(rootDir, ".auto-harness-update-boot.json");
      writeFileSync(marker, "not-json\n");
      await expect(recoverPendingUpdateBoot({ rootDir })).rejects.toThrow(
        "invalid pending update boot marker",
      );
      writeFileSync(marker, '{"version":"1.0.0"}\n');
      await expect(recoverPendingUpdateBoot({ rootDir })).rejects.toThrow(
        "invalid pending update boot marker",
      );
      writeFileSync(marker, '{"version":"not-a-version","attempted":true}\n');
      await expect(recoverPendingUpdateBoot({ rootDir })).rejects.toThrow("invalid update version");

      writeFileSync(marker, '{"version":"1.1.0","attempted":true}\n');
      // A stale marker from a pointer that was already restored cannot roll
      // back the healthy active release a second time.
      await expect(recoverPendingUpdateBoot({ rootDir })).resolves.toBe("none");
      expect(existsSync(marker)).toBe(false);

      mkdirSync(marker);
      await expect(recoverPendingUpdateBoot({ rootDir })).rejects.toThrow();
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

  it("fails closed by removing an incomplete first-install pointer on the next boot", async () => {
    const { rootDir, cleanup } = tempRoot();
    try {
      const installer = createFileUpdateInstaller({ rootDir, extract: runnableExtract });
      await installer.stage({ version: "1.0.0", artifact: new Uint8Array() });
      await installer.activate("1.0.0");
      rmSync(join(rootDir, "current"), { recursive: true, force: true });

      await expect(recoverPendingUpdateBoot({ rootDir })).resolves.toBe("rolled-back");
      expect(existsSync(join(rootDir, ".auto-harness-update-boot.json"))).toBe(false);
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

      const oversizedList = createFileUpdateInstaller({
        rootDir,
        run: () => ({ status: 0, stdout: `${"package.json\\n".repeat(100_000)}`, stderr: "" }),
      });
      await expect(
        oversizedList.stage({ version: "3.0.4", artifact: new Uint8Array() }),
      ).rejects.toThrow("listing exceeds the maximum size");

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
