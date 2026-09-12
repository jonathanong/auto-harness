import { describe, expect, it } from "vitest";

import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";
import { auditAppendFailureRequests } from "../test-helpers/audit-route-failure-test-helpers.ts";
import { auditFixture } from "../test-helpers/audit-test-helpers.ts";

describe("audit route acknowledgement", () => {
  it("fails closed when each route's durable audit append is unavailable", async () => {
    for (const [method, path, body] of auditAppendFailureRequests) {
      const plane = auditFixture();
      const { handler } = createLocalApp({ plane, authMode: "disabled" });
      plane.appendAuditLog = async () => {
        throw new Error("audit down");
      };
      expect((await invokeHandler(handler, method, path, body)).status).toBe(500);
    }
  });
});
