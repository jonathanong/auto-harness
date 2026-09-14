import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { parseDaemonConfig } from "./config.ts";
import { checkoutFetchFailure } from "./git-commands.ts";
import { SessionRunner } from "./session-runner.ts";
import { WorkspaceManager } from "./workspace-manager.ts";
import { WorktreeManager } from "./worktree-manager.ts";
import { baseAssign } from "../test-helpers/session-runner-test-helpers.ts";
import type { GitClient } from "./git.ts";

const git: GitClient = {
  ensureRepo: async () => undefined,
  ensureWorktree: async () => undefined,
  checkoutRef: async () => undefined,
  prepareMainCheckout: async () => undefined,
  revParse: async () => "deadbeef",
};

describe("SessionRunner setup-cache claim release", () => {
  it("notifies when a worktree claim is released", async () => {
    const released = vi.fn();
    const config = parseDaemonConfig({
      hostId: "a1",
      repositories: [
        {
          id: "repo-1",
          path: "/repo",
          defaultBranch: "main",
          worktrees: [{ id: "wt-1", name: "wt-1", path: "/repo/wt-1", labels: ["codex"] }],
        },
      ],
    });
    const sessionRunner = new SessionRunner({
      worktrees: new WorktreeManager(config, git),
      processRunner: {
        async run() {
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
      onSetupCacheClaimReleased: released,
    });
    await sessionRunner.run(baseAssign());
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("notifies when a deferred hook later releases the claim", async () => {
    const released = vi.fn();
    const config = parseDaemonConfig({
      hostId: "a1",
      repositories: [
        {
          id: "repo-1",
          path: "/repo",
          defaultBranch: "main",
          terminalHookScript: "/hook.sh",
          worktrees: [{ id: "wt-1", name: "wt-1", path: "/repo/wt-1", labels: [] }],
        },
      ],
    });
    const sessionRunner = new SessionRunner({
      worktrees: new WorktreeManager(config, {
        ...git,
        checkoutRef: async () => {
          throw checkoutFetchFailure("Failed to fetch ref missing", "network unavailable");
        },
      }),
      processRunner: {
        async run() {
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
      onSetupCacheClaimReleased: released,
    });
    const result = await sessionRunner.run(
      baseAssign({ ref: "missing", infrastructureRetryCount: 0 }),
      {
        deferCheckoutFetchFailureHook: true,
      },
    );
    expect(released).not.toHaveBeenCalled();
    await result.settleDeferredTerminalHook?.(false);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("notifies when a scheduled main checkout claim is released", async () => {
    const released = vi.fn();
    const config = parseDaemonConfig({
      hostId: "a1",
      repositories: [{ id: "repo-1", path: "/repo", defaultBranch: "main", worktrees: [] }],
    });
    const sessionRunner = new SessionRunner({
      worktrees: new WorktreeManager(config, git),
      processRunner: {
        async run() {
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
      onSetupCacheClaimReleased: released,
    });
    await sessionRunner.run(
      baseAssign({
        worktreeId: null,
        sessionType: "scheduled",
      }),
    );
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("notifies when a workspace slot is released", async () => {
    const released = vi.fn();
    const root = await mkdtemp(join(tmpdir(), "ah-setup-cache-ws-"));
    const slot = join(root, "slot");
    await mkdir(slot);
    const config = parseDaemonConfig({
      hostId: "workspace-host",
      allowedRoots: [root],
      repositories: [],
      workspacePools: [
        { workspacePoolId: "pool", slots: [{ id: "slot", name: "slot", path: slot }] },
      ],
    });
    const sessionRunner = new SessionRunner({
      worktrees: {} as never,
      workspaces: new WorkspaceManager(config),
      processRunner: {
        async run() {
          throw new Error("workspace must not invoke git");
        },
      },
      commandRunner: {
        async run() {
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
      onSetupCacheClaimReleased: released,
    });
    await sessionRunner.run({
      ...baseAssign({
        repositoryId: null,
        worktreeId: null,
        sessionType: "workspace",
        resolvedArgv: ["job"],
      }),
      workspacePoolId: "pool",
      workspaceSlotId: "slot",
      destroyWorkspaceAfter: false,
    });
    expect(released).toHaveBeenCalledTimes(1);
  });
});
