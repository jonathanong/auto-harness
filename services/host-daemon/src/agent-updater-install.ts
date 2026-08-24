import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { UpdateInstaller } from "./agent-updater.ts";

type UpdateInstallFs = {
  mkdirSync: (path: string, opts: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: Uint8Array) => void;
  readFileSync: (path: string) => Uint8Array;
  renameSync: (from: string, to: string) => void;
  rmSync: (path: string, opts: { recursive: boolean; force: boolean }) => void;
};

const defaultFs: UpdateInstallFs = {
  mkdirSync,
  writeFileSync: (path, data) => writeFileSync(path, data),
  readFileSync: (path) => new Uint8Array(readFileSync(path)),
  renameSync,
  rmSync,
};

export function createFileUpdateInstaller(options: {
  rootDir: string;
  fs?: UpdateInstallFs;
}): UpdateInstaller {
  const fs = options.fs ?? defaultFs;
  const versions = join(options.rootDir, "versions");
  const current = join(options.rootDir, "current");
  const previous = join(options.rootDir, "previous");
  const staged = (version: string) => join(versions, version, "artifact");

  return {
    async stage(input) {
      fs.mkdirSync(join(versions, input.version), { recursive: true });
      fs.writeFileSync(staged(input.version), input.artifact);
    },
    async activate(version) {
      const next = staged(version);
      try {
        const existing = fs.readFileSync(current);
        fs.mkdirSync(previous, { recursive: true });
        fs.writeFileSync(join(previous, "artifact"), existing);
      } catch {
        // First install has no previous artifact to keep.
      }
      const tmp = `${current}.next`;
      fs.mkdirSync(options.rootDir, { recursive: true });
      fs.writeFileSync(tmp, fs.readFileSync(next));
      fs.renameSync(tmp, current);
    },
    async rollback() {
      const backup = fs.readFileSync(join(previous, "artifact"));
      const tmp = `${current}.rollback`;
      fs.writeFileSync(tmp, backup);
      fs.renameSync(tmp, current);
    },
    async restart() {
      throw new Error("supervisor restart adapter is required");
    },
  };
}

export function removeStagedVersion(
  rootDir: string,
  version: string,
  fs: UpdateInstallFs = defaultFs,
): void {
  fs.rmSync(join(rootDir, "versions", version), { recursive: true, force: true });
}
