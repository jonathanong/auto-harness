import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeBadJson, invokeHandler } from "./local-server-test-helpers.ts";

describe("createLocalApp providers/provider-accounts/commands REST", () => {
  it("providers, provider accounts, and commands via handlers", async () => {
    let np = 0;
    let na = 0;
    let nc = 0;
    const plane = new ControlPlane({
      providerIdFactory: () => `prov-${++np}`,
      providerAccountIdFactory: () => `acct-${++na}`,
      commandIdFactory: () => `cmd-${++nc}`,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const { handler } = createLocalApp({ plane });
    const invoke = (method: string, path: string, body?: unknown) =>
      invokeHandler(handler, method, path, body);

    expect((await invoke("POST", "/api/v1/providers", { name: "" })).status).toBe(400);
    expect((await invoke("POST", "/api/v1/providers", {})).status).toBe(400); // name absent
    const prov = await invoke("POST", "/api/v1/providers", {
      name: "claude",
      defaultCommandId: null,
      usageRates: { currency: "USD", inputTokenMicros: "2" },
    });
    expect(prov.status).toBe(201);
    expect(prov.json).toMatchObject({
      id: "prov-1",
      name: "claude",
      usageRates: { currency: "USD", inputTokenMicros: "2" },
    });
    expect(
      (await invoke("POST", "/api/v1/providers", { name: "invalid-rate", usageRates: {} })).status,
    ).toBe(400);
    expect((await invoke("GET", "/api/v1/providers")).json).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: "prov-1" })]),
    });
    expect((await invoke("GET", "/api/v1/providers/prov-1")).json).toMatchObject({
      name: "claude",
    });
    expect((await invoke("GET", "/api/v1/providers/missing")).status).toBe(404);
    expect(
      (await invoke("PUT", "/api/v1/providers/prov-1", { name: "claude2" })).json,
    ).toMatchObject({ name: "claude2" });
    expect(
      (
        await invoke("PATCH", "/api/v1/providers/prov-1", {
          usageRates: { currency: "USD", outputTokenMicros: "3" },
        })
      ).json,
    ).toMatchObject({ usageRates: { currency: "USD", outputTokenMicros: "3" } });
    expect((await invoke("PATCH", "/api/v1/providers/prov-1", { usageRates: {} })).status).toBe(
      400,
    );
    expect(
      (await invoke("PATCH", "/api/v1/providers/prov-1", { usageRates: null })).json,
    ).not.toHaveProperty("usageRates");
    expect((await invoke("PUT", "/api/v1/providers/missing", { name: "x" })).status).toBe(404);

    expect((await invoke("POST", "/api/v1/provider-accounts", {})).status).toBe(400);
    const acct = await invoke("POST", "/api/v1/provider-accounts", {
      providerId: "prov-1",
      label: "x@y.com",
      usageLimitCooldownSeconds: 3600,
      maxConcurrentSessions: 1,
    });
    expect(acct.status).toBe(201);
    expect(acct.json).toMatchObject({ providerId: "prov-1", label: "x@y.com" });
    expect((await invoke("GET", "/api/v1/provider-accounts")).json).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ label: "x@y.com" })]),
    });
    const acctId = (acct.json as { id: string }).id;
    expect((await invoke("GET", `/api/v1/provider-accounts/${acctId}`)).status).toBe(200);
    expect((await invoke("GET", "/api/v1/provider-accounts/missing")).status).toBe(404);
    expect(
      (
        await invoke("PUT", `/api/v1/provider-accounts/${acctId}`, {
          providerId: "prov-1",
          label: "z@y.com",
          usageLimitCooldownSeconds: 7200,
          maxConcurrentSessions: 1,
        })
      ).json,
    ).toMatchObject({ label: "z@y.com" });
    expect(
      (await invoke("PATCH", `/api/v1/provider-accounts/${acctId}`, { providerId: "prov-1" }))
        .status,
    ).toBe(200);
    expect(
      (
        await invoke("PATCH", `/api/v1/provider-accounts/${acctId}`, {
          providerId: 42,
          label: 42,
          usageLimitCooldownSeconds: "not-a-number",
          maxConcurrentSessions: 1,
        })
      ).status,
    ).toBe(200);
    expect((await invoke("PUT", "/api/v1/provider-accounts/missing", { label: "x" })).status).toBe(
      404,
    );
    expect((await invoke("DELETE", `/api/v1/provider-accounts/${acctId}/usage-limit`)).status).toBe(
      200,
    );
    vi.spyOn(plane, "clearProviderAccountUsageLimitDurable").mockResolvedValueOnce({
      ok: false,
      conflict: true,
      error: "provider account changed concurrently; retry cooldown clear",
    });
    expect((await invoke("DELETE", `/api/v1/provider-accounts/${acctId}/usage-limit`)).status).toBe(
      409,
    );
    expect((await invoke("DELETE", "/api/v1/provider-accounts/missing/usage-limit")).status).toBe(
      404,
    );

    const cmd = await invoke("POST", "/api/v1/commands", {
      name: "echo-hi",
      argv: ["echo", "hi"],
      providerId: null,
      resumeArgvTemplate: ["echo", "resume", "{cliResumeRef}", "{prompt}"],
      resumeRefCapture: { stream: "stdout", linePrefix: "id: " },
    });
    expect(cmd.status).toBe(201);
    expect(cmd.json).toMatchObject({
      name: "echo-hi",
      appendPrompt: true,
      providerId: null,
      resumeArgvTemplate: ["echo", "resume", "{cliResumeRef}", "{prompt}"],
      resumeRefCapture: { stream: "stdout", linePrefix: "id: " },
    });
    expect((await invoke("POST", "/api/v1/commands", { name: "x", argv: [] })).status).toBe(400);
    expect((await invoke("POST", "/api/v1/commands", {})).status).toBe(400); // name/argv absent
    expect((await invoke("GET", "/api/v1/commands")).json).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ name: "echo-hi" })]),
    });
    const cmdId = (cmd.json as { id: string }).id;
    expect((await invoke("GET", `/api/v1/commands/${cmdId}`)).status).toBe(200);
    expect((await invoke("GET", "/api/v1/commands/missing")).status).toBe(404);
    expect(
      (
        await invoke("PATCH", `/api/v1/commands/${cmdId}`, {
          appendPrompt: false,
          resumeRefCapture: { stream: "stderr", linePrefix: "resume: " },
        })
      ).json,
    ).toMatchObject({
      appendPrompt: false,
      resumeArgvTemplate: ["echo", "resume", "{cliResumeRef}", "{prompt}"],
      resumeRefCapture: { stream: "stderr", linePrefix: "resume: " },
    });
    const invalidResumePatch = await invoke("PATCH", `/api/v1/commands/${cmdId}`, {
      resumeRefCapture: { stream: "unknown", linePrefix: "resume: " },
    });
    expect(invalidResumePatch.status).toBe(400);
    expect(invalidResumePatch.json).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    expect((await invoke("PATCH", "/api/v1/commands/missing", { name: "x" })).status).toBe(404);

    // Referential delete blocks surface as 409, not 404.
    await invoke("PUT", `/api/v1/providers/prov-1`, { defaultCommandId: cmdId });
    expect((await invoke("DELETE", `/api/v1/commands/${cmdId}`)).status).toBe(409);
    await invoke("PUT", `/api/v1/providers/prov-1`, { defaultCommandId: null });
    expect((await invoke("DELETE", "/api/v1/providers/prov-1")).status).toBe(409); // acct still attached
    expect((await invoke("DELETE", `/api/v1/provider-accounts/${acctId}`)).status).toBe(204);
    expect((await invoke("DELETE", "/api/v1/providers/prov-1")).status).toBe(204);
    expect((await invoke("DELETE", "/api/v1/providers/prov-1")).status).toBe(404);
    expect((await invoke("DELETE", `/api/v1/commands/${cmdId}`)).status).toBe(204);
    expect((await invoke("DELETE", `/api/v1/commands/${cmdId}`)).status).toBe(404);
    expect((await invoke("DELETE", `/api/v1/provider-accounts/${acctId}`)).status).toBe(404);

    expect(await invokeBadJson(handler, "POST", "/api/v1/providers")).toBe(400);
    expect(await invokeBadJson(handler, "PUT", "/api/v1/providers/prov-1")).toBe(400);
    expect(await invokeBadJson(handler, "POST", "/api/v1/provider-accounts")).toBe(400);
    expect(await invokeBadJson(handler, "PUT", `/api/v1/provider-accounts/${acctId}`)).toBe(400);
    expect(await invokeBadJson(handler, "POST", "/api/v1/commands")).toBe(400);
    expect(await invokeBadJson(handler, "PATCH", `/api/v1/commands/${cmdId}`)).toBe(400);
  });

  it("fails closed when an invalid provider-rate audit cannot be stored", async () => {
    const plane = new ControlPlane();
    plane.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    const { handler } = createLocalApp({ plane });
    expect(
      (
        await invokeHandler(handler, "POST", "/api/v1/providers", {
          name: "invalid",
          usageRates: {},
        })
      ).status,
    ).toBe(500);
  });
});
