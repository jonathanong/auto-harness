import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostToServerMessage } from "@auto-harness/shared";

import { parseDaemonConfig } from "./config.ts";
import { DaemonLoop } from "./daemon-loop.ts";
import type { ProcessRunner } from "./executor.ts";
import { createAcknowledgingLoopbackTransport } from "../test-helpers/daemon-loop-test-helpers.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("DaemonLoop workspace assignment", () => {
  it("runs a workspace slot when Git is unavailable without invoking Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "ah-daemon-workspace-"));
    roots.push(root);
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
    const runner: ProcessRunner = {
      async run(options) {
        if (options.argv[0]?.includes("git")) throw new Error("workspace session invoked git");
        options.onChunk({ stream: "stdout", data: "workspace done\n" });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const messages: HostToServerMessage[] = [];
    const transport = createAcknowledgingLoopbackTransport({
      sendToServer: (message) => void messages.push(message),
    });
    const loop = new DaemonLoop({
      config,
      transport,
      processRunner: runner,
      runtime: { daemonVersion: "test", gitReady: false, gitReadinessReason: "git_unavailable" },
    });

    try {
      await loop.start();
      transport.deliver({
        type: "session:assign",
        sessionId: "workspace-session",
        attemptId: "attempt",
        sessionType: "workspace",
        repositoryId: null,
        workspacePoolId: "pool",
        workspaceSlotId: "slot",
        destroyWorkspaceAfter: true,
        prompt: "run",
        resolvedArgv: ["workspace-command"],
        timeout: 30,
        worktreeId: null,
        assignedAt: new Date().toISOString(),
      });
      await loop.waitForIdle();

      expect(
        messages.some(
          (message) =>
            message.type === "session:status" &&
            message.sessionId === "workspace-session" &&
            message.status === "completed" &&
            message.workspaceSlotId === "slot",
        ),
      ).toBe(true);
      expect(await readdir(slot)).toEqual([]);
    } finally {
      loop.stop();
    }
  });
});
