import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import type { SecretEncryptor } from "./secret-crypto.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

const token = "xoxb-1234567890-abcdefghij";

function body() {
  return { botToken: token, defaultChannel: "#harness" };
}

function encryptor(): SecretEncryptor {
  return { encrypt: async () => "opaque-ciphertext", decrypt: async () => "unused" };
}

function basic(): Record<string, string> {
  return { authorization: `Basic ${Buffer.from("root:root").toString("base64")}` };
}

function admins(): string {
  return Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
    "base64url",
  );
}

describe("Slack integration routes", () => {
  it("requires an unscoped admin, redacts secrets, and creates audit events", async () => {
    const auth = new AuthService({ mode: "required", secret: "a".repeat(32), admins: admins() });
    const { apiKey: operator } = await auth.createServiceAccount({ name: "op", role: "operator" });
    const { apiKey: scopedAdmin } = await auth.createServiceAccount({
      name: "scoped",
      role: "admin",
      allowedRepositoryIds: ["repo-1"],
    });
    const plane = new ControlPlane({ secretEncryptor: encryptor() });
    const { handler } = createLocalApp({ plane, authService: auth });
    expect((await invokeHandler(handler, "GET", "/api/v1/integrations/slack")).status).toBe(401);
    for (const key of [operator, scopedAdmin]) {
      expect(
        (
          await invokeHandler(handler, "POST", "/api/v1/integrations/slack", body(), {
            authorization: `Bearer ${key}`,
          })
        ).status,
      ).toBe(403);
    }
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
      await invokeHandler(
        handler,
        "PUT",
        "/api/v1/integrations/slack",
        { ...body(), enabled: false },
        basic(),
      ),
    ).toMatchObject({ status: 200, json: expect.objectContaining({ enabled: false }) });
    expect(
      await invokeHandler(handler, "DELETE", "/api/v1/integrations/slack", undefined, basic()),
    ).toMatchObject({ status: 204 });
    expect((await plane.listAuditLogs({ resourceType: "integration" })).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "integration:slack:create", outcome: "success" }),
        expect.objectContaining({ action: "integration:slack:delete", outcome: "success" }),
      ]),
    );
  });

  it("maps malformed, absent, encryption, conflict, and unsupported-method results", async () => {
    const plane = new ControlPlane({ secretEncryptor: encryptor() });
    const handler = createLocalApp({ plane, authMode: "disabled" }).handler;
    expect((await invokeHandler(handler, "GET", "/api/v1/integrations/slack")).status).toBe(404);
    expect((await invokeHandler(handler, "PUT", "/api/v1/integrations/slack", body())).status).toBe(
      404,
    );
    for (const malformed of [
      {},
      { ...body(), enabled: "yes" },
      { ...body(), signingSecret: 1 },
      { ...body(), notifications: [] },
      { ...body(), unexpected: token },
    ]) {
      expect(
        (await invokeHandler(handler, "POST", "/api/v1/integrations/slack", malformed)).status,
      ).toBe(400);
    }
    expect(
      (await invokeHandler(handler, "PATCH", "/api/v1/integrations/slack", body())).status,
    ).toBe(404);
    expect((await invokeHandler(handler, "DELETE", "/api/v1/integrations/slack")).status).toBe(404);

    const noKms = createLocalApp({ plane: new ControlPlane(), authMode: "disabled" }).handler;
    expect((await invokeHandler(noKms, "POST", "/api/v1/integrations/slack", body())).status).toBe(
      500,
    );
    plane.createSlackIntegrationDurable = async () => ({
      ok: false,
      error: "changed",
      conflict: true,
    });
    expect(
      (await invokeHandler(handler, "POST", "/api/v1/integrations/slack", body())).status,
    ).toBe(409);
  });

  it("fails closed when an audit append fails after a Slack mutation", async () => {
    const plane = new ControlPlane({ secretEncryptor: encryptor() });
    const handler = createLocalApp({ plane, authMode: "disabled" }).handler;
    plane.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    expect(
      (await invokeHandler(handler, "POST", "/api/v1/integrations/slack", body())).status,
    ).toBe(500);
    expect(plane.getSlackIntegration()).not.toBeNull();
  });
});
