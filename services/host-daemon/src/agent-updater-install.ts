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

import type { UpdateInstaller, UpdateManifest } from "./agent-updater.ts";
import { assertRunnableTree } from "./agent-updater-install-tree.ts";

const VERSION_FILE = ".auto-harness-version";
const BOOT_MARKER_FILE = ".auto-harness-update-boot.json";
/** Files in this directory are deliberately the only daemon-writable update state on Linux. */
const PRIVILEGED_INCOMING_DIR = "incoming";
const PRIVILEGED_MANIFEST_FILE = "manifest.json";
const PRIVILEGED_ARTIFACT_FILE = "artifact.tgz";
const PRIVILEGED_REQUEST_FILE = "activation-request.json";
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
// Keep validation bounded even if an otherwise verified archive has an
// unexpectedly large table of contents. This matches Node's default
// spawnSync buffer, but making it explicit prevents a future runtime default
// change from turning archive validation into an unbounded allocation.
const MAX_ARCHIVE_LISTING_BYTES = 1024 * 1024;

type ArchiveRun = (
  command: string,
  args: string[],
) => { status: number | null; stdout: string; stderr: string };

type ExtractArchive = (archivePath: string, destination: string) => void;
type RenamePath = (source: string, destination: string) => void;

const defaultRun: ArchiveRun = (command, args) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: MAX_ARCHIVE_LISTING_BYTES,
  });
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
  if (Buffer.byteLength(listing.stdout, "utf8") > MAX_ARCHIVE_LISTING_BYTES) {
    throw new Error("update archive listing exceeds the maximum size");
  }
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

type PendingUpdateBoot = {
  version: string;
  attempted: boolean;
};

export type UpdateBootRecovery = "none" | "booting" | "rolled-back";

function bootMarkerPath(rootDir: string): string {
  return join(rootDir, BOOT_MARKER_FILE);
}

