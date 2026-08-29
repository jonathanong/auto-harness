import { describe, expect, it } from "vitest";

import { createResumeRouteFixture } from "./local-server-test-helpers.ts";

describe("session resume timeout upper bound", () => {
  it("rejects a resume timeout override above 604800 seconds and accepts exactly 604800", async () => {
    const {
      plane,
      accounts: [account],
      invoke,
    } = await createResumeRouteFixture();

    const created = await invoke(
      "/api/v1/sessions",
      { repositoryId: "repo", prompt: "initial", target: { commandId: "command" }, timeout: 30 },
      account.apiKey,
    );
    expect(created.status).toBe(201);
    const sourceId = (created.json as { id: string }).id;
    Object.assign(plane.state.sessions.get(sourceId)!, { status: "completed", hostId: "host-1" });

    const rejected = await invoke(
      `/api/v1/sessions/${sourceId}/resume`,
      { timeout: 604_801 },
      account.apiKey,
    );
    expect(rejected.status).toBe(400);
    expect(rejected.json).toMatchObject({
      error: { code: "VALIDATION_ERROR", message: "invalid resume overrides" },
    });

    const accepted = await invoke(
      `/api/v1/sessions/${sourceId}/resume`,
      { timeout: 604_800 },
      account.apiKey,
    );
    expect(accepted.status).toBe(201);
    const resumedId = (accepted.json as { id: string }).id;
    expect(plane.state.sessions.get(resumedId)).toMatchObject({ timeout: 604_800 });
  });
});
