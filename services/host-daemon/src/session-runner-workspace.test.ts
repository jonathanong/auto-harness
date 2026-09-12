import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionAssign } from "@auto-harness/shared";

import { parseDaemonConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import { SessionRunner } from "./session-runner.ts";
import { WorkspaceManager } from "./workspace-manager.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

async function workspaceRunner() {
  const root = await mkdtemp(join(tmpdir(), "ah-workspace-run-"));
  roots.push(root);
  const slot = join(root, "slot");
  await mkdir(slot);
  const config = parseDaemonConfig({
    hostId: "workspace-host",
    allowedRoots: [root],
    setupScript: "host-setup",
    repositories: [],
    workspacePools: [
      { workspacePoolId: "pool", slots: [{ id: "slot", name: "slot", path: slot }] },
    ],
  });
  const setup: string[] = [];
  const commandCwds: string[] = [];
  const processRunner: ProcessRunner = {
    async run(options) {
      if (options.argv[1] === "-c") {
        setup.push(options.argv[2] ?? "");
        return { exitCode: 0, timedOut: false, signal: null, environment: options.env };
      }
      throw new Error("workspace setup test must not invoke git or a terminal hook");
    },
  };
  const commandRunner: ProcessRunner = {
    async run(options) {
      commandCwds.push(options.cwd);
      await writeFile(join(options.cwd, "command-output"), "done");
      return { exitCode: 0, timedOut: false, signal: null };
    },
  };
  const assign: SessionAssign = {
    sessionId: "workspace-session",
    attemptId: "attempt",
    repositoryId: null,
    sessionType: "workspace",
    workspacePoolId: "pool",
    workspaceSlotId: "slot",
    prompt: "run job",
    resolvedArgv: ["job"],
    timeout: 30,
    worktreeId: null,
    setupScript: "workspace-profile",
    destroyWorkspaceAfter: true,
  };
  return {
    slot,
    config,
    setup,
    commandCwds,
    assign,
    processRunner,
    commandRunner,
    runner: new SessionRunner({
      worktrees: {} as never,
      workspaces: new WorkspaceManager(config),
      processRunner,
      commandRunner,
    }),
  };
}

describe("SessionRunner workspace sessions", () => {
  it("runs host then resolved setup in a non-git slot and resets it after success", async () => {
    const test = await workspaceRunner();

    const result = await test.runner.run(test.assign);

    expect(result.status).toBe("completed");
    expect(test.commandCwds).toEqual([expect.stringMatching(/\/slot$/)]);
    expect(test.setup).toHaveLength(2);
    expect(test.setup[0]).toContain("host-setup");
    expect(test.setup[1]).toContain("workspace-profile");
    expect(await readdir(test.slot)).toEqual([]);
    expect(result.logs.some((entry) => entry.content.includes("Checking out ref"))).toBe(false);
  });

  it("turns a successful command into a cleanup failure and retains the slot error", async () => {
    const test = await workspaceRunner();
    const brokenWorkspace = new WorkspaceManager(test.config, {
      rm: async () => {
        throw new Error("disk is read-only");
      },
      mkdir: async () => undefined,
    });
    const runner = new SessionRunner({
      worktrees: {} as never,
      workspaces: brokenWorkspace,
      processRunner: test.processRunner,
      commandRunner: test.commandRunner,
    });

    const result = await runner.run(test.assign);

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "workspace_cleanup_failed",
      workspaceSlotId: "slot",
      workspaceSlotError: expect.stringContaining("disk is read-only"),
    });
  });

  it("preserves the primary failure when cleanup also fails", async () => {
    const test = await workspaceRunner();
    const brokenWorkspace = new WorkspaceManager(test.config, {
      rm: async () => {
        throw new Error("disk is read-only");
      },
      mkdir: async () => undefined,
    });
    const runner = new SessionRunner({
      worktrees: {} as never,
      workspaces: brokenWorkspace,
      processRunner: test.processRunner,
      commandRunner: {
        async run() {
          throw new Error("primary command failure");
        },
      },
    });

    const result = await runner.run(test.assign);

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "setup_failed",
      errorMessage: "primary command failure",
      workspaceSlotId: "slot",
      workspaceSlotError: expect.stringContaining("disk is read-only"),
    });
  });
});
