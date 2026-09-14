import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

type SetupFingerprintParts = {
  checkoutSha: string;
  scripts: readonly string[];
  extraFiles: ReadonlyArray<{ path: string; contents: Buffer }>;
  childEnv?: NodeJS.ProcessEnv;
};

function writeLengthPrefixed(hash: ReturnType<typeof createHash>, value: Buffer): void {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(value.length);
  hash.update(header);
  hash.update(value);
}

export function startSetupFingerprint(
  checkoutSha: string,
  scripts: readonly string[],
  extraCount: number,
): ReturnType<typeof createHash> {
  const hash = createHash("sha256");
  writeLengthPrefixed(hash, Buffer.from("v3", "utf8"));
  writeLengthPrefixed(hash, Buffer.from(checkoutSha, "utf8"));
  writeLengthPrefixed(hash, Buffer.from(String(scripts.length)));
  for (const script of scripts) {
    writeLengthPrefixed(hash, Buffer.from(script, "utf8"));
  }
  writeLengthPrefixed(hash, Buffer.from(String(extraCount)));
  return hash;
}

export function appendExtraFile(
  hash: ReturnType<typeof createHash>,
  path: string,
  contents: Buffer,
): void {
  writeLengthPrefixed(hash, Buffer.from(path, "utf8"));
  writeLengthPrefixed(hash, contents);
}

/** Overlay these live keys on a cache hit; stored snapshots may hold a prior session's path. */
const EPHEMERAL_SETUP_CACHE_ENV_KEYS = new Set(["GH_CONFIG_DIR"]);

/** Must match mkdtemp(join(tmpdir(), "auto-harness-gh-config-")) for mapped App sessions. */
const APP_GENERATED_GH_CONFIG_DIR_PREFIX = "auto-harness-gh-config-";

function isAppGeneratedGitHubConfigDir(value: string): boolean {
  const prefix = join(tmpdir(), APP_GENERATED_GH_CONFIG_DIR_PREFIX);
  return (
    value.startsWith(prefix) && value.length > prefix.length && !value.includes(sep, prefix.length)
  );
}

function isEphemeralSetupCacheEnvValue(key: string, value: string): boolean {
  return key === "GH_CONFIG_DIR" && isAppGeneratedGitHubConfigDir(value);
}

function isFingerprintedChildEnvValue(key: string, value: unknown): value is string {
  return (
    typeof value === "string" &&
    !key.toUpperCase().startsWith("HARNESS_") &&
    !isEphemeralSetupCacheEnvValue(key, value)
  );
}

/** Hash sorted filtered child-env entries. Do not log keys or values. */
export function appendChildEnv(
  hash: ReturnType<typeof createHash>,
  environment: NodeJS.ProcessEnv = {},
): void {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(environment)) {
    if (isFingerprintedChildEnvValue(key, value)) entries.push([key, value]);
  }
  const sorted = entries.toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  writeLengthPrefixed(hash, Buffer.from(String(sorted.length)));
  for (const [key, value] of sorted) {
    writeLengthPrefixed(hash, Buffer.from(key, "utf8"));
    writeLengthPrefixed(hash, Buffer.from(value, "utf8"));
  }
}

/** Keep live isolation dirs on a cache hit; drop stored keys that live child env no longer has. */
export function applyLiveEphemeralChildEnv(
  stored: NodeJS.ProcessEnv,
  live: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment = { ...stored };
  for (const key of EPHEMERAL_SETUP_CACHE_ENV_KEYS) {
    const value = live[key];
    if (typeof value === "string") environment[key] = value;
    else delete environment[key];
  }
  return environment;
}

/** Stable digest of the operator-supplied inputs that may skip a later setup. */
export function fingerprintSetup(parts: SetupFingerprintParts): string {
  const hash = startSetupFingerprint(parts.checkoutSha, parts.scripts, parts.extraFiles.length);
  for (const extra of parts.extraFiles) {
    appendExtraFile(hash, extra.path, extra.contents);
  }
  appendChildEnv(hash, parts.childEnv);
  return hash.digest("hex");
}
