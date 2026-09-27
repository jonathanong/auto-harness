import { describe, expect, it } from "vitest";
import { blackboardServer } from "../test-helpers/blackboard-server.ts";
import {
  config,
  session,
  terminal,
  event,
  NOW,
  ARN,
} from "../test-helpers/blackboard-reporting-fixtures.ts";
import {
  createBlackboardReporting,
  reportingDelivery,
  sessionReporting,
  blackboardTransport,
} from "./blackboard-reporting.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import {
  processBlackboardSessionStream,
  withSessionReporting,
  drainBlackboardOutbox,
} from "./blackboard-lifecycle.ts";
import { createWebhookDelivery, type DurableWebhookDelivery } from "./webhook-outbox.ts";
import { terminalFeedbackEnvelope } from "./blackboard-terminal-reporting.ts";

describe("trusted Blackboard terminal reporting", () => {
  it("classifies a completed changed attempt as success without overriding controller status", () => {
    const completed = terminal();
    const changed = terminal({
      result: {
        ...completed.result!,
        feedback: { ...completed.result!.feedback!, completionKind: "changed" },
      },
    });
    expect(terminalFeedbackEnvelope(changed, "terminal:changed").workOutcome).toBe("success");
    expect(
      terminalFeedbackEnvelope({ ...changed, status: "failed" }, "terminal:failed").workOutcome,
    ).toBe("failure");
  });
  it("freezes old terminal evidence before a resumed live row, then retries identical bytes after lost acknowledgement", async () => {
    const server = await blackboardServer();
    try {
      const reporting = createBlackboardReporting(config(server.url));
      const state = createControlPlaneState({ blackboardReporting: reporting });
      const deliveries = new Map<string, DurableWebhookDelivery>();
      state.storage = {
        getSession: async () => session({ attemptId: "resumed" }),
        enqueueWebhookDelivery: async (input: Parameters<typeof createWebhookDelivery>[0]) => {
          const row = createWebhookDelivery(input);
          const previous = deliveries.get(row.id);
          if (!previous) deliveries.set(row.id, row);
          return { created: !previous, delivery: previous ?? row };
        },
        getWebhookDelivery: async (id: string) => deliveries.get(id) ?? null,
      } as never;
      const old = terminal();
      expect(await processBlackboardSessionStream(state, event(old), ARN)).toEqual({
        batchItemFailures: [],
      });
      const delivery = [...deliveries.values()][0]!;
      expect(delivery.feedback?.envelope.workOutcome).toBe("no-change");
      expect(JSON.stringify(delivery)).not.toContain("private prompt");
      expect(JSON.stringify(delivery)).not.toContain("private output");
      expect(JSON.stringify(delivery)).not.toContain(config().token);
      await processBlackboardSessionStream(state, event(terminal({ result: undefined }), "2"), ARN);
      expect(deliveries.get(delivery.id)).toBe(delivery);
      const request = {
        idempotencyKey: delivery.id,
        destination: delivery.destination,
        event: delivery.event,
        body: JSON.stringify(delivery.event),
        feedback: delivery.feedback!,
      };
      server.state.loseAppendAck = true;
      expect(await blackboardTransport(reporting).deliver(request)).toEqual({
        ok: false,
        failureCode: "transient-failure",
      });
      expect(await blackboardTransport(reporting).deliver(request)).toEqual({ ok: true });
      expect(server.entries.get("session")).toHaveLength(1);
      expect(server.entries.get("session")![0]!.data).toEqual(delivery.feedback!.envelope);
      deliveries.set(delivery.id, { ...delivery, state: "delivered", deliveredAt: NOW });
      expect((await withSessionReporting(state, old)).reporting?.completionStatus).toBe("complete");
    } finally {
      await server.close();
    }
  });
  it("waits for claim and hook settlement, records all non-start outcomes, and never invents complete evidence", async () => {
    const reporting = createBlackboardReporting(config());
    const state = createControlPlaneState({ blackboardReporting: reporting });
    const deliveries: DurableWebhookDelivery[] = [];
    state.storage = {
      enqueueWebhookDelivery: async (input: Parameters<typeof createWebhookDelivery>[0]) => {
        const row = createWebhookDelivery(input);
        deliveries.push(row);
        return { created: true, delivery: row };
      },
    } as never;
    await processBlackboardSessionStream(state, event(terminal({ activeHostId: "host" })), ARN);
    expect(deliveries).toHaveLength(0);
    await processBlackboardSessionStream(
      state,
      event(
        terminal({
          terminalHookHandoff: {
            handoffId: "handoff",
            hostId: "host",
            repositoryId: "repo",
            worktreeId: null,
            status: "completed",
            expiresAt: NOW,
          },
        }),
      ),
      ARN,
    );
    expect(deliveries).toHaveLength(0);
    for (const status of ["cancelled", "timed_out", "failed"] as const)
      await processBlackboardSessionStream(
        state,
        event(terminal({ status, attemptId: undefined, result: undefined })),
        ARN,
      );
    expect(deliveries.map((row) => row.feedback?.envelope.workOutcome)).toEqual([
      "cancelled",
      "timed-out",
      "failure",
    ]);
    expect(
      deliveries.every((row) => row.feedback?.envelope.feedbackCoverage.status === "not-started"),
    ).toBe(true);
    const missing = terminal({ result: undefined });
    const delivered = { ...reportingDelivery(missing)!, state: "delivered" as const };
    expect(sessionReporting(missing, delivered)).toMatchObject({
      deliveryStatus: "delivered",
      feedbackCoverage: "unavailable",
      completionStatus: "incomplete",
    });
    await expect(
      processBlackboardSessionStream(state, event(missing), "wrong-arn"),
    ).rejects.toThrow("unexpected");
    await drainBlackboardOutbox(createControlPlaneState());
  });
});
