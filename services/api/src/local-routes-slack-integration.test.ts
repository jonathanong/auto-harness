import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

const token = "xoxb-1234567890-abcdefghij";

function admins(): string {
  return Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
    "base64url",
  );
}

function basic(): Record<string, string> {
  return { authorization: `Basic ${Buffer.from("root:root").toString("base64")}` };
}

function encryptor(): SecretEncryptor {
  return {
    encrypt: async () => "opaque-ciphertext",
    decrypt: async () => "",
  };
}

function body() {
  return { botToken: token, defaultChannel: "#harness" };
}

describe("Slack integration REST routes", () => {
  it("is admin-only, audits mutations, redacts secrets, and fails closed", async () => {
    const auth = new AuthService({ mode: "required", secret: "a".repeat(32), admins: admins() });
    const { apiKey } = await auth.createServiceAccount({ name: "operator", role: "operator" });
    const plane = new ControlPlane({ secretEncryptor: encryptor() });
    const { handler } = createLocalApp({ plane, authService: auth });

    expect((await invokeHandler(handler, "GET", "/api/v1/integrations/slack")).status).toBe(401);
    expect(
      (
        await invokeHandler(handler, "POST", "/api/v1/integrations/slack", body(), {
          authorization: `Bearer ${apiKey}`,
        })
      ).status,
    ).toBe(403);

    const created = await invokeHandler(
      handler,
      "POST",
      "/api/v1/integrations/slack",
      body(),
      basic(),
    );
    expect(created.status).toBe(201);
    expect(created.raw).not.toContain(token);
    expect(
      (await invokeHandler(handler, "GET", "/api/v1/integrations/slack", undefined, basic())).raw,
    ).not.toContain(token);
    expect(
      (
        await invokeHandler(
          handler,
          "PUT",
          "/api/v1/integrations/slack",
          { ...body(), enabled: false },
          basic(),
        )
      ).json,
    ).toMatchObject({ enabled: false });
    expect((await plane.listAuditLogs({ resourceType: "integration" })).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "integration:slack:create", outcome: "success" }),
      ]),
    );
    expect(
      await invokeHandler(handler, "DELETE", "/api/v1/integrations/slack", undefined, basic()),
    ).toMatchObject({ status: 204 });

    const unavailable = createLocalApp({ plane: new ControlPlane(), authMode: "disabled" }).handler;
    const response = await invokeHandler(unavailable, "POST", "/api/v1/integrations/slack", body());
    expect(response.status).toBe(500);
    expect(response.raw).not.toContain(token);
  });

  it("returns structured GET, validation, method, and encryption failures", async () => {
    const plane = new ControlPlane({ secretEncryptor: encryptor() });
    const handler = createLocalApp({ plane, authMode: "disabled" }).handler;
    expect((await invokeHandler(handler, "GET", "/api/v1/integrations/slack")).status).toBe(404);
    expect((await invokeHandler(handler, "PUT", "/api/v1/integrations/slack", body())).status).toBe(
      404,
    );
    expect(
      (
        await invokeHandler(handler, "POST", "/api/v1/integrations/slack", {
          defaultChannel: "#harness",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await invokeHandler(handler, "POST", "/api/v1/integrations/slack", {
          ...body(),
          notifications: "invalid",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await invokeHandler(handler, "POST", "/api/v1/integrations/slack", {
          ...body(),
          notifications: null,
        })
      ).status,
    ).toBe(400);
    expect(
      (await invokeHandler(handler, "PATCH", "/api/v1/integrations/slack", body())).status,
    ).toBe(404);
    expect((await invokeHandler(handler, "DELETE", "/api/v1/integrations/slack")).status).toBe(404);
    expect(
      (
        await invokeHandler(handler, "POST", "/api/v1/integrations/slack", {
          ...body(),
          enabled: "invalid",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await invokeHandler(handler, "POST", "/api/v1/integrations/slack", {
          ...body(),
          signingSecret: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await invokeHandler(handler, "POST", "/api/v1/integrations/slack", {
          ...body(),
          notifications: [],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await invokeHandler(handler, "POST", "/api/v1/integrations/slack", {
          ...body(),
          misspelledSecret: token,
        })
      ).status,
    ).toBe(400);

    plane.state.secretEncryptor = {
      encrypt: async () => {
        throw new Error("KMS unavailable");
      },
      decrypt: async () => "",
    };
    expect(
      (await invokeHandler(handler, "POST", "/api/v1/integrations/slack", body())).status,
    ).toBe(500);

    plane.getSlackIntegrationDurable = async () => {
      throw new Error("storage unavailable");
    };
    expect((await invokeHandler(handler, "GET", "/api/v1/integrations/slack")).status).toBe(500);

    const auditFailure = new ControlPlane({ secretEncryptor: encryptor() });
    auditFailure.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    const auditHandler = createLocalApp({ plane: auditFailure, authMode: "disabled" }).handler;
    expect(
      (await invokeHandler(auditHandler, "POST", "/api/v1/integrations/slack", body())).status,
    ).toBe(500);

    const conflictPlane = new ControlPlane({ secretEncryptor: encryptor() });
    conflictPlane.deleteSlackIntegrationDurable = async () => ({
      ok: false as const,
      error: "changed",
      conflict: true as const,
    });
    const conflictHandler = createLocalApp({ plane: conflictPlane, authMode: "disabled" }).handler;
    expect(
      (await invokeHandler(conflictHandler, "DELETE", "/api/v1/integrations/slack")).status,
    ).toBe(409);

    const duplicatePlane = new ControlPlane({ secretEncryptor: encryptor() });
    const duplicateHandler = createLocalApp({
      plane: duplicatePlane,
      authMode: "disabled",
    }).handler;
    expect(
      (await invokeHandler(duplicateHandler, "POST", "/api/v1/integrations/slack", body())).status,
    ).toBe(201);
    expect(
      (await invokeHandler(duplicateHandler, "POST", "/api/v1/integrations/slack", body())).status,
    ).toBe(409);
    duplicatePlane.deleteSlackIntegrationDurable = async () => {
      throw new Error("storage unavailable");
    };
    expect(
      (await invokeHandler(duplicateHandler, "DELETE", "/api/v1/integrations/slack")).status,
    ).toBe(500);
  });
});
