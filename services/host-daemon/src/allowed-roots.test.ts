import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertClaimedPathsAllowed,
  assertDaemonPathsAllowed,
  assertPathWithinAllowedRoots,
  isWithinRoot,
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

  it("skips the check when no roots are configured and fails closed if none resolve", async () => {
    expect(await assertPathWithinAllowedRoots("/tmp/x", [])).toBe("/tmp/x");
    await expect(assertPathWithinAllowedRoots("/tmp/x", ["/no/such/root-ah"])).rejects.toThrow(
      "no usable allowed roots",
    );
    await expect(assertPathWithinAllowedRoots("relative", ["/tmp"])).rejects.toThrow("absolute");
  });

  it("validates inventory paths and terminal hooks against allowed roots", async () => {
    const root = await tempDir("cfg");
    const repo = join(root, "repo");
    await mkdir(repo);
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
  });

  it("re-checks claimed cwd and hooks before use", async () => {
    const root = await tempDir("claim");
    const repo = join(root, "repo");
    await mkdir(repo);
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
