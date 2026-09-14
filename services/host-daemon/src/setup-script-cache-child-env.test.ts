import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  fingerprintSetup,
  matchingSetupFingerprintAfterSetup,
  resolveSetupCacheState,
  writeStoredSetupCache,
} from "./setup-script-cache.ts";

const extras = [{ path: "pnpm-lock.yaml", contents: Buffer.from("lock-a") }];

describe("setup cache child-env fingerprint", () => {
  it("changes when PATH, an allowlisted value, or a removed variable changes", () => {
    const base = fingerprintSetup({
      checkoutSha: "abc",
      scripts: ["pnpm install"],
      extraFiles: extras,
      childEnv: { PATH: "/usr/bin", TOKEN: "old" },
    });
    expect(
      fingerprintSetup({
        checkoutSha: "abc",
        scripts: ["pnpm install"],
        extraFiles: extras,
        childEnv: { PATH: "/opt/bin:/usr/bin", TOKEN: "old" },
      }),
    ).not.toBe(base);
    expect(
      fingerprintSetup({
        checkoutSha: "abc",
        scripts: ["pnpm install"],
        extraFiles: extras,
        childEnv: { PATH: "/usr/bin", TOKEN: "rotated" },
      }),
    ).not.toBe(base);
    expect(
      fingerprintSetup({
        checkoutSha: "abc",
        scripts: ["pnpm install"],
        extraFiles: extras,
        childEnv: { PATH: "/usr/bin" },
      }),
    ).not.toBe(base);
    expect(
      fingerprintSetup({
        checkoutSha: "abc",
        scripts: ["pnpm install"],
        extraFiles: extras,
        childEnv: { TOKEN: "old", PATH: "/usr/bin" },
      }),
    ).toBe(base);
    expect(
      fingerprintSetup({
        checkoutSha: "abc",
        scripts: ["pnpm install"],
        extraFiles: extras,
        childEnv: { PATH: "/usr/bin", TOKEN: "old", HARNESS_API_KEY: "secret", UNSET: undefined },
      }),
    ).toBe(base);
    expect(
      fingerprintSetup({
        checkoutSha: "abc",
        scripts: ["pnpm install"],
        extraFiles: extras,
        childEnv: { PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: "/tmp/session-a" },
      }),
    ).toBe(base);
    expect(
      fingerprintSetup({
        checkoutSha: "abc",
        scripts: ["pnpm install"],
        extraFiles: extras,
        childEnv: { PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: "/tmp/session-b" },
      }),
    ).toBe(base);
  });

  it("misses stored setup when the filtered child env changes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-child-env-"));
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-child-env-store-"));
    await writeFile(join(cwd, "pnpm-lock.yaml"), "lock-a");
    const childEnv = { PATH: "/usr/bin", TOKEN: "old" };
    const first = await resolveSetupCacheState({
      cacheDir,
      checkoutSha: "abc",
      cwd,
      worktreeId: "wt-1",
      scripts: ["pnpm install"],
      extraPaths: ["pnpm-lock.yaml"],
      childEnv,
    });
    expect(first).toMatchObject({ skip: false, fingerprintToStore: expect.any(String) });
    if (first.skip || !first.fingerprintToStore) throw new Error("expected a fingerprint");
    await writeStoredSetupCache(cacheDir, "wt-1", cwd, first.fingerprintToStore, {
      TOKEN: "from-setup",
    });
    expect(
      await resolveSetupCacheState({
        cacheDir,
        checkoutSha: "abc",
        cwd,
        worktreeId: "wt-1",
        scripts: ["pnpm install"],
        extraPaths: ["pnpm-lock.yaml"],
        childEnv,
      }),
    ).toEqual({ skip: true, environment: { TOKEN: "from-setup" } });
    const miss = await resolveSetupCacheState({
      cacheDir,
      checkoutSha: "abc",
      cwd,
      worktreeId: "wt-1",
      scripts: ["pnpm install"],
      extraPaths: ["pnpm-lock.yaml"],
      childEnv: { PATH: "/usr/bin", TOKEN: "rotated" },
    });
    expect(miss.skip).toBe(false);
    expect(miss).toMatchObject({ fingerprintToStore: expect.any(String) });
    expect(miss).not.toEqual(first);
    expect(
      await matchingSetupFingerprintAfterSetup({
        checkoutSha: "abc",
        cwd,
        scripts: ["pnpm install"],
        extraPaths: ["pnpm-lock.yaml"],
        childEnv,
        expectedFingerprint: first.fingerprintToStore,
      }),
    ).toBe(first.fingerprintToStore);
    expect(
      await matchingSetupFingerprintAfterSetup({
        checkoutSha: "abc",
        cwd,
        scripts: ["pnpm install"],
        extraPaths: ["pnpm-lock.yaml"],
        childEnv: { PATH: "/usr/bin", TOKEN: "rotated" },
        expectedFingerprint: first.fingerprintToStore,
      }),
    ).toBeUndefined();
  });

  it("hits and keeps the live GH_CONFIG_DIR when only that path differs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-gh-config-"));
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-gh-config-store-"));
    await writeFile(join(cwd, "pnpm-lock.yaml"), "lock-a");
    const first = await resolveSetupCacheState({
      cacheDir,
      checkoutSha: "abc",
      cwd,
      worktreeId: "wt-1",
      scripts: ["pnpm install"],
      extraPaths: ["pnpm-lock.yaml"],
      childEnv: { PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: "/tmp/session-a" },
    });
    if (first.skip || !first.fingerprintToStore) throw new Error("expected a fingerprint");
    await writeStoredSetupCache(cacheDir, "wt-1", cwd, first.fingerprintToStore, {
      TOKEN: "from-setup",
      GH_CONFIG_DIR: "/tmp/session-a",
    });
    expect(
      await resolveSetupCacheState({
        cacheDir,
        checkoutSha: "abc",
        cwd,
        worktreeId: "wt-1",
        scripts: ["pnpm install"],
        extraPaths: ["pnpm-lock.yaml"],
        childEnv: { PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: "/tmp/session-b" },
      }),
    ).toEqual({
      skip: true,
      environment: { TOKEN: "from-setup", GH_CONFIG_DIR: "/tmp/session-b" },
    });
  });
});
