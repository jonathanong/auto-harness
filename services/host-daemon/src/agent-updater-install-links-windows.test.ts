import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  confirmPendingUpdateBoot,
  createFileUpdateInstaller,
  readInstalledVersion,
  recoverPendingUpdateBoot,
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

describe("file update installer Windows links", () => {
  it("uses Windows junction pointers without requiring symlink privilege", async () => {
    const { rootDir, cleanup } = tempRoot();
    try {
      const current = join(rootDir, "current");
      let rejectReplacement = false;
      const installer = createFileUpdateInstaller({
        rootDir,
        extract: runnableExtract,
        platform: "win32",
        renamePath: (source, destination) => {
          if (destination === current && existsSync(destination)) {
            throw new Error("Windows cannot replace an existing junction");
          }
          if (rejectReplacement && source === `${current}.next`) {
            throw new Error("replacement junction failed");
          }
          renameSync(source, destination);
        },
      });
      await installer.stage({ version: "1.2.0", artifact: new Uint8Array() });
      await installer.activate("1.2.0");
      expect(realpathSync(join(rootDir, "current"))).toBe(
        realpathSync(join(rootDir, "versions", "1.2.0")),
      );
      await expect(recoverPendingUpdateBoot({ rootDir, platform: "win32" })).resolves.toBe(
        "booting",
      );
      expect(confirmPendingUpdateBoot(rootDir)).toBe(true);
      await installer.stage({ version: "1.3.0", artifact: new Uint8Array() });
      rejectReplacement = true;
      await expect(installer.activate("1.3.0")).rejects.toThrow("replacement junction failed");
      expect(readInstalledVersion(rootDir)).toBe("1.2.0");
      expect(existsSync(`${current}.next`)).toBe(false);
      expect(existsSync(`${current}.next.previous`)).toBe(false);

      rejectReplacement = false;
      await installer.activate("1.3.0");
      expect(existsSync(`${current}.next.previous`)).toBe(false);
      await installer.rollback();
      expect(readInstalledVersion(rootDir)).toBe("1.2.0");
      expect(existsSync(`${current}.rollback.previous`)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("fails closed when Windows cannot move or restore the prior pointer", async () => {
    const { rootDir, cleanup } = tempRoot();
    try {
      const current = join(rootDir, "current");
      let failMovePrevious = false;
      const installer = createFileUpdateInstaller({
        rootDir,
        extract: runnableExtract,
        platform: "win32",
        renamePath: (source, destination) => {
          if (failMovePrevious && destination.endsWith(".next.previous")) {
            throw new Error("cannot save previous pointer");
          }
          renameSync(source, destination);
        },
      });
      await installer.stage({ version: "2.0.0", artifact: new Uint8Array() });
      await installer.activate("2.0.0");
      await expect(recoverPendingUpdateBoot({ rootDir, platform: "win32" })).resolves.toBe(
        "booting",
      );
      expect(confirmPendingUpdateBoot(rootDir)).toBe(true);
      await installer.stage({ version: "2.1.0", artifact: new Uint8Array() });
      failMovePrevious = true;
      await expect(installer.activate("2.1.0")).rejects.toThrow("cannot save previous pointer");

      failMovePrevious = false;
      let restoreAttempt = false;
      const restoreFailure = createFileUpdateInstaller({
        rootDir,
        extract: runnableExtract,
        platform: "win32",
        renamePath: (source, destination) => {
          if (source === `${current}.next` && destination === current) {
            throw new Error("replacement pointer failed");
          }
          if (restoreAttempt && source === `${current}.next.previous`) {
            throw new Error("restore pointer failed");
          }
          if (source === current && destination.endsWith(".next.previous")) restoreAttempt = true;
          renameSync(source, destination);
        },
      });
      await expect(restoreFailure.activate("2.1.0")).rejects.toThrow(
        "failed to switch current update pointer and restore the prior pointer",
      );
    } finally {
      cleanup();
    }
  });

  it("rejects Windows UNC archive entries independently of traversal entries", async () => {
    const { rootDir, cleanup } = tempRoot();
    try {
      const installer = createFileUpdateInstaller({
        rootDir,
        run: () => ({ status: 0, stdout: "\\\\server\\share\\agent\\n", stderr: "" }),
      });
      await expect(
        installer.stage({ version: "2.2.0", artifact: new Uint8Array() }),
      ).rejects.toThrow("unsafe path");
    } finally {
      cleanup();
    }
  });
});
