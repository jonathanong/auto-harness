import { mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { assertDaemonPathsAllowed } from "./allowed-roots.ts";

const fixtures: string[] = [];

async function tempDir(name: string): Promise<string> {
  const dir = join(tmpdir(), `ah-workspace-overlap-${name}-${String(Date.now())}`);
  await mkdir(dir, { recursive: true });
  fixtures.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("rejects canonical workspace overlap with repository execution paths", async () => {
  const root = await tempDir("alias");
  const repository = join(root, "repository");
  const aliases = join(root, "aliases");
  await mkdir(repository);
  await mkdir(aliases);
  await symlink(repository, join(aliases, "workspace"));

  await expect(
    assertDaemonPathsAllowed({
      hostId: "host",
      allowedRoots: [root],
      repositories: [{ id: "repo", path: repository, defaultBranch: "main", worktrees: [] }],
      workspacePools: [
        {
          workspacePoolId: "pool",
          slots: [{ id: "slot", name: "slot", path: join(aliases, "workspace") }],
        },
      ],
      providerAccounts: [],
    }),
  ).rejects.toThrow("workspace slot overlaps repository execution path");
});

it("rejects workspace nesting and a slot that contains a worktree", async () => {
  const root = await tempDir("nesting");
  const repository = join(root, "repository");
  const worktree = join(root, "worktree");
  const parentSlot = join(root, "workspace");
  await mkdir(repository);
  await mkdir(worktree);
  await mkdir(join(parentSlot, "nested"), { recursive: true });
  const base = {
    hostId: "host",
    allowedRoots: [root],
    repositories: [
      {
        id: "repo",
        path: repository,
        defaultBranch: "main",
        worktrees: [{ id: "worktree", name: "worktree", path: worktree, labels: [] }],
      },
    ],
    providerAccounts: [],
  };

  await expect(
    assertDaemonPathsAllowed({
      ...base,
      workspacePools: [
        {
          workspacePoolId: "pool",
          slots: [
            { id: "parent", name: "parent", path: parentSlot },
            { id: "child", name: "child", path: join(parentSlot, "nested") },
          ],
        },
      ],
    }),
  ).rejects.toThrow("workspace slots overlap");
  await expect(
    assertDaemonPathsAllowed({
      ...base,
      workspacePools: [
        {
          workspacePoolId: "pool",
          slots: [{ id: "slot", name: "slot", path: worktree }],
        },
      ],
    }),
  ).rejects.toThrow("workspace slot overlaps repository execution path");
});
