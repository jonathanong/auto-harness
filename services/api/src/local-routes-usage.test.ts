import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

describe("usage report authorization", () => {
  it("requires auth, a repository scope, and permits an authorized read-only scope", async () => {
    const auth = new AuthService({ mode: "required", secret: "s".repeat(32) });
    const { apiKey } = await auth.createServiceAccount({
      name: "reader",
      role: "read-only",
      allowedRepositoryIds: ["repo-1"],
    });
    const { handler } = createLocalApp({ plane: new ControlPlane(), authService: auth });

    expect((await invokeHandler(handler, "GET", "/api/v1/usage?repositoryId=repo-1")).status).toBe(
      401,
    );
    const headers = { authorization: `Bearer ${apiKey}` };
    expect((await invokeHandler(handler, "GET", "/api/v1/usage", undefined, headers)).status).toBe(
      400,
    );
    const response = await invokeHandler(
      handler,
      "GET",
      "/api/v1/usage?repositoryId=repo-1",
      undefined,
      headers,
    );
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ aggregate: { costMicros: "0" }, items: [] });
    expect(
      (await invokeHandler(handler, "GET", "/api/v1/usage?repositoryId=repo-2", undefined, headers))
        .status,
    ).toBe(404);
  });
});
