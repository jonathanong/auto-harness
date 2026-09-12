import { describe, expect, it } from "vitest";

import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";
import { durableMutationFailureCases } from "../test-helpers/audit-route-failure-test-helpers.ts";
import { auditFixture } from "../test-helpers/audit-test-helpers.ts";

function prepareFailureCase(
  plane: ReturnType<typeof auditFixture>,
  durableMethod: (typeof durableMutationFailureCases)[number][3],
): void {
  if (durableMethod !== "archiveSessionLogs") return;
  const session = plane.state.sessions.get("session-a");
  if (!session) throw new Error("session fixture missing");
  plane.state.sessions.set(session.id, {
    ...session,
    status: "completed",
    completedAt: "2026-08-10T00:00:00.000Z",
  });
}

describe("audit route failures", () => {
  it("records failed outcomes when durable mutation handlers reject", async () => {
    for (const [method, path, body, durableMethod, action] of durableMutationFailureCases) {
      const plane = auditFixture();
      prepareFailureCase(plane, durableMethod);
      Object.defineProperty(plane, durableMethod, {
        value: async () => {
          throw new Error("durable storage unavailable");
        },
      });
      const { handler } = createLocalApp({ plane, authMode: "disabled" });
      const response = await invokeHandler(handler, method, path, body);
      expect(response.status, action).toBe(500);
      expect((await plane.listAuditLogs({ action, outcome: "failed" })).items).toHaveLength(1);

      const noAudit = auditFixture();
      prepareFailureCase(noAudit, durableMethod);
      Object.defineProperty(noAudit, durableMethod, {
        value: async () => {
          throw new Error("durable storage unavailable");
        },
      });
      noAudit.appendAuditLog = async () => {
        throw new Error("audit unavailable");
      };
      expect(
        (
          await invokeHandler(
            createLocalApp({ plane: noAudit, authMode: "disabled" }).handler,
            method,
            path,
            body,
          )
        ).status,
        `${action} fails closed when its failed outcome cannot be written`,
      ).toBe(500);
    }
  });
});
