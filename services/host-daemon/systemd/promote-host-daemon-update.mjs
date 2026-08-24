#!/usr/bin/env node
/* eslint-disable max-lines -- promotion and rollback must share one privileged transaction. */
// This file is installed root-owned and executed by systemd with the `+`
// privilege prefix. It intentionally has no imports from an activated release:
// a process running session CLIs as `harness` can write `incoming/`, but can
// never select or alter code the service subsequently executes.
import { verify } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const VERSION = /^\d+\.\d+\.\d+$/;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_LISTING_BYTES = 1024 * 1024;
const incomingName = "incoming";
const markerName = ".auto-harness-update-boot.json";
const requestName = "activation-request.json";
const confirmationName = "boot-confirmed.json";

function fail(message) {
  process.stderr.write(`auto-harness update promotion: ${message}\n`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function atomicWrite(path, value) {
  const next = `${path}.next`;
  writeFileSync(next, `${value}\n`, { encoding: "utf8", mode: 0o644 });
  renameSync(next, path);
}

function canonicalManifest(manifest) {
  return JSON.stringify({
    artifactUrl: manifest.artifactUrl,
    sha256: manifest.sha256,
    version: manifest.version,
  });
}

function validManifest(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.version === "string" &&
    VERSION.test(value.version) &&
    typeof value.artifactUrl === "string" &&
    value.artifactUrl.startsWith("https://") &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    typeof value.signature === "string" &&
    value.signature.length > 0
  );
}

function hash(path) {
  const result = spawnSync("/usr/bin/sha256sum", [path], {
    encoding: "utf8",
    maxBuffer: 4096,
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "sha256sum failed");
  return result.stdout.trim().split(/\s+/, 1)[0];
}

function safeArchiveEntry(entry) {
  if (!entry || isAbsolute(entry) || entry.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(entry)) {
    return false;
  }
  return !entry.split(/[\\/]+/).some((part) => part === "..");
}

function assertSafeArchive(archive) {
  const listed = spawnSync("/usr/bin/tar", ["-tzf", archive], {
    encoding: "utf8",
    maxBuffer: MAX_ARCHIVE_LISTING_BYTES,
  });
  if (listed.status !== 0) throw new Error(listed.stderr.trim() || "archive listing failed");
  if (
    Buffer.byteLength(listed.stdout, "utf8") > MAX_ARCHIVE_LISTING_BYTES ||
    !listed.stdout.split(/\r?\n/).filter(Boolean).every(safeArchiveEntry)
  ) {
    throw new Error("archive contains unsafe paths");
  }
}

function lockTree(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  chmodSync(path, stat.mode & ~0o022);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) lockTree(join(path, entry));
  }
}

