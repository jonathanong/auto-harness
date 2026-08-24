import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertClaimedPathsAllowed,
  assertDaemonPathsAllowed,
  assertPathWithinAllowedRoots,
  isForeignWindowsAbsolutePath,
  isWithinRoot,
  resolveHookPath,
  resolvePathForRootCheck,
} from "./allowed-roots.ts";
import type { DaemonConfig } from "./config-types.ts";

const fixtures: string[] = [];

async function tempDir(name: string): Promise<string> {
  const dir = join(tmpdir(), `ah-allowed-roots-${name}-${String(Date.now())}`);
  await mkdir(dir, { recursive: true });
  fixtures.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("allowed roots realpath checks", () => {
  it("accepts paths under a realpath'd root, including not-yet-created children", async () => {
    const root = await tempDir("root");
    const nested = join(root, "repo", "wt");
    expect(await assertPathWithinAllowedRoots(nested, [root])).toBe(
      await resolvePathForRootCheck(nested),
    );
  });

  it("rejects lexical and symlink escapes", async () => {
    const root = await tempDir("inside");
    const outside = await tempDir("outside");
    await writeFile(join(outside, "secret"), "nope");
    await symlink(outside, join(root, "escape"));
    await expect(assertPathWithinAllowedRoots(join(root, ".."), [root])).rejects.toThrow(
      "outside allowed roots",
    );
    await expect(
      assertPathWithinAllowedRoots(join(root, "escape", "secret"), [root]),
    ).rejects.toThrow("outside allowed roots");
  });

  it("rejects dangling symlinks in an unresolved path suffix", async () => {
    const root = await tempDir("dangling");
    await symlink(join(root, "outside-not-created"), join(root, "dangling"));

    await expect(
      assertPathWithinAllowedRoots(join(root, "dangling", "future"), [root]),
    ).rejects.toThrow("dangling symlink");
  });

  it("skips the check when no roots are configured and fails closed if none resolve", async () => {
    expect(await assertPathWithinAllowedRoots("/tmp/x", [])).toBe("/tmp/x");
    await expect(assertPathWithinAllowedRoots("/tmp/x", ["/no/such/root-ah"])).rejects.toThrow(
      "no usable allowed roots",
    );
    await expect(assertPathWithinAllowedRoots("relative", ["/tmp"])).rejects.toThrow("absolute");
  });

  it("returns canonical claimed paths and uses native hook absoluteness", async () => {
    const root = await tempDir("canonical-claim");
    const repo = join(root, "repo");
    await mkdir(repo);
    await mkdir(join(repo, "wt"));
    await writeFile(join(repo, "wt", "hook.sh"), "#!/bin/sh\n");
    const claimed = await assertClaimedPathsAllowed({
      cwd: join(repo, "wt"),
      repositoryPath: repo,
      terminalHookScript: "hook.sh",
      allowedRoots: [root],
    });
    expect(claimed.cwd).toBe(await resolvePathForRootCheck(join(repo, "wt")));
    expect(claimed.repositoryPath).toBe(await realpath(repo));
    expect(claimed.terminalHookScript).toBe(
      await resolvePathForRootCheck(join(await realpath(repo), "wt", "hook.sh")),
    );
    expect(isForeignWindowsAbsolutePath("C:\\hooks\\done.cmd")).toBe(true);
    expect(isForeignWindowsAbsolutePath("\\\\server\\share\\done.cmd")).toBe(true);
    expect(() => resolveHookPath("/repo", "C:\\hooks\\done.cmd")).toThrow("not valid on");
  });

  it("validates inventory paths and terminal hooks against allowed roots", async () => {
    const root = await tempDir("cfg");
    const repo = join(root, "repo");
    await mkdir(repo);
    await mkdir(join(repo, "hooks"));
    await writeFile(join(repo, "hooks", "done.sh"), "#!/bin/sh\n");
    await writeFile(join(root, "hook.sh"), "#!/bin/sh\n");
    const config: DaemonConfig = {
      hostId: "host",
      allowedRoots: [root],
      repositories: [
        {
          id: "repo",
          path: repo,
          defaultBranch: "main",
          terminalHookScript: join(root, "hook.sh"),
          worktrees: [{ id: "wt", name: "wt", path: join(repo, "wt"), labels: [] }],
        },
      ],
      providerAccounts: [],
    };
    await assertDaemonPathsAllowed({
      ...config,
      repositories: [{ ...config.repositories[0]!, terminalHookScript: "hooks/done.sh" }],
    });
    await assertDaemonPathsAllowed(config);
    await expect(
      assertDaemonPathsAllowed({
        ...config,
        repositories: [{ ...config.repositories[0]!, path: "/etc" }],
      }),
    ).rejects.toThrow("outside allowed roots");
  });

  it("rejects a terminal hook whose resolved target does not exist", async () => {
    const root = await tempDir("missing-hook");
    const repo = join(root, "repo");
    await mkdir(repo);
    await expect(
      assertDaemonPathsAllowed({
        hostId: "host",
        allowedRoots: [root],
        repositories: [
          {
            id: "repo",
            path: repo,
            defaultBranch: "main",
            terminalHookScript: "missing-hook.sh",
            worktrees: [],
          },
        ],
        providerAccounts: [],
      }),
    ).rejects.toThrow("terminal hook target does not exist");
  });

  it("does nothing when allowed roots are unset", async () => {
    await expect(
      assertDaemonPathsAllowed({
        hostId: "host",
        repositories: [
          {
            id: "repo",
            path: "/etc",
            defaultBranch: "main",
            worktrees: [],
          },
        ],
        providerAccounts: [],
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed across Windows volumes and allows a ..hidden child", () => {
    expect(isWithinRoot("C:\\harness", "D:\\secret", win32)).toBe(false);
    expect(isWithinRoot("C:\\harness", "C:\\windows", win32)).toBe(false);
    expect(isWithinRoot("C:\\harness", "C:\\harness", win32)).toBe(true);
    expect(isWithinRoot("C:\\harness", "C:\\harness\\wt", win32)).toBe(true);
    expect(isWithinRoot("C:\\harness", "C:\\harness\\..hidden", win32)).toBe(true);
    expect(isWithinRoot("C:\\harness", "C:\\harness\\..", win32)).toBe(false);
    expect(isWithinRoot("/root", "/etc")).toBe(false);
    expect(isWithinRoot("/root", "/root/..hidden")).toBe(true);
    expect(isWithinRoot("/root", "/root/..")).toBe(false);
    // A POSIX host treats this as an ordinary child name; foreign-platform syntax must not
    // override the injected host-native relative/absolute result.
    expect(isWithinRoot("/root", "/root/C:\\windows")).toBe(true);
  });

  it("re-checks claimed cwd and hooks before use", async () => {
    const root = await tempDir("claim");
    const repo = join(root, "repo");
    await mkdir(repo);
    await writeFile(join(root, "hook.sh"), "#!/bin/sh\n");
    await assertClaimedPathsAllowed({
      cwd: join(repo, "wt"),
      repositoryPath: repo,
      terminalHookScript: join(root, "hook.sh"),
      allowedRoots: [root],
    });
    await expect(
      assertClaimedPathsAllowed({
        cwd: "/etc",
        repositoryPath: repo,
        allowedRoots: [root],
      }),
    ).rejects.toThrow("outside allowed roots");
    await assertClaimedPathsAllowed({ cwd: "/etc", repositoryPath: "/etc" });
  });
});
