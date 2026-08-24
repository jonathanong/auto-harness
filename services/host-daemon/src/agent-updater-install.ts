import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import type { UpdateInstaller } from "./agent-updater.ts";

const VERSION_FILE = ".auto-harness-version";
const REQUIRED_LAUNCHER = "services/host-daemon/bin/auto-harness-host-daemon.mjs";

type ArchiveRun = (
  command: string,
  args: string[],
) => { status: number | null; stdout: string; stderr: string };

type ExtractArchive = (archivePath: string, destination: string) => void;

const defaultRun: ArchiveRun = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

function requireVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("invalid update version");
}

function safeArchiveEntry(entry: string): boolean {
  if (!entry || isAbsolute(entry) || entry.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(entry)) {
    return false;
  }
  return !entry.split(/[\\/]+/).some((part) => part === "..");
}

function defaultExtract(archivePath: string, destination: string, run: ArchiveRun): void {
  const listing = run("tar", ["-tzf", archivePath]);
  if (listing.status !== 0) throw new Error(`update archive listing failed: ${listing.stderr}`);
  if (!listing.stdout.split(/\r?\n/).filter(Boolean).every(safeArchiveEntry)) {
    throw new Error("update archive contains an unsafe path");
  }
  const extracted = run("tar", ["-xzf", archivePath, "-C", destination]);
  if (extracted.status !== 0) {
    throw new Error(`update archive extraction failed: ${extracted.stderr}`);
  }
}

function assertNoSymlinks(root: string, current = root): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error("update archive must not contain symbolic links");
    if (entry.isDirectory()) assertNoSymlinks(root, path);
    const rel = relative(root, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("update archive escaped its staging directory");
    }
  }
}

function assertRunnableTree(root: string): void {
  assertNoSymlinks(root);
  if (!existsSync(join(root, "package.json")) || !existsSync(join(root, REQUIRED_LAUNCHER))) {
    throw new Error("update archive is not a runnable Auto Harness tree");
  }
}

function atomicWrite(path: string, value: string): void {
  const next = `${path}.next`;
  writeFileSync(next, value, "utf8");
  renameSync(next, path);
}

function linkTarget(version: string): string {
  return join("versions", version);
}

function switchCurrent(rootDir: string, target: string, suffix: string): void {
  const current = join(rootDir, "current");
  const next = `${current}.${suffix}`;
  rmSync(next, { recursive: true, force: true });
  symlinkSync(process.platform === "win32" ? join(rootDir, target) : target, next, "dir");
  renameSync(next, current);
}

function currentKind(path: string): "directory" | "symlink" | "other" | undefined {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch {
    return undefined;
  }
}

export function readInstalledVersion(rootDir: string): string | undefined {
  try {
    const version = readFileSync(join(rootDir, "current", VERSION_FILE), "utf8").trim();
    return /^\d+\.\d+\.\d+$/.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

export function createFileUpdateInstaller(options: {
  rootDir: string;
  currentVersion?: string;
  extract?: ExtractArchive;
  run?: ArchiveRun;
}): UpdateInstaller {
  const versions = join(options.rootDir, "versions");
  const current = join(options.rootDir, "current");
  const previous = join(options.rootDir, "previous-version");
  const extract =
    options.extract ??
    ((archivePath, destination) =>
      defaultExtract(archivePath, destination, options.run ?? defaultRun));

  return {
    async stage(input) {
      requireVersion(input.version);
      const staged = join(versions, `${input.version}.staging`);
      const target = join(versions, input.version);
      const archive = join(versions, `.${input.version}.tgz`);
      mkdirSync(versions, { recursive: true });
      rmSync(staged, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
      mkdirSync(staged, { recursive: true });
      writeFileSync(archive, input.artifact);
      try {
        extract(archive, staged);
        assertRunnableTree(staged);
        writeFileSync(join(staged, VERSION_FILE), `${input.version}\n`, "utf8");
        renameSync(staged, target);
      } finally {
        rmSync(archive, { force: true });
        rmSync(staged, { recursive: true, force: true });
      }
    },
    async activate(version) {
      requireVersion(version);
      const target = join(versions, version);
      if (readFileSync(join(target, VERSION_FILE), "utf8").trim() !== version) {
        throw new Error("staged update version marker does not match");
      }
      mkdirSync(options.rootDir, { recursive: true });
      let oldTarget = "";
      const kind = currentKind(current);
      if (kind === "symlink") {
        oldTarget = readlinkSync(current);
      } else if (kind === "directory") {
        const oldVersion =
          readInstalledVersion(options.rootDir) ?? options.currentVersion ?? "0.0.0";
        requireVersion(oldVersion);
        oldTarget = linkTarget(oldVersion);
        const legacyTarget = join(options.rootDir, oldTarget);
        rmSync(legacyTarget, { recursive: true, force: true });
        writeFileSync(join(current, VERSION_FILE), `${oldVersion}\n`, "utf8");
        renameSync(current, legacyTarget);
      } else if (kind === "other") {
        throw new Error("current update path is not a directory pointer");
      }
      atomicWrite(previous, oldTarget);
      switchCurrent(options.rootDir, linkTarget(version), "next");
    },
    async rollback() {
      const oldTarget = readFileSync(previous, "utf8");
      if (!oldTarget) {
        rmSync(current, { recursive: true, force: true });
        return;
      }
      switchCurrent(options.rootDir, oldTarget, "rollback");
    },
    async restart() {
      throw new Error("supervisor restart adapter is required");
    },
  };
}

export function removeStagedVersion(rootDir: string, version: string): void {
  requireVersion(version);
  rmSync(join(rootDir, "versions", version), { recursive: true, force: true });
}
