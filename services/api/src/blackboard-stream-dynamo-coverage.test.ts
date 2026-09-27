import { randomUUID } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import { createDynamoTestCtx } from "../test-helpers/dynamo-test-helpers.ts";
import { blackboardServer } from "../test-helpers/blackboard-server.ts";
import {
  ARN,
  config,
  event,
  session,
  terminal,
} from "../test-helpers/blackboard-reporting-fixtures.ts";
import { createBlackboardReporting, reportingDelivery } from "./blackboard-reporting.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import {
  drainBlackboardOutbox,
  enqueueBlackboardSession,
  isBlackboardSessionStream,
  processBlackboardSessionStream,
  withSessionReporting,
} from "./blackboard-lifecycle.ts";
const ctx = createDynamoTestCtx(`Bcov${randomUUID().slice(0, 6)}`);
beforeEach(async () => {
  expect(ctx.storage).not.toBeNull();
  await ctx.storage!.clearAll();
});

it("validates event provenance and reports only the failed stream sequence while persisting clean records", async () => {
  const state = createControlPlaneState({
    blackboardReporting: createBlackboardReporting(config()),
  });
  state.storage = ctx.storage!;
  for (const invalid of [
    null,
    {},
    { Records: {} },
    { Records: Array.from({ length: 101 }, () => ({ eventSource: "aws:dynamodb" })) },
    { Records: [null] },
    { Records: [{ eventSource: "foreign" }] },
  ])
    expect(isBlackboardSessionStream(invalid)).toBe(false);
  expect(isBlackboardSessionStream(event(terminal()))).toBe(true);
  expect(isBlackboardSessionStream({ Records: [] })).toBe(true);
  await expect(
    processBlackboardSessionStream(createControlPlaneState(), event(terminal()), ARN),
  ).rejects.toThrow("durable storage");
  await expect(processBlackboardSessionStream(state, event(terminal()), "")).rejects.toThrow(
    "unexpected",
  );
  const corrupt = event(terminal(), "11");
  corrupt.Records[0]!.dynamodb.NewImage.id = { S: "different-session" };
  const clean = event(terminal({ id: "clean" }), "12");
  expect(
    await processBlackboardSessionStream(
      state,
      { Records: [...corrupt.Records, ...clean.Records] },
      ARN,
    ),
  ).toEqual({ batchItemFailures: [{ itemIdentifier: "11" }] });
  expect(await ctx.storage!.getWebhookDelivery(reportingDelivery(terminal())!.id)).toBeNull();
  expect(
    await ctx.storage!.getWebhookDelivery(reportingDelivery(terminal({ id: "clean" }))!.id),
  ).toMatchObject({ state: "pending", event: { subject: { id: "clean" } } });
  for (const mutate of [
    (value: ReturnType<typeof event>) => {
      value.Records[0]!.dynamodb.Keys.id.S = "bad id";
    },
    (value: ReturnType<typeof event>) => {
      value.Records[0]!.dynamodb.SequenceNumber = "not-a-sequence";
    },
  ]) {
    const value = event(terminal());
    mutate(value);
    await expect(processBlackboardSessionStream(state, value, ARN)).rejects.toThrow(
      "invalid Blackboard session event",
    );
  }
  const removed = event(terminal());
  removed.Records[0]!.eventName = "REMOVE";
  expect(await processBlackboardSessionStream(state, removed, "wrong-arn")).toEqual({
    batchItemFailures: [],
  });
});

it("drains a real persisted workspace snapshot to verified HTTP readback without writing a receipt into Sessions", async () => {
  const server = await blackboardServer();
  try {
    const reporting = createBlackboardReporting({
      ...config(server.url),
      policies: [
        { workspacePoolId: "pool", repository: "owner/workspace", principalIds: ["system"] },
      ],
    });
    const state = createControlPlaneState({ blackboardReporting: reporting });
    state.storage = ctx.storage!;
    const row = terminal({
      repositoryId: "",
      workspacePoolId: "pool",
      reportingRepository: "owner/workspace",
      principalId: undefined,
      parentSessionId: "parent",
      reportingAgentVersion: undefined,
      result: undefined,
      attemptId: undefined,
      completedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await ctx.storage!.putSession(row);
    expect(await withSessionReporting(state, session({ status: "queued" }))).toMatchObject({
      reporting: { completionStatus: "in-progress" },
    });
    await enqueueBlackboardSession(state, row);
    const expected = reportingDelivery(row)!;
    expect(await ctx.storage!.getWebhookDelivery(expected.id)).toMatchObject({
      feedback: {
        identity: { parentSessionId: "parent", version: "unknown" },
        authorization: { repositoryId: null, workspacePoolId: "pool", principalId: "system" },
        envelope: { feedbackCoverage: { status: "not-started" } },
      },
    });
    await drainBlackboardOutbox(state, () => false);
    expect(server.requests).toEqual([]);
    await drainBlackboardOutbox(state);
    expect((await withSessionReporting(state, row)).reporting).toMatchObject({
      deliveryStatus: "delivered",
      completionStatus: "incomplete",
      feedbackCoverage: "not-started",
      sourceEventId: expected.event.id,
    });
    expect(server.entries.get(row.id)).toHaveLength(1);
    expect(await ctx.storage!.getSession(row.id, true)).toEqual(row);
    expect(
      (await withSessionReporting(createControlPlaneState(), row)).reporting?.deliveryStatus,
    ).toBe("pending");
    const unconfigured = createControlPlaneState();
    unconfigured.storage = ctx.storage!;
    await enqueueBlackboardSession(unconfigured, terminal({ id: "unconfigured" }));
    await drainBlackboardOutbox(unconfigured);
    expect(
      await ctx.storage!.getWebhookDelivery(
        reportingDelivery(terminal({ id: "unconfigured" }))!.id,
      ),
    ).toBeNull();
    await enqueueBlackboardSession(state, session());
  } finally {
    await server.close();
  }
});
