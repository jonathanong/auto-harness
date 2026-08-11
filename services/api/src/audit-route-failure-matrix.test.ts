import { describe, expect, it } from "vitest";

import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";
import { durableMutationFailureCases } from "./audit-route-failure-test-helpers.ts";
import { auditFixture } from "./audit-test-helpers.ts";

describe("audit route failures", () => {
  it("records failed outcomes when durable mutation handlers reject", async () => {
    for (const [method, path, body, durableMethod, action] of durableMutationFailureCases) {
      const plane = auditFixture();
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
