import { expect, it } from "vitest";
import { config, terminal } from "../test-helpers/blackboard-reporting-fixtures.ts";
import { createBlackboardReporting, type BlackboardReporting } from "./blackboard-reporting.ts";
import { reportingDelivery } from "./blackboard-terminal-reporting.ts";
import { assertBlackboardDeliverySnapshot } from "./webhook-blackboard-snapshot.ts";
import type { BlackboardDeliveryPayload } from "./webhook-outbox.ts";
import type { WebhookTransportRequest } from "./webhook-delivery-types.ts";
import { event } from "../test-helpers/blackboard-reporting-fixtures.ts";
import { terminalSnapshotFromStream, type StreamRecord } from "./blackboard-session-stream.ts";

type Request = WebhookTransportRequest & { feedback: BlackboardDeliveryPayload };
function request(reporting: BlackboardReporting): Request {
  const row = terminal();
  const delivery = reportingDelivery(row)!;
  return {
    idempotencyKey: delivery.id,
    destination: delivery.destination,
    event: delivery.event,
    body: JSON.stringify(delivery.event),
    feedback: reporting.snapshot(row, delivery.event.id),
  };
}

it("rejects malformed persisted snapshots rather than transporting undeclared fields", () => {
  const reporting = createBlackboardReporting(config());
  const mutations: Array<(value: Request) => void> = [
    (value) => {
      value.destination.configurationId = "ordinary-webhook";
    },
    (value) => {
      Object.assign(value.feedback, { rawLog: "private output" });
    },
    (value) => {
      Object.assign(value.feedback.identity, { prompt: "private prompt" });
    },
    (value) => {
      value.feedback.identity.version = "invalid version";
    },
    (value) => {
      value.feedback.identity.parentSessionId = "invalid parent";
    },
    (value) => {
      value.feedback.authorization.principalId = "";
    },
    (value) => {
      value.feedback.authorization.workspacePoolId = "workspace";
    },
    (value) => {
      value.feedback.envelope.sourceEventId = "other-event";
    },
    (value) => {
      value.feedback.identity.sessionId = "other-session";
    },
    (value) => {
      value.feedback.authorization.repositoryId = null;
    },
    (value) => {
      value.feedback.authorization.policyVersion = 2;
    },
  ];
  for (const mutate of mutations) {
    const value = request(reporting);
    mutate(value);
    expect(() =>
      assertBlackboardDeliverySnapshot(
        value.feedback,
        value.event.subject.id,
        value.event.id,
        value.event.data.repositoryId,
        value.event.data.workspacePoolId,
        value.destination.configurationId,
        value.destination.configurationVersion,
      ),
    ).toThrow("invalid Blackboard delivery");
  }
});

it("retains terminal history but marks malformed or excessive stream evidence unavailable", () => {
  type Attribute = NonNullable<NonNullable<StreamRecord["dynamodb"]>["NewImage"]>[string];
  let nested: Attribute = { N: "1" };
  for (let depth = 0; depth < 8; depth++) nested = { M: { child: nested } };
  const invalidEvidence: Attribute[] = [
    { NULL: true },
    { S: "x".repeat(257) },
    { L: Array.from({ length: 257 }, () => ({ N: "1" })) },
    { M: { schemaVersion: { N: "2" } } },
    nested,
  ];
  for (const evidence of invalidEvidence) {
    const record: StreamRecord = event(terminal()).Records[0]!;
    record.dynamodb!.NewImage!.result = { M: { feedback: evidence } };
    const snapshot = terminalSnapshotFromStream(record);
    expect(snapshot).toMatchObject({ id: "session", status: "completed" });
    expect(snapshot?.result).toBeUndefined();
  }
  const workspace: StreamRecord = event(terminal({ repositoryId: "", workspacePoolId: "pool" }))
    .Records[0]!;
  workspace.dynamodb!.NewImage!.parentSessionId = { S: "x".repeat(513) };
  workspace.dynamodb!.NewImage!.reportingPolicyVersion = { N: "NaN" };
  expect(terminalSnapshotFromStream(workspace)).toMatchObject({
    repositoryId: "",
    workspacePoolId: "pool",
  });
  expect(terminalSnapshotFromStream(workspace)?.parentSessionId).toBeUndefined();
  expect(terminalSnapshotFromStream(workspace)?.reportingPolicyVersion).toBeUndefined();
  expect(reportingDelivery(terminalSnapshotFromStream(workspace)!)).toBeUndefined();
});

it("does not snapshot unfinished, unscoped, invalid-date or unsettled stream rows", () => {
  const mutations: Array<(record: StreamRecord) => void> = [
    (record) => {
      delete record.dynamodb!.NewImage;
    },
    (record) => {
      record.dynamodb!.NewImage!.status = { S: "running" };
    },
    (record) => {
      record.dynamodb!.NewImage!.repositoryId = { NULL: true };
    },
    (record) => {
      record.dynamodb!.NewImage!.completedAt = { S: "invalid-date" };
    },
    (record) => {
      record.dynamodb!.NewImage!.reportingMode = { S: "interactive" };
    },
    (record) => {
      record.dynamodb!.NewImage!.assignmentConnectionId = { S: "connection" };
    },
  ];
  for (const mutate of mutations) {
    const record: StreamRecord = event(terminal()).Records[0]!;
    mutate(record);
    expect(terminalSnapshotFromStream(record)).toBeUndefined();
  }
});
