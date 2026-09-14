import { createHash } from "node:crypto";

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

/** Hash sorted filtered child-env entries. Do not log keys or values. */
export function appendChildEnv(
  hash: ReturnType<typeof createHash>,
  environment: NodeJS.ProcessEnv = {},
): void {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === "string" && !key.toUpperCase().startsWith("HARNESS_")) {
      entries.push([key, value]);
    }
  }
  const sorted = entries.toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  writeLengthPrefixed(hash, Buffer.from(String(sorted.length)));
  for (const [key, value] of sorted) {
    writeLengthPrefixed(hash, Buffer.from(key, "utf8"));
    writeLengthPrefixed(hash, Buffer.from(value, "utf8"));
  }
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
