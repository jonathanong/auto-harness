/* eslint-disable max-lines -- signed update staging, activation, rollback, and post-activation pruning share one filesystem safety boundary. */
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  type Dirent,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { UpdateInstaller } from "./agent-updater.ts";
import { assertRunnableTree } from "./agent-updater-install-tree.ts";

const VERSION_FILE = ".auto-harness-version";
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

type ArchiveRun = (
  command: string,
  args: string[],
) => { status: number | null; stdout: string; stderr: string };

type ExtractArchive = (archivePath: string, destination: string) => void;
type RenamePath = (source: string, destination: string) => void;

const defaultRun: ArchiveRun = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

function requireVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) throw new Error("invalid update version");
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

function atomicWrite(path: string, value: string): void {
  const next = `${path}.next`;
  writeFileSync(next, value, "utf8");
  renameSync(next, path);
}

function linkTarget(version: string): string {
  return join("versions", version);
}

function pointerTarget(rootDir: string, target: string, platform: NodeJS.Platform): string {
  return platform === "win32" && !isAbsolute(target) ? join(rootDir, target) : target;
}

function switchCurrent(
  rootDir: string,
  target: string,
  suffix: string,
  platform: NodeJS.Platform,
  renamePath: RenamePath,
): void {
  const current = join(rootDir, "current");
  const next = `${current}.${suffix}`;
  rmSync(next, { recursive: true, force: true });
  symlinkSync(
    pointerTarget(rootDir, target, platform),
    next,
    platform === "win32" ? "junction" : "dir",
  );
  if (platform !== "win32" || currentKind(current) === undefined) {
    renamePath(next, current);
    return;
  }

  // Windows cannot rename a junction over an existing junction. Move the old
  // pointer aside first, then restore it if the replacement cannot be installed.
  if (currentKind(current) !== "symlink") {
    rmSync(next, { recursive: true, force: true });
    throw new Error("current update path is not a directory pointer");
  }
  const previousPointer = `${next}.previous`;
  rmSync(previousPointer, { recursive: true, force: true });
  try {
    renamePath(current, previousPointer);
  } catch (error) {
    rmSync(next, { recursive: true, force: true });
    throw error;
  }
  try {
    renamePath(next, current);
  } catch (error) {
    try {
      renamePath(previousPointer, current);
    } catch (restoreError) {
      const message = error instanceof Error ? error.message : String(error);
      const restoreMessage =
        restoreError instanceof Error ? restoreError.message : String(restoreError);
      throw new Error(
        `failed to switch current update pointer and restore the prior pointer: ${message}; ${restoreMessage}`,
        { cause: restoreError },
      );
    } finally {
      rmSync(next, { recursive: true, force: true });
    }
    throw error;
  }
  // The activated current pointer is already durable. A locked temporary
  // junction is harmless and must not turn a successful activation into a
  // rollback-worthy failure.
  try {
    rmSync(previousPointer, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup of the old pointer.
  }
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
    return VERSION_PATTERN.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

function versionAtPointer(rootDir: string, target: string): string | undefined {
  const versions = join(rootDir, "versions");
  const resolvedTarget = isAbsolute(target) ? target : resolve(rootDir, target);
  const version = relative(versions, resolvedTarget);
  return VERSION_PATTERN.test(version) ? version : undefined;
}

/**
 * Remove superseded release trees only after a restarted daemon has proved it
 * can execute through the activated `current` pointer. The active and rollback
 * trees are retained so a later supervisor or activation failure remains safe.
 */
export function pruneConfirmedVersions(rootDir: string): string[] {
  const current = join(rootDir, "current");
  const activeVersion = readInstalledVersion(rootDir);
  if (!activeVersion || currentKind(current) !== "symlink") return [];
  let pointedVersion: string | undefined;
  try {
    pointedVersion = versionAtPointer(rootDir, readlinkSync(current));
  } catch {
    return [];
  }
  if (pointedVersion !== activeVersion) return [];

  const retained = new Set([activeVersion]);
  try {
    const rollbackVersion = versionAtPointer(
      rootDir,
      readFileSync(join(rootDir, "previous-version"), "utf8").trim(),
    );
    if (rollbackVersion) retained.add(rollbackVersion);
  } catch {
    // A missing or malformed rollback marker simply leaves only the active version pinned.
  }

  const versions = join(rootDir, "versions");
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(versions, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !VERSION_PATTERN.test(entry.name) || retained.has(entry.name)) {
      continue;
    }
    rmSync(join(versions, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

export function createFileUpdateInstaller(options: {
  rootDir: string;
  currentVersion?: string;
  extract?: ExtractArchive;
  run?: ArchiveRun;
  platform?: NodeJS.Platform;
  /** Test seam for emulating Windows' no-overwrite junction rename semantics. */
  renamePath?: RenamePath;
}): UpdateInstaller {
  const versions = join(options.rootDir, "versions");
  const current = join(options.rootDir, "current");
  const previous = join(options.rootDir, "previous-version");
  const extract =
    options.extract ??
    ((archivePath, destination) =>
      defaultExtract(archivePath, destination, options.run ?? defaultRun));
  const renamePath = options.renamePath ?? renameSync;

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
      switchCurrent(
        options.rootDir,
        linkTarget(version),
        "next",
        options.platform ?? process.platform,
        renamePath,
      );
    },
    async rollback() {
      const oldTarget = readFileSync(previous, "utf8");
      if (!oldTarget) {
        rmSync(current, { recursive: true, force: true });
        return;
      }
      switchCurrent(
        options.rootDir,
        oldTarget,
        "rollback",
        options.platform ?? process.platform,
        renamePath,
      );
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
