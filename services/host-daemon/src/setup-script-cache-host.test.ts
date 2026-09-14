import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  matchingSetupFingerprintAfterSetup,
  resolveSetupCacheState,
  writeStoredSetupCache,
} from "./setup-script-cache.ts";

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-host-cwd-"));
  const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-host-store-"));
  const hostDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-host-file-"));
  const hostFile = join(hostDir, "host-environment");
  await writeFile(join(cwd, "pnpm-lock.yaml"), "lock-a");
  await writeFile(hostFile, "export TOKEN=one");
  return { cwd, cacheDir, hostFile };
}

describe("setup script host-file fingerprint", () => {
  it("misses when a declared host-owned file changes", async () => {
    const { cwd, cacheDir, hostFile } = await fixture();
    const first = await resolveSetupCacheState({
      cacheDir,
      checkoutSha: "abc",
      cwd,
      worktreeId: "wt-1",
      scripts: [". /opt/auto-harness/setup/host-environment"],
      extraPaths: ["pnpm-lock.yaml"],
      hostPaths: [hostFile],
    });
    expect(first).toMatchObject({ skip: false, fingerprintToStore: expect.any(String) });
    if (first.skip || !first.fingerprintToStore) throw new Error("expected a fingerprint");
    await writeStoredSetupCache(cacheDir, "wt-1", cwd, first.fingerprintToStore, { TOKEN: "one" });
    expect(
      await resolveSetupCacheState({
        cacheDir,
        checkoutSha: "abc",
        cwd,
        worktreeId: "wt-1",
        scripts: [". /opt/auto-harness/setup/host-environment"],
        extraPaths: ["pnpm-lock.yaml"],
        hostPaths: [hostFile],
      }),
    ).toEqual({ skip: true, environment: { TOKEN: "one" } });
    await writeFile(hostFile, "export TOKEN=two");
    const miss = await resolveSetupCacheState({
      cacheDir,
      checkoutSha: "abc",
      cwd,
      worktreeId: "wt-1",
      scripts: [". /opt/auto-harness/setup/host-environment"],
      extraPaths: ["pnpm-lock.yaml"],
      hostPaths: [hostFile],
    });
    expect(miss.skip).toBe(false);
    expect(miss).toMatchObject({ fingerprintToStore: expect.any(String) });
    expect(miss).not.toEqual(first);
  });

  it("keeps the SHA/script/relative-extra fingerprint when host files are omitted", async () => {
    const { cwd, cacheDir, hostFile } = await fixture();
    const relativeOnly = await resolveSetupCacheState({
      cacheDir,
      checkoutSha: "abc",
      cwd,
      worktreeId: "wt-1",
      scripts: ["pnpm install"],
      extraPaths: ["pnpm-lock.yaml"],
    });
    const emptyHost = await resolveSetupCacheState({
      cacheDir,
      checkoutSha: "abc",
      cwd,
      worktreeId: "wt-1",
      scripts: ["pnpm install"],
      extraPaths: ["pnpm-lock.yaml"],
      hostPaths: [],
    });
    expect(emptyHost).toEqual(relativeOnly);
    await writeFile(hostFile, "changed-but-undeclared");
    expect(
      await resolveSetupCacheState({
        cacheDir,
        checkoutSha: "abc",
        cwd,
        worktreeId: "wt-1",
        scripts: ["pnpm install"],
        extraPaths: ["pnpm-lock.yaml"],
      }),
    ).toEqual(relativeOnly);
  });

  it("does not store when a declared host file changes during setup", async () => {
    const { cwd, hostFile } = await fixture();
    const first = await resolveSetupCacheState({
      cacheDir: await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-host-rehash-")),
      checkoutSha: "abc",
      cwd,
      worktreeId: "wt-1",
      scripts: ["true"],
      extraPaths: [],
      hostPaths: [hostFile],
    });
    if (first.skip || !first.fingerprintToStore) throw new Error("expected a fingerprint");
    await writeFile(hostFile, "export TOKEN=two");
    expect(
      await matchingSetupFingerprintAfterSetup({
        checkoutSha: "abc",
        cwd,
        scripts: ["true"],
        extraPaths: [],
        hostPaths: [hostFile],
        expectedFingerprint: first.fingerprintToStore,
      }),
    ).toBeUndefined();
  });

  it("misses when a declared host-owned file is unreadable and honors rehash signals", async () => {
    const { cwd, cacheDir, hostFile } = await fixture();
    const missing = join(hostFile, "..", "missing-environment");
    expect(
      await resolveSetupCacheState({
        cacheDir,
        checkoutSha: "abc",
        cwd,
        worktreeId: "wt-1",
        scripts: ["true"],
        extraPaths: [],
        hostPaths: [missing],
      }),
    ).toEqual({ skip: false });
    const first = await resolveSetupCacheState({
      cacheDir,
      checkoutSha: "abc",
      cwd,
      worktreeId: "wt-1",
      scripts: ["true"],
      extraPaths: [],
      hostPaths: [hostFile],
    });
    if (first.skip || !first.fingerprintToStore) throw new Error("expected a fingerprint");
    expect(
      await matchingSetupFingerprintAfterSetup({
        checkoutSha: "abc",
        cwd,
        scripts: ["true"],
        extraPaths: [],
        hostPaths: [hostFile],
        expectedFingerprint: first.fingerprintToStore,
        signal: AbortSignal.abort(),
      }),
    ).toBeUndefined();
    expect(
      await matchingSetupFingerprintAfterSetup({
        checkoutSha: "abc",
        cwd,
        scripts: ["true"],
        extraPaths: [],
        hostPaths: [hostFile],
        expectedFingerprint: first.fingerprintToStore,
        signal: new AbortController().signal,
      }),
    ).toBe(first.fingerprintToStore);
  });

  it("does not treat foreign Windows host paths as cwd-relative files", async () => {
    if (process.platform === "win32") return;
    const { cwd, cacheDir, hostFile } = await fixture();
    const relativeForeign = [
      "C:\\auto-harness\\setup\\env",
      "\\\\host\\share\\env",
      "\\\\\\server\\share\\env",
    ];
    for (const path of relativeForeign) await writeFile(join(cwd, path), "not-the-host-file");
    // Slash-form `//tmp/...` and mixed `/\host/...` would otherwise open as local paths.
    for (const path of [...relativeForeign, `/${hostFile}`, "/\\host/share/env"]) {
      expect(
        await resolveSetupCacheState({
          cacheDir,
          checkoutSha: "abc",
          cwd,
          worktreeId: "wt-1",
          scripts: ["true"],
          extraPaths: [],
          hostPaths: [path],
        }),
      ).toEqual({ skip: false });
    }
  });
});
