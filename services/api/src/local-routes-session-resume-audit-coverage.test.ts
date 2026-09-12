import { expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

it("fails closed when loading a resume source and recording that failure both fail", async () => {
  const plane = new ControlPlane();
  plane.getSessionDurable = async () => {
    throw new Error("read unavailable");
  };
  plane.appendAuditLog = async () => {
    throw new Error("audit unavailable");
  };
  const response = await invokeHandler(
    createLocalApp({ plane }).handler,
    "POST",
    "/api/v1/sessions/session/resume",
    {},
  );
  expect(response.status).toBe(500);
});
