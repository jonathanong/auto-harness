/* eslint-disable max-lines -- workspace assignment scenarios require complete wire fixtures. */
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostToServerMessage } from "@auto-harness/shared";

import { parseDaemonConfig } from "./config.ts";
import { DaemonLoop } from "./daemon-loop.ts";
import type { ProcessRunner } from "./executor.ts";
import {
  createAcknowledgingLoopbackTransport,
  flushMacrotask,
} from "../test-helpers/daemon-loop-test-helpers.ts";

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

  it("retains the assigned slot when a compatible runner omits workspace metadata", async () => {
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
    const messages: HostToServerMessage[] = [];
    const transport = createAcknowledgingLoopbackTransport({
      sendToServer: (message) => void messages.push(message),
    });
    const loop = new DaemonLoop({
      config,
      transport,
      runtime: { daemonVersion: "test", gitReady: false, gitReadinessReason: "git_unavailable" },
    });
    const oldController = new AbortController();
    let rejectOld!: (reason?: unknown) => void;
    const oldWork = new Promise<void>((_resolve, reject) => {
      rejectOld = reject;
    });
    (
      loop as unknown as {
        inflight: Map<
          string,
          {
            sessionId: string;
            attemptId: string;
            controller: AbortController;
            work: Promise<void>;
            acknowledged: boolean;
          }
        >;
        runner: { run: () => Promise<object> };
      }
    ).inflight.set("workspace-session\0old-attempt", {
      sessionId: "workspace-session",
      attemptId: "old-attempt",
      controller: oldController,
      work: oldWork,
      acknowledged: true,
    });
    (loop as unknown as { runner: { run: () => Promise<object> } }).runner = {
      async run() {
        return {
          status: "completed",
          exitCode: 0,
          logs: [],
          workspaceSlotError: "slot cleanup failed",
        };
      },
    };

    try {
      await loop.start();
      transport.deliver({
        type: "session:assign",
        sessionId: "workspace-session",
        attemptId: "new-attempt",
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
      await Promise.resolve();
      rejectOld(new Error("superseded work failed"));
      await flushMacrotask();
      await flushMacrotask();

      expect(oldController.signal.aborted).toBe(true);
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: "session:status",
          sessionId: "workspace-session",
          attemptId: "new-attempt",
          workspaceSlotId: "slot",
          workspaceSlotError: "slot cleanup failed",
        }),
      );
    } finally {
      loop.stop();
    }
  });

  it("reports a malformed workspace assignment without acknowledging it", async () => {
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
    const messages: HostToServerMessage[] = [];
    const logs: string[] = [];
    const transport = createAcknowledgingLoopbackTransport({
      sendToServer: (message) => void messages.push(message),
    });
    const loop = new DaemonLoop({
      config,
      transport,
      onLog: (line) => logs.push(line),
      runtime: { daemonVersion: "test", gitReady: false, gitReadinessReason: "git_unavailable" },
    });

    try {
      await loop.start();
      transport.deliver({
        type: "session:assign",
        sessionId: "invalid-workspace-session",
        attemptId: "attempt",
        sessionType: "workspace",
        repositoryId: null,
        workspacePoolId: "pool",
        destroyWorkspaceAfter: true,
        prompt: "run",
        resolvedArgv: ["workspace-command"],
        timeout: 30,
        worktreeId: null,
        assignedAt: new Date().toISOString(),
      });
      await flushMacrotask();

      expect(logs).toContainEqual(
        expect.stringContaining(
          "workspace assignment invalid-workspace-session is missing a workspace slot",
        ),
      );
      expect(messages.some((message) => message.type === "session:ack")).toBe(false);
    } finally {
      loop.stop();
    }
  });
});
