import { describe, expect, it } from "vitest";

import { createResumeRouteFixture } from "./local-server-test-helpers.ts";

async function resumableSource(fixture: Awaited<ReturnType<typeof createResumeRouteFixture>>) {
  const { plane, accounts, invoke } = fixture;
  const created = await invoke(
    "/api/v1/sessions",
    { repositoryId: "repo", prompt: "initial", target: { commandId: "command" }, timeout: 30 },
    accounts[0]!.apiKey,
  );
  expect(created.status).toBe(201);
  const sourceId = (created.json as { id: string }).id;
  Object.assign(plane.state.sessions.get(sourceId)!, { status: "completed", hostId: "host-1" });
  return sourceId;
}

describe("session resume target/fallbacks override — route validation", () => {
  it.each([
    ["a string", "not-an-object"],
    ["null", null],
    ["an array", []],
  ])("rejects a target that is %s", async (_label, target) => {
    const fixture = await createResumeRouteFixture();
    const sourceId = await resumableSource(fixture);
    const result = await fixture.invoke(
      `/api/v1/sessions/${sourceId}/resume`,
      { target },
      fixture.accounts[0]!.apiKey,
    );
    expect(result.status).toBe(400);
    expect(result.json).toMatchObject({
      error: { code: "VALIDATION_ERROR", message: "invalid resume overrides" },
    });
  });

  it("accepts a well-formed object target and records retargeted:true on the audit entry", async () => {
    const fixture = await createResumeRouteFixture();
    const sourceId = await resumableSource(fixture);
    const result = await fixture.invoke(
      `/api/v1/sessions/${sourceId}/resume`,
      { target: { commandId: "command" } },
      fixture.accounts[0]!.apiKey,
    );
    expect(result.status).toBe(201);
    const audits = await fixture.plane.listAuditLogs({ action: "session:resume" });
    expect(audits.items[0]).toMatchObject({ metadata: { retargeted: true } });
  });

  it("omits retargeted from the audit entry when no target override is given", async () => {
    const fixture = await createResumeRouteFixture();
    const sourceId = await resumableSource(fixture);
    const result = await fixture.invoke(
      `/api/v1/sessions/${sourceId}/resume`,
      {},
      fixture.accounts[0]!.apiKey,
    );
    expect(result.status).toBe(201);
    const audits = await fixture.plane.listAuditLogs({ action: "session:resume" });
    expect((audits.items[0] as { metadata?: Record<string, unknown> }).metadata?.retargeted).toBe(
      undefined,
    );
  });

  it("classifies fallbacks-without-target as 400, not the coarse route shape error", async () => {
    // An array fallbacks value passes the route's coarse shape check on its own;
    // "fallbacks requires target" is the control plane's semantic rejection, and
    // it must still classify as 400 rather than falling into the 409 bucket.
    const fixture = await createResumeRouteFixture();
    const sourceId = await resumableSource(fixture);
    const result = await fixture.invoke(
      `/api/v1/sessions/${sourceId}/resume`,
      { fallbacks: [{ commandId: "command" }] },
      fixture.accounts[0]!.apiKey,
    );
    expect(result.status).toBe(400);
    expect(result.json).toMatchObject({
      error: { code: "VALIDATION_ERROR", message: "fallbacks requires target" },
    });
  });

  it("rejects a fallbacks value that is not an array", async () => {
    const fixture = await createResumeRouteFixture();
    const sourceId = await resumableSource(fixture);
    const result = await fixture.invoke(
      `/api/v1/sessions/${sourceId}/resume`,
      { target: { commandId: "command" }, fallbacks: "not-an-array" },
      fixture.accounts[0]!.apiKey,
    );
    expect(result.status).toBe(400);
  });

  it("rejects an unknown field even alongside a well-formed target", async () => {
    const fixture = await createResumeRouteFixture();
    const sourceId = await resumableSource(fixture);
    const result = await fixture.invoke(
      `/api/v1/sessions/${sourceId}/resume`,
      { target: { commandId: "command" }, notAllowed: true },
      fixture.accounts[0]!.apiKey,
    );
    expect(result.status).toBe(400);
  });

  it("classifies an unknown commandId in the override as 400, not 409", async () => {
    const fixture = await createResumeRouteFixture();
    const sourceId = await resumableSource(fixture);
    const result = await fixture.invoke(
      `/api/v1/sessions/${sourceId}/resume`,
      { target: { commandId: "does-not-exist" } },
      fixture.accounts[0]!.apiKey,
    );
    expect(result.status).toBe(400);
    expect(result.json).toMatchObject({
      error: { code: "VALIDATION_ERROR", message: "commandId does-not-exist not found" },
    });
  });
});
