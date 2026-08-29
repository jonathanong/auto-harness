import { describe, expect, it } from "vitest";

import { createResumeRouteFixture } from "./local-server-test-helpers.ts";

describe("session resume ownership", () => {
  it("allows a replacement credential to resume visible terminal work and owns the descendant", async () => {
    const { plane, accounts, invoke } = await createResumeRouteFixture([
      "original-automation",
      "replacement-automation",
    ]);
    const [original, replacement] = accounts;

    const created = await invoke(
      "/api/v1/sessions",
      { repositoryId: "repo", prompt: "initial", target: { commandId: "command" }, timeout: 30 },
      original.apiKey,
    );
    expect(created.status).toBe(201);
    const sourceId = (created.json as { id: string }).id;
    Object.assign(plane.state.sessions.get(sourceId)!, { status: "completed", hostId: "host-1" });

    const resumed = await invoke(`/api/v1/sessions/${sourceId}/resume`, {}, replacement.apiKey);

    expect(resumed.status).toBe(201);
    const resumedId = (resumed.json as { id: string }).id;
    expect(plane.state.sessions.get(resumedId)).toMatchObject({
      resumedFromSessionId: sourceId,
      principalId: replacement.account.id,
      metadata: { createdBy: replacement.account.id },
    });
  });
});
