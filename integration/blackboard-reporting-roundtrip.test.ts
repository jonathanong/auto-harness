import { writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import type { HostWireMessage } from "../modules/shared/src/index.ts";
import { createDynamoTestCtx } from "../services/api/test-helpers/dynamo-test-helpers.ts";
import { blackboardServer } from "../services/api/test-helpers/blackboard-server.ts";
import { ControlPlane } from "../services/api/src/control-plane.ts";
import { createBlackboardReporting } from "../services/api/src/blackboard-reporting.ts";
import { triggerScheduleDurable } from "../services/api/src/control-plane-schedule-fire.ts";
import {
  processBlackboardSessionStream,
  drainBlackboardOutbox,
  withSessionReporting,
} from "../services/api/src/blackboard-lifecycle.ts";
import { SessionRunner } from "../services/host-daemon/src/session-runner.ts";
import { sessionAssignFromWire } from "../services/host-daemon/src/session-assign.ts";
import { WorktreeManager } from "../services/host-daemon/src/worktree-manager.ts";
import { parseDaemonConfig } from "../services/host-daemon/src/config.ts";

import {
  attribute,
  seed,
  NOW,
  ARN,
  feedback,
} from "../test-helpers/blackboard-reporting-roundtrip.ts";
const ctx = createDynamoTestCtx("BbRoundtrip");
beforeEach(async () => {
  await ctx.storage!.clearAll();
});
describe("required reporting producer and completion roundtrip", () => {
  it("captures scheduled policy, persists initial prompt spans, executes wire instructions, and verifies terminal delivery", async () => {
    expect(ctx.storage).not.toBeNull();
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
      const wires: Extract<HostWireMessage, { type: "session:assign" }>[] = [];
      const plane = new ControlPlane({
        storage,
        blackboardReporting: reporting,
        shardCount: 1,
        now: () => NOW,
        idFactory: () => "scheduled",
        connectionIdFactory: () => "connection",
        onHostMessage: (_id, message) => {
          if (message.type === "session:assign") wires.push(message);
        },
      });
      await seed(plane, storage);
      expect(
        await plane.registerHostDurable({
          hostId: "host",
          worktrees: [],
          commandProfiles: [],
          capabilities: ["scheduled-main-checkout"],
          repositories: [{ id: "repo", path: "/repo", defaultBranch: "main" }],
          replaceExisting: true,
        }),
      ).toMatchObject({ ok: true });
      expect(
        await plane.putScheduleDurable({
          id: "nightly",
          name: "inspection",
          repositoryId: "repo",
          principalId: "operator",
          prompt: "inspect repository",
          target: { commandId: "command" },
          cron: "* * * * *",
          timeout: 30,
        }),
      ).toMatchObject({ ok: true });
      expect(await triggerScheduleDurable(plane.state, "nightly")).toMatchObject({ ok: true });
      const queued = (await storage.getSession("scheduled", true))!;
      expect(queued).toMatchObject({
        reportingMode: "autonomous",
        reportingRepository: "owner/repo",
        reportingPolicyVersion: 1,
        principalId: "operator",
      });
      server.state.refuse = true;
      expect(await plane.assignScheduledQueuedDurable()).toEqual([]);
      expect(wires).toHaveLength(0);
      server.state.refuse = false;
      expect(await plane.assignScheduledQueuedDurable()).toHaveLength(1);
      const assigned = (await storage.getSession("scheduled", true))!;
      expect(assigned.feedbackPromptBindings).toEqual([{ index: 2, start: 0, end: 18 }]);
      expect(wires[0]?.feedbackPromptBindings).toEqual(assigned.feedbackPromptBindings);
      const config = parseDaemonConfig({
        hostId: "host",
        repositories: [{ id: "repo", path: "/repo", defaultBranch: "main", worktrees: [] }],
      });
      const worktrees = new WorktreeManager(config, {
        ensureRepo: async () => undefined,
        ensureWorktree: async () => undefined,
        checkoutRef: async () => undefined,
        prepareMainCheckout: async () => undefined,
        revParse: async () => "synthetic-ref",
      });
      let providerStarts = 0;
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
              providerStarts += 1;
              expect(options.argv[2]).toContain("Harness reporting requirement");
              expect(options.env?.AGENT_BLACKBOARD_TOKEN).toBeUndefined();
              await writeFile(options.env!.HARNESS_FEEDBACK_PATH!, JSON.stringify(feedback));
            }
            return { exitCode: 0, timedOut: false, signal: null };
          },
        },
      });
      const result = await runner.run(sessionAssignFromWire(wires[0]!));
      expect(providerStarts).toBe(1);
      expect(result.status).toBe("completed");
      expect(result.result?.feedback).toEqual(feedback);
      expect(
        await plane.handleHostMessageDurable(
          {
            type: "session:status",
            sessionId: assigned.id,
            worktreeId: null,
            attemptId: assigned.attemptId!,
            status: "completed",
            result: result.result!,
          },
          "connection",
          false,
          7,
        ),
      ).toHaveProperty("sessionStatusAcknowledged");
      const reread = (await storage.getSession(assigned.id, true))!;
      const stream = {
        Records: [
          {
            eventSource: "aws:dynamodb",
            eventSourceARN: ARN,
            eventName: "MODIFY",
            dynamodb: {
              Keys: { id: { S: reread.id } },
              SequenceNumber: "1",
              NewImage: attribute(reread).M!,
            },
          },
        ],
      };
      expect(await processBlackboardSessionStream(plane.state, stream, ARN)).toEqual({
        batchItemFailures: [],
      });
      await drainBlackboardOutbox(plane.state);
      expect((await withSessionReporting(plane.state, reread)).reporting).toMatchObject({
        deliveryStatus: "delivered",
        feedbackCoverage: "complete",
        completionStatus: "complete",
      });
      expect(
        server.entries.get("scheduled")?.some((entry) => entry.data.workOutcome === "no-change"),
      ).toBe(true);
    } finally {
      await server.close();
    }
  });
});
