import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { runTerminalHook } from "./terminal-hook.ts";

it("resolves and executes a legacy relative hook from the actual execution cwd", async () => {
  const root = join(tmpdir(), `ah-relative-hook-${String(Date.now())}`);
  const cwd = join(root, "nested", "worktree");
  await mkdir(cwd, { recursive: true });
  try {
    const run = vi.fn(async () => ({ exitCode: 0, timedOut: false, signal: null }));
    await runTerminalHook(
      { run },
      {
        scriptPath: "../../hook.sh",
        cwd,
        sessionId: "session",
        status: "completed",
        worktreePath: cwd,
        repositoryPath: root,
        allowedRoots: [root],
      },
    );
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ argv: ["/bin/sh", join(await realpath(root), "hook.sh")] }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("executes the canonical hook path returned by the allowed-root check", async () => {
  const root = join(tmpdir(), `ah-canonical-hook-${String(Date.now())}`);
  await mkdir(join(root, "hooks"), { recursive: true });
  const target = join(root, "hooks", "done.sh");
  const alias = join(root, "alias.sh");
  await writeFile(target, "#!/bin/sh\n");
  await symlink(target, alias);
  try {
    const canonicalTarget = await realpath(target);
    const run = vi.fn(async () => ({ exitCode: 0, timedOut: false, signal: null }));
    await runTerminalHook(
      { run },
      {
        scriptPath: alias,
        cwd: root,
        sessionId: "session",
        status: "completed",
        worktreePath: root,
        repositoryPath: root,
        allowedRoots: [root],
      },
    );
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ argv: ["/bin/sh", canonicalTarget] }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
