import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  fingerprintSetup,
  resolveSetupCacheState,
  writeStoredSetupCache,
} from "./setup-script-cache.ts";

function fingerprintVersion(
  version: string,
  checkoutSha: string,
  scripts: readonly string[],
  extras: ReadonlyArray<{ path: string; contents: Buffer }>,
  childEnv: NodeJS.ProcessEnv = {},
): string {
  const hash = createHash("sha256");
  const write = (value: Buffer) => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(value.length);
    hash.update(header);
    hash.update(value);
  };
  write(Buffer.from(version, "utf8"));
  write(Buffer.from(checkoutSha, "utf8"));
  write(Buffer.from(String(scripts.length)));
  for (const script of scripts) write(Buffer.from(script, "utf8"));
  write(Buffer.from(String(extras.length)));
  for (const extra of extras) {
    write(Buffer.from(extra.path, "utf8"));
    write(extra.contents);
  }
  if (version === "v3") {
    const entries = Object.entries(childEnv)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .filter(([key]) => !key.toUpperCase().startsWith("HARNESS_"))
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    write(Buffer.from(String(entries.length)));
    for (const [key, value] of entries) {
      write(Buffer.from(key, "utf8"));
      write(Buffer.from(value, "utf8"));
    }
  }
  return hash.digest("hex");
}

describe("setup cache fingerprint version", () => {
  it("does not skip a sidecar written under the previous fingerprint version", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-v1-"));
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-v1-store-"));
    const extras = [{ path: "pnpm-lock.yaml", contents: Buffer.from("lock-a") }];
    await writeFile(join(cwd, "pnpm-lock.yaml"), "lock-a");
    const current = fingerprintSetup({
      checkoutSha: "abc",
      scripts: ["pnpm install"],
      extraFiles: extras,
    });
    const legacyV1 = fingerprintVersion("v1", "abc", ["pnpm install"], extras);
    const legacyV2 = fingerprintVersion("v2", "abc", ["pnpm install"], extras);
    expect(current).not.toBe(legacyV1);
    expect(current).not.toBe(legacyV2);
    expect(current).toBe(fingerprintVersion("v3", "abc", ["pnpm install"], extras));
    await writeStoredSetupCache(cacheDir, "wt-1", cwd, legacyV2, { TOKEN: "x" });
    const resolved = await resolveSetupCacheState({
      cacheDir,
      checkoutSha: "abc",
      cwd,
      worktreeId: "wt-1",
      scripts: ["pnpm install"],
      extraPaths: ["pnpm-lock.yaml"],
    });
    expect(resolved).toMatchObject({ skip: false, fingerprintToStore: current });
  });
});