function readPendingUpdateBoot(rootDir: string): PendingUpdateBoot | undefined {
  let raw: string;
  try {
    raw = readFileSync(bootMarkerPath(rootDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // Treat an inaccessible or malformed marker path as a startup failure.
    // Silently treating it as absent could let a crash-looping release bypass
    // the durable rollback fence.
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid pending update boot marker");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !(
      "version" in parsed &&
      "attempted" in parsed &&
      typeof parsed.version === "string" &&
      typeof parsed.attempted === "boolean"
    )
  ) {
    throw new Error("invalid pending update boot marker");
  }
  requireVersion(parsed.version);
  return { version: parsed.version, attempted: parsed.attempted };
}

function writePendingUpdateBoot(rootDir: string, marker: PendingUpdateBoot): void {
  requireVersion(marker.version);
  mkdirSync(rootDir, { recursive: true });
  atomicWrite(bootMarkerPath(rootDir), `${JSON.stringify(marker)}\n`);
}

function clearPendingUpdateBoot(rootDir: string): void {
  rmSync(bootMarkerPath(rootDir), { force: true });
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

/**
 * Recover an activation that crossed the stable `current` pointer but never
 * reached a registered replacement daemon. The first replacement process
 * records its boot attempt before any network work; a subsequent launch rolls
 * back to the saved predecessor instead of trying the crashing release again.
 */
export async function recoverPendingUpdateBoot(options: {
  rootDir: string;
  platform?: NodeJS.Platform;
  renamePath?: RenamePath;
}): Promise<UpdateBootRecovery> {
  const pending = readPendingUpdateBoot(options.rootDir);
  if (!pending) return "none";
  const activeVersion = readInstalledVersion(options.rootDir);
  if (activeVersion !== pending.version) {
    if (activeVersion === undefined) {
      await createFileUpdateInstaller(options).rollback();
      return "rolled-back";
    }
    // A failed activation never switched the pointer (or a prior rollback
    // already did), so this marker cannot authorize a rollback of the active
    // release.
    clearPendingUpdateBoot(options.rootDir);
    return "none";
  }
  if (pending.attempted) {
    await createFileUpdateInstaller(options).rollback();
    return "rolled-back";
  }
  writePendingUpdateBoot(options.rootDir, { ...pending, attempted: true });
  return "booting";
}

/** A successful control-plane registration is the replacement daemon's health acknowledgement. */
export function confirmPendingUpdateBoot(rootDir: string): boolean {
  const pending = readPendingUpdateBoot(rootDir);
  if (!pending) return false;
  if (!pending.attempted) {
    throw new Error("pending update boot was not attempted");
  }
  if (readInstalledVersion(rootDir) !== pending.version) {
    throw new Error("pending update boot does not match the active release");
  }
  clearPendingUpdateBoot(rootDir);
  try {
    pruneConfirmedVersions(rootDir);
  } catch {
    // Health is already durable; a best-effort cleanup failure must not turn a
    // registered release into an unacknowledged boot that rolls back later.
  }
  return true;
}

/**
 * Linux confirmation is performed by the root-owned systemd ExecStartPost
 * helper after systemd accepts READY=1 from the main daemon process. Session
 * children cannot forge that main-PID readiness barrier.
 */
export function confirmPrivilegedPendingUpdateBoot(rootDir: string): boolean {
  const pending = readPendingUpdateBoot(rootDir);
  if (!pending) return false;
  if (!pending.attempted || readInstalledVersion(rootDir) !== pending.version) {
    throw new Error("pending update boot does not match the active release");
  }
  return true;
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
function pruneConfirmedVersions(rootDir: string): string[] {
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
  /**
   * Linux systemd installs use a root-owned activation helper. The daemon may
   * write only a verified artifact request; it never changes `current` or a
   * runnable release itself.
   */
  privilegedActivation?: boolean;
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
  const incoming = join(options.rootDir, PRIVILEGED_INCOMING_DIR);

  function stagePrivileged(input: {
    version: string;
    artifact: Uint8Array;
    manifest?: UpdateManifest;
  }): void {
    if (!input.manifest || input.manifest.version !== input.version) {
      throw new Error("privileged activation requires the verified update manifest");
    }
    mkdirSync(incoming, { recursive: true });
    const artifactPath = join(incoming, PRIVILEGED_ARTIFACT_FILE);
    const manifestPath = join(incoming, PRIVILEGED_MANIFEST_FILE);
    const requestPath = join(incoming, PRIVILEGED_REQUEST_FILE);
    // A prior request is no longer valid once either signed input changes.
    rmSync(requestPath, { force: true });
    atomicWrite(manifestPath, `${JSON.stringify(input.manifest)}\n`);
    const nextArtifact = `${artifactPath}.next`;
    writeFileSync(nextArtifact, input.artifact);
    renameSync(nextArtifact, artifactPath);
  }

  return {
    async stage(input) {
      if (options.privilegedActivation) {
        stagePrivileged(input);
        return;
      }
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
      if (options.privilegedActivation) {
        requireVersion(version);
        const manifest = JSON.parse(
          readFileSync(join(incoming, PRIVILEGED_MANIFEST_FILE), "utf8"),
        ) as { version?: unknown };
        if (manifest.version !== version) {
          throw new Error("staged update version marker does not match");
        }
        atomicWrite(join(incoming, PRIVILEGED_REQUEST_FILE), `${JSON.stringify({ version })}\n`);
        return;
      }
      requireVersion(version);
      if (readPendingUpdateBoot(options.rootDir)) {
        throw new Error("an update boot is still awaiting health acknowledgement");
      }
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
      writePendingUpdateBoot(options.rootDir, { version, attempted: false });
      try {
        switchCurrent(
          options.rootDir,
          linkTarget(version),
          "next",
          options.platform ?? process.platform,
          renamePath,
        );
      } catch (error) {
        if (readInstalledVersion(options.rootDir) !== version) {
          clearPendingUpdateBoot(options.rootDir);
        }
        throw error;
      }
    },
    async rollback() {
      if (options.privilegedActivation) {
        // Until systemd's root-owned pre-start helper consumes it, activation
        // is only a request. Removing that request preserves the running
        // immutable release when the old process cannot hand off safely.
        rmSync(join(incoming, PRIVILEGED_REQUEST_FILE), { force: true });
        return;
      }
      const oldTarget = readFileSync(previous, "utf8");
      if (!oldTarget) {
        rmSync(current, { recursive: true, force: true });
        clearPendingUpdateBoot(options.rootDir);
        return;
      }
      switchCurrent(
        options.rootDir,
        oldTarget,
        "rollback",
        options.platform ?? process.platform,
        renamePath,
      );
      clearPendingUpdateBoot(options.rootDir);
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
