import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createFileUpdateInstaller } from "./agent-updater-install.ts";

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

describe("file update installer links", () => {
  it("allows contained pnpm links but rejects unsafe archive links", async () => {
    const { rootDir, cleanup } = tempRoot();
    try {
      const contained = createFileUpdateInstaller({
        rootDir,
        extract: (_archive, destination) => {
          runnableExtract("", destination);
          const packageDir = join(
            destination,
            "node_modules/.pnpm/example@1.0.0/node_modules/example",
          );
          mkdirSync(packageDir, { recursive: true });
          writeFileSync(join(packageDir, "package.json"), "{}\n");
          symlinkSync(
            ".pnpm/example@1.0.0/node_modules/example",
            join(destination, "node_modules/example"),
            "dir",
          );
        },
      });
      await expect(
        contained.stage({ version: "1.0.0", artifact: new Uint8Array() }),
      ).resolves.toBeUndefined();

      const outside = createFileUpdateInstaller({
        rootDir,
        extract: (_archive, destination) => {
          runnableExtract("", destination);
          mkdirSync(join(destination, "node_modules"), { recursive: true });
          symlinkSync("../..", join(destination, "node_modules/escape"), "dir");
        },
      });
      await expect(outside.stage({ version: "1.0.1", artifact: new Uint8Array() })).rejects.toThrow(
        "outside its staging directory",
      );

      const linked = createFileUpdateInstaller({
        rootDir,
        extract: (_archive, destination) => {
          runnableExtract("", destination);
          symlinkSync("package.json", join(destination, "linked"));
        },
      });
      await expect(linked.stage({ version: "1.0.2", artifact: new Uint8Array() })).rejects.toThrow(
        "outside node_modules",
      );
    } finally {
      cleanup();
    }
  });

  it("rejects broken, indirect, and malformed contained-link trees", async () => {
    const { rootDir, cleanup } = tempRoot();
    try {
      const broken = createFileUpdateInstaller({
        rootDir,
        extract: (_archive, destination) => {
          runnableExtract("", destination);
          mkdirSync(join(destination, "node_modules"), { recursive: true });
          symlinkSync("missing", join(destination, "node_modules/broken"), "dir");
        },
      });
      await expect(broken.stage({ version: "1.0.3", artifact: new Uint8Array() })).rejects.toThrow(
        "broken symbolic link",
      );

      const externalTarget = join(rootDir, "external-target");
      mkdirSync(externalTarget, { recursive: true });
      const indirect = createFileUpdateInstaller({
        rootDir,
        extract: (_archive, destination) => {
          runnableExtract("", destination);
          const dependencies = join(destination, "node_modules");
          mkdirSync(dependencies, { recursive: true });
          symlinkSync(externalTarget, join(dependencies, "z-outside"), "dir");
          symlinkSync("z-outside", join(dependencies, "a-indirect"), "dir");
        },
      });
      await expect(
        indirect.stage({ version: "1.0.4", artifact: new Uint8Array() }),
      ).rejects.toThrow("outside its staging directory");

      const absolute = createFileUpdateInstaller({
        rootDir,
        extract: (_archive, destination) => {
          runnableExtract("", destination);
          mkdirSync(join(destination, "node_modules"), { recursive: true });
          symlinkSync(rootDir, join(destination, "node_modules/absolute"), "dir");
        },
      });
      await expect(
        absolute.stage({ version: "1.0.5", artifact: new Uint8Array() }),
      ).rejects.toThrow("outside its staging directory");

      const packageOnly = createFileUpdateInstaller({
        rootDir,
        extract: (_archive, destination) =>
          writeFileSync(join(destination, "package.json"), "{}\n"),
      });
      await expect(
        packageOnly.stage({ version: "1.0.6", artifact: new Uint8Array() }),
      ).rejects.toThrow("not a runnable");
    } finally {
      cleanup();
    }
  });
});
