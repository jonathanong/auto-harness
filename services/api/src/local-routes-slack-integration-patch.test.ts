import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { handleSlackIntegrationRoutes } from "./local-routes-slack-integration.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

function encryptor(): SecretEncryptor {
  return { encrypt: async () => "ciphertext", decrypt: async () => "" };
}

describe("Slack integration PATCH parsing", () => {
  it("rejects every malformed settings shape before changing integration state", async () => {
    const plane = new ControlPlane({ secretEncryptor: encryptor() });
    const handler = createLocalApp({
      plane,
      authMode: "disabled",
      rateLimitConfig: { enabled: false },
    }).handler;
    for (const body of [
      null,
      [],
      {},
      { unknown: true },
      { enabled: false },
      { defaultChannel: 1 },
      { enabled: "false" },
      { expectedVersion: 1, notifications: null },
      { expectedVersion: 1, notifications: "not-an-object" },
      { expectedVersion: 1, notifications: [] },
      { expectedVersion: 0, enabled: false },
      { expectedVersion: 1.5, enabled: false },
      { expectedVersion: -1, enabled: false },
    ]) {
      expect(
        (await invokeHandler(handler, "PATCH", "/api/v1/integrations/slack", body)).status,
      ).toBe(400);
    }
    expect(await plane.getSlackIntegration()).toBeNull();
  });

  it("accepts every supported patch field but leaves an absent integration unchanged", async () => {
    const plane = new ControlPlane({ secretEncryptor: encryptor() });
    const response = await invokeHandler(
      createLocalApp({
        plane,
        authMode: "disabled",
        rateLimitConfig: { enabled: false },
      }).handler,
      "PATCH",
      "/api/v1/integrations/slack",
      {
        expectedVersion: 1,
        defaultChannel: "C0123ABCDE",
        enabled: false,
        notifications: { onSessionCreated: false },
      },
    );
    expect(response).toMatchObject({ status: 404, json: { error: { code: "NOT_FOUND" } } });
    expect(
      await invokeHandler(
        createLocalApp({
          plane,
          authMode: "disabled",
          rateLimitConfig: { enabled: false },
        }).handler,
        "PATCH",
        "/api/v1/integrations/slack",
        { expectedVersion: 1, enabled: false },
      ),
    ).toMatchObject({ status: 404 });
    expect(await plane.getSlackIntegration()).toBeNull();
  });

  it("rejects a stale editor before replacing the latest settings", async () => {
    const plane = new ControlPlane({ secretEncryptor: encryptor() });
    await plane.createSlackIntegrationDurable({
      botToken: "xoxb-1234567890-abcdefghij",
      defaultChannel: "#harness",
    });
    const handler = createLocalApp({
      plane,
      authMode: "disabled",
      rateLimitConfig: { enabled: false },
    }).handler;

    await expect(
      invokeHandler(handler, "PATCH", "/api/v1/integrations/slack", {
        expectedVersion: 1,
        enabled: false,
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(
      await invokeHandler(handler, "PATCH", "/api/v1/integrations/slack", {
        expectedVersion: 1,
        enabled: true,
      }),
    ).toMatchObject({ status: 409, json: { error: { code: "CONFLICT" } } });
    expect(await plane.getSlackIntegration()).toMatchObject({ enabled: false, version: 2 });
  });

  it("does not expose non-Error request failures and records mutation failures", async () => {
    const plane = new ControlPlane({ secretEncryptor: encryptor() });
    let status = 0;
    let payload = "";
    const req = {
      on(event: string, callback: (value: unknown) => void) {
        if (event === "error") callback("request stream failed");
        return req;
      },
    };
    const res = {
      setHeader() {
        // `send` uses this response shape before writing the error payload.
      },
      writeHead(code: number) {
        status = code;
      },
      end(value?: string) {
        payload = value ?? "";
      },
    };
    await expect(
      handleSlackIntegrationRoutes({
        plane,
        req: req as never,
        res: res as never,
        url: new URL("http://localhost/api/v1/integrations/slack"),
        method: "PATCH",
      }),
    ).resolves.toBe(true);
    expect(status).toBe(400);
    expect(payload).toContain("invalid Slack configuration");
    expect(payload).not.toContain("request stream failed");

    plane.patchSlackIntegrationDurable = async () => {
      throw new Error("storage unavailable");
    };
    const handler = createLocalApp({
      plane,
      authMode: "disabled",
      rateLimitConfig: { enabled: false },
    }).handler;
    expect(
      await invokeHandler(handler, "PATCH", "/api/v1/integrations/slack", {
        expectedVersion: 1,
        enabled: false,
      }),
    ).toMatchObject({ status: 500, json: { error: { code: "INTERNAL_ERROR" } } });
    expect(await plane.listAuditLogs({ resourceType: "integration" })).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ action: "integration:slack:patch", outcome: "failed" }),
      ]),
    });
  });

  it("does not claim unrelated paths or unsupported methods", async () => {
    const handler = createLocalApp({
      plane: new ControlPlane({ secretEncryptor: encryptor() }),
      authMode: "disabled",
      rateLimitConfig: { enabled: false },
    }).handler;
    expect((await invokeHandler(handler, "HEAD", "/api/v1/integrations/slack")).status).toBe(404);
    expect((await invokeHandler(handler, "GET", "/api/v1/integrations/slack/extra")).status).toBe(
      404,
    );
  });
});
