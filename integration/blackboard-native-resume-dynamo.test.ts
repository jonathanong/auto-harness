import { writeFile } from "node:fs/promises";
import { beforeEach, expect, it } from "vitest";
import type { HostWireMessage } from "../modules/shared/src/index.ts";
import { createDynamoTestCtx } from "../services/api/test-helpers/dynamo-test-helpers.ts";
import { blackboardServer } from "../services/api/test-helpers/blackboard-server.ts";
import { ControlPlane } from "../services/api/src/control-plane.ts";
import { createBlackboardReporting } from "../services/api/src/blackboard-reporting.ts";
import { SessionRunner } from "../services/host-daemon/src/session-runner.ts";
import { sessionAssignFromWire } from "../services/host-daemon/src/session-assign.ts";
import { WorktreeManager } from "../services/host-daemon/src/worktree-manager.ts";
import { parseDaemonConfig } from "../services/host-daemon/src/config.ts";
import { seed, NOW, feedback } from "../test-helpers/blackboard-reporting-roundtrip.ts";
const ctx = createDynamoTestCtx("BbNativeResume");
beforeEach(async () => {
  await ctx.storage!.clearAll();
});

it("persists native resume prompt bindings through producer, assignment reread, reconnect wire and actual provider argv", async () => {
  const storage = ctx.storage!;
  const server = await blackboardServer();
  try {
    const reporting = createBlackboardReporting({
      schemaVersion: 1,
      version: 1,
      url: server.url,
      token: "test-writer-credential",
      policies: [{ repositoryId: "repo", repository: "owner/repo", principalIds: ["operator"] }],
    });
    let sequence = 0;
    const wires: Extract<HostWireMessage, { type: "session:assign" }>[] = [];
    const plane = new ControlPlane({
      storage,
      blackboardReporting: reporting,
      shardCount: 1,
      now: () => NOW,
      idFactory: () => `native-${++sequence}`,
      connectionIdFactory: () => "connection",
      onHostMessage: (_id, message) => {
        if (message.type === "session:assign") wires.push(message);
      },
    });
    await seed(plane, storage);
    expect(
      await plane.registerHostDurable({
        hostId: "host",
        worktrees: [{ id: "wt", name: "wt", path: "/wt", repositoryId: "repo", labels: [] }],
        commandProfiles: [],
        replaceExisting: true,
      }),
    ).toMatchObject({ ok: true });
    const config = parseDaemonConfig({
      hostId: "host",
      repositories: [
        {
          id: "repo",
          path: "/repo",
          defaultBranch: "main",
          worktrees: [{ id: "wt", name: "wt", path: "/wt", labels: [] }],
        },
      ],
    });
    const worktrees = new WorktreeManager(config, {
      ensureRepo: async () => undefined,
      ensureWorktree: async () => undefined,
      checkoutRef: async () => undefined,
      revParse: async () => "synthetic-ref",
    });
    const argvRequests: string[][] = [];
    const runner = new SessionRunner({
      worktrees,
      authorizeCommandStart: async (assign) =>
        Boolean(
          (
            await plane.handleHostMessageDurable(
              {
                type: "session:command-start",
                sessionId: assign.sessionId,
                worktreeId: assign.worktreeId,
                attemptId: assign.attemptId!,
              },
              "connection",
              false,
              7,
            )
          ).sessionCommandStartAcknowledged,
        ),
      processRunner: {
        async run(options) {
          if (options.argv[0] === "codex") {
            argvRequests.push([...options.argv]);
            expect(options.env?.AGENT_BLACKBOARD_TOKEN).toBeUndefined();
            await writeFile(options.env!.HARNESS_FEEDBACK_PATH!, JSON.stringify(feedback));
          }
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
    });
    const created = await plane.createSessionDurable(
      { repositoryId: "repo", prompt: "initial", target: { commandId: "command" }, timeout: 30 },
      { principalId: "operator" },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error);
    expect(await plane.assignQueuedDurable()).toHaveLength(1);
    const initial = wires.at(-1)!;
    expect(await storage.getSession(created.session.id, true)).toMatchObject({
      feedbackPromptBindings: [{ index: 2, start: 0, end: 7 }],
    });
    const result = await runner.run(sessionAssignFromWire(initial));
    expect(result.status).toBe("completed");
    expect(
      await plane.handleHostMessageDurable(
        {
          type: "session:status",
          sessionId: initial.sessionId,
          worktreeId: initial.worktreeId,
          attemptId: initial.attemptId!,
          status: "completed",
          cliResumeRef: "native-ref",
          result: result.result!,
        },
        "connection",
        false,
        7,
      ),
    ).toHaveProperty("sessionStatusAcknowledged");
    const resumed = await plane.resumeSessionDurable(initial.sessionId, {
      prompt: "follow-up",
      principalId: "operator",
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error(resumed.error);
    expect(await plane.assignQueuedDurable()).toHaveLength(1);
    const stored = (await storage.getSession(resumed.session.id, true))!;
    expect(stored.resolvedArgv).toEqual([
      "codex",
      "resume",
      "native-ref",
      "follow-up",
      "--model",
      "example",
    ]);
    expect(stored.feedbackPromptBindings).toEqual([{ index: 3, start: 0, end: 9 }]);
    // The reconnect command comes from the frozen durable row, preserving the exact prompt spans.
    const reconnectWire = {
      ...wires.at(-1)!,
      resolvedArgv: stored.resolvedArgv!,
      feedbackPromptBindings: stored.feedbackPromptBindings!,
    };
    const continued = await runner.run(sessionAssignFromWire(reconnectWire));
    expect(continued.result?.feedback).toEqual(feedback);
    expect(argvRequests[1]![3]).toContain("Harness reporting requirement");
    expect(argvRequests[1]!.slice(4)).toEqual(["--model", "example"]);
    expect(argvRequests[0]![2]).toContain("Harness reporting requirement");
  } finally {
    await server.close();
  }
});
