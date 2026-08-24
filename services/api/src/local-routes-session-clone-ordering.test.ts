import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { baseSessionBody, seedBaseCommand } from "./control-plane-test-helpers.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

describe("session clone dispatch ordering", () => {
  it("dispatches a clone only after its success audit is stored", async () => {
    let id = 0;
    const plane = new ControlPlane({ idFactory: () => `session-${++id}` });
    seedBaseCommand(plane);
    plane.createSession(baseSessionBody());
    let assignmentCalls = 0;
    plane.requestAssignment = async () => void assignmentCalls++;
    const response = await invokeHandler(
      createLocalApp({ plane }).handler,
      "POST",
      "/api/v1/sessions/session-1/clone",
    );
    expect(response.status).toBe(201);
    expect(assignmentCalls).toBe(1);
  });
});