function currentVersion(root) {
  try {
    const value = readFileSync(join(root, "current", ".auto-harness-version"), "utf8").trim();
    return VERSION.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function pointerTarget(root) {
  const current = join(root, "current");
  try {
    return lstatSync(current).isSymbolicLink() ? readlinkSync(current) : undefined;
  } catch {
    return undefined;
  }
}

function switchCurrent(root, target) {
  const current = join(root, "current");
  const next = `${current}.next`;
  rmSync(next, { force: true });
  symlinkSync(target, next, "dir");
  renameSync(next, current);
}

function releaseVersion(root, target) {
  const value = relative(join(root, "releases"), resolve(root, target));
  return VERSION.test(value) ? value : undefined;
}

function prune(root) {
  const active = currentVersion(root);
  const previous = readFileSync(join(root, "previous-version"), "utf8").trim();
  const keep = new Set([active, releaseVersion(root, previous)]);
  for (const entry of readdirSync(join(root, "releases"), { withFileTypes: true })) {
    if (entry.isDirectory() && VERSION.test(entry.name) && !keep.has(entry.name)) {
      rmSync(join(root, "releases", entry.name), { recursive: true, force: true });
    }
  }
}

function settlePriorBoot(root, incoming) {
  const markerPath = join(root, markerName);
  const marker = readJson(markerPath);
  if (!marker || !VERSION.test(marker.version) || marker.attempted !== true) return;
  const confirmation = readJson(join(incoming, confirmationName));
  if (confirmation?.version === marker.version && currentVersion(root) === marker.version) {
    rmSync(markerPath, { force: true });
    rmSync(join(incoming, confirmationName), { force: true });
    prune(root);
    return;
  }
  const previous = readFileSync(join(root, "previous-version"), "utf8").trim();
  // There may be no prior activated release on a first update. In that case,
  // removing current returns the stable launcher to its checkout fallback;
  // leaving the failed first release selected would create an endless loop.
  if (previous) switchCurrent(root, previous);
  else rmSync(join(root, "current"), { force: true });
  // A failed release is never selected after the rollback above. Remove this
  // version's root-owned immutable tree so a corrected artifact for the same
  // version can be promoted on a later supervisor start. `marker.version` is
  // constrained by VERSION, so this is always a direct child of releases.
  rmSync(join(root, "releases", marker.version), { recursive: true, force: true });
  rmSync(markerPath, { force: true });
}

function promote(root, incoming) {
  const request = readJson(join(incoming, requestName));
  if (!request || typeof request.version !== "string" || !VERSION.test(request.version)) return;
  const manifest = readJson(join(incoming, "manifest.json"));
  const publicKey = process.env.HARNESS_UPDATE_PUBLIC_KEY?.trim().replaceAll("\\n", "\n");
  const artifact = join(incoming, "artifact.tgz");
  if (!publicKey || !validManifest(manifest) || manifest.version !== request.version) {
    throw new Error("activation request has no valid signed manifest");
  }
  if (
    !verify(
      null,
      Buffer.from(canonicalManifest(manifest)),
      publicKey,
      Buffer.from(manifest.signature, "base64url"),
    )
  ) {
    throw new Error("activation request manifest signature is invalid");
  }
  const artifactStat = lstatSync(artifact);
  if (
    !artifactStat.isFile() ||
    artifactStat.size > MAX_ARTIFACT_BYTES ||
    hash(artifact) !== manifest.sha256
  ) {
    throw new Error("activation request artifact checksum is invalid");
  }

  const releases = join(root, "releases");
  mkdirSync(releases, { recursive: true, mode: 0o755 });
  const target = join(releases, manifest.version);
  if (existsSync(target)) throw new Error(`release ${manifest.version} already exists`);
  const work = mkdtempSync(join(tmpdir(), "auto-harness-promote-"));
  try {
    const archive = join(work, "artifact.tgz");
    const extracted = join(work, "release");
    copyFileSync(artifact, archive);
    if (hash(archive) !== manifest.sha256)
      throw new Error("activation request changed during copy");
    assertSafeArchive(archive);
    mkdirSync(extracted, { mode: 0o755 });
    const unpacked = spawnSync(
      "/usr/bin/tar",
      ["--no-same-owner", "--no-same-permissions", "-xzf", archive, "-C", extracted],
      { encoding: "utf8", maxBuffer: 64 * 1024 },
    );
    if (unpacked.status !== 0)
      throw new Error(unpacked.stderr.trim() || "archive extraction failed");
    if (
      !existsSync(join(extracted, "package.json")) ||
      !existsSync(join(extracted, "services/host-daemon/bin/auto-harness-host-daemon.mjs"))
    ) {
      throw new Error("signed archive is not a runnable host daemon tree");
    }
    writeFileSync(join(extracted, ".auto-harness-version"), `${manifest.version}\n`, {
      encoding: "utf8",
      mode: 0o644,
    });
    lockTree(extracted);
    renameSync(extracted, target);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const current = join(root, "current");
  let oldTarget = pointerTarget(root);
  if (!oldTarget && existsSync(current)) {
    const oldVersion =
      currentVersion(root) ?? process.env.HARNESS_DAEMON_VERSION?.trim() ?? "0.0.0";
    if (!VERSION.test(oldVersion)) throw new Error("existing current tree has no valid version");
    oldTarget = join("releases", oldVersion);
    const oldRelease = join(root, oldTarget);
    if (existsSync(oldRelease)) throw new Error("legacy current release target already exists");
    renameSync(current, oldRelease);
    lockTree(oldRelease);
  }
  atomicWrite(join(root, "previous-version"), oldTarget ?? "");
  switchCurrent(root, join("releases", manifest.version));
  // The next, separate ExecStartPre phase records the actual first boot
  // attempt immediately before systemd invokes the daemon.
  atomicWrite(
    join(root, markerName),
    JSON.stringify({ version: manifest.version, attempted: false }),
  );
  rmSync(join(incoming, requestName), { force: true });
  rmSync(join(incoming, "manifest.json"), { force: true });
  rmSync(artifact, { force: true });
}

function main() {
  const root = process.env.HARNESS_UPDATE_INSTALL_DIR?.trim() || "/opt/auto-harness";
  if (!isAbsolute(root)) throw new Error("HARNESS_UPDATE_INSTALL_DIR must be absolute");
  const rootStat = lstatSync(root);
  if (rootStat.uid !== 0 || (rootStat.mode & 0o022) !== 0) {
    throw new Error("update root must be root-owned and not group/world writable");
  }
  const incoming = join(root, incomingName);
  if (!existsSync(incoming)) return;
  if (process.argv[2] === "--mark-boot-attempt") {
    const markerPath = join(root, markerName);
    const marker = readJson(markerPath);
    if (marker && VERSION.test(marker.version) && marker.attempted === false) {
      atomicWrite(markerPath, JSON.stringify({ ...marker, attempted: true }));
    }
    return;
  }
  settlePriorBoot(root, incoming);
  promote(root, incoming);
}

try {
  main();
} catch (error) {
  // Do not take a known-good daemon down because an untrusted incoming request
  // is malformed. Keep `current` unchanged and discard the request so the
  // next supervisor start remains on the immutable release.
  fail(error instanceof Error ? error.message : String(error));
  const root = process.env.HARNESS_UPDATE_INSTALL_DIR?.trim() || "/opt/auto-harness";
  if (isAbsolute(root)) rmSync(join(root, incomingName, requestName), { force: true });
}
