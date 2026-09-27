import { expect, it } from "vitest";
import { blackboardServer } from "../test-helpers/blackboard-server.ts";
import { config, session, terminal } from "../test-helpers/blackboard-reporting-fixtures.ts";
import {
  blackboardTransport,
  createBlackboardReporting,
  reportingPolicyFields,
  type BlackboardReporting,
} from "./blackboard-reporting.ts";
import {
  reportingDelivery,
  sessionReporting,
  terminalFeedbackEnvelope,
} from "./blackboard-terminal-reporting.ts";
import type { BlackboardDeliveryPayload } from "./webhook-outbox.ts";
import type { WebhookTransportRequest } from "./webhook-delivery-types.ts";

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

it("rejects mismatched delivery identity and authorization before sending any HTTP request", async () => {
  const server = await blackboardServer();
  try {
    const reporting = createBlackboardReporting(config(server.url));
    const transport = blackboardTransport(reporting);
    const mutations: Array<(value: Request) => void> = [
      (value) => {
        value.feedback.envelope.sourceEventId = "other-event";
      },
      (value) => {
        value.feedback.identity.sessionId = "other-session";
      },
      (value) => {
        value.feedback.authorization.policyVersion = 2;
      },
      (value) => {
        value.feedback.authorization.repositoryId = "other-repository";
      },
      (value) => {
        value.feedback.authorization.workspacePoolId = "other-workspace";
      },
      (value) => {
        value.feedback.authorization.principalId = "forbidden";
      },
      (value) => {
        value.feedback.envelope.repositories = ["owner/other"];
      },
      (value) => {
        value.feedback.envelope.repositories = ["owner/repo", "owner/other"];
      },
      (value) => {
        value.destination.configurationId = "ordinary-webhook";
      },
    ];
    for (const mutate of mutations) {
      const value = request(reporting);
      mutate(value);
      expect(await transport.deliver(value)).toEqual({
        ok: false,
        failureCode: "configuration-unavailable",
      });
    }
    const { feedback: _, ...missing } = request(reporting);
    expect(await transport.deliver(missing)).toEqual({
      ok: false,
      failureCode: "configuration-unavailable",
    });
    expect(server.requests).toEqual([]);
    const valid = request(reporting);
    valid.leaseExpiresAt = new Date(Date.now() + 30_000).toISOString();
    expect(await transport.deliver(valid)).toEqual({ ok: true });
    expect(server.entries.get("session")![0]!.data).toEqual(valid.feedback.envelope);
  } finally {
    await server.close();
  }
});

it("renders scoped findings and tool evidence while preserving the actual work outcome", () => {
  const original = terminal();
  const feedback = {
    ...original.result!.feedback!,
    completionKind: "shepherd-terminal" as const,
    shepherdAction: "ready" as const,
    assessments: {
      architecture: "finding" as const,
      sandbox: "none-observed" as const,
      tools: "finding" as const,
    },
    toolAssessments: [
      { name: "no-mistakes", status: "used" as const, reason: "Checked the affected module." },
    ],
    findings: [
      {
        category: "architecture" as const,
        recurrence: "recurring" as const,
        summary: "Ownership crosses the module boundary.",
        source: "services/api/src/blackboard-reporting.ts",
      },
      {
        category: "tool" as const,
        recurrence: "one-off" as const,
        summary: "The affected checker rejected a valid input.",
      },
    ],
  };
  const rendered = terminalFeedbackEnvelope(
    terminal({ result: { ...original.result!, feedback } }),
    "finding-event",
  );
  expect(rendered.markdown).toContain("Tool no-mistakes: used; Checked the affected module.");
  expect(rendered.markdown).toContain(
    "recurring / architecture: Ownership crosses the module boundary. (services/api/src/blackboard-reporting.ts)",
  );
  expect(rendered.markdown).toContain(
    "one-off / tool: The affected checker rejected a valid input.",
  );
  expect(rendered.markdown).toContain("Shepherd terminal action: ready.");
  expect(rendered.markdown).not.toMatch(/private prompt|private output/);
  expect(rendered.workOutcome).toBe("success");
  expect(
    terminalFeedbackEnvelope(
      terminal({
        result: {
          ...original.result!,
          feedback: { ...feedback, completionKind: "policy-refusal" },
        },
      }),
      "refusal-event",
    ).workOutcome,
  ).toBe("policy-refusal");
  expect(reportingDelivery(session())).toBeUndefined();
  expect(sessionReporting(session({ result: undefined }))).toMatchObject({
    completionStatus: "in-progress",
    feedbackCoverage: "not-started",
  });
  const dead = { ...reportingDelivery(original)!, state: "dead" as const };
  expect(sessionReporting(original, dead)).toMatchObject({
    deliveryStatus: "blocked",
    completionStatus: "incomplete",
  });
  expect(
    reportingPolicyFields(createBlackboardReporting(config()), "repo", "user:operator"),
  ).toMatchObject({ reportingRepository: "owner/repo", reportingPolicyVersion: 1 });
});
