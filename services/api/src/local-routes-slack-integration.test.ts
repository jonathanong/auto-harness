/* eslint-disable max-lines, unicorn/consistent-function-scoping -- Slack route cases use local scenario helpers. */
import { describe, expect, it } from "vitest";

import { DEFAULT_SLACK_NOTIFICATIONS } from "@auto-harness/shared";

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
      role: "maintainer",
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
      null,
      [],
      "slack",
      {},
      { botToken: token },
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

  it("maps durable Slack read, write, update, and delete failure variants", async () => {
    const read = new ControlPlane({ secretEncryptor: encryptor() });
    read.getSlackIntegrationDurable = async () => {
      throw new Error("read failed");
    };
    expect(
      (
        await invokeHandler(
          createLocalApp({ plane: read, authMode: "disabled" }).handler,
          "GET",
          "/api/v1/integrations/slack",
        )
      ).status,
    ).toBe(500);

    const unavailable = new ControlPlane({ secretEncryptor: encryptor() });
    unavailable.createSlackIntegrationDurable = async () => ({
      ok: false,
      unavailable: true,
      error: "storage unavailable",
    });
    expect(
      (
        await invokeHandler(
          createLocalApp({ plane: unavailable, authMode: "disabled" }).handler,
          "POST",
          "/api/v1/integrations/slack",
          body(),
        )
      ).status,
    ).toBe(500);

    for (const [result, status] of [
      [{ ok: false, error: "Slack integration not found" }, 404],
      [{ ok: false, error: "invalid update" }, 400],
      [{ ok: false, error: "changed", conflict: true }, 409],
    ] as const) {
      const plane = new ControlPlane({ secretEncryptor: encryptor() });
      plane.updateSlackIntegrationDurable = async () => result;
      expect(
        (
          await invokeHandler(
            createLocalApp({ plane, authMode: "disabled" }).handler,
            "PUT",
            "/api/v1/integrations/slack",
            body(),
          )
        ).status,
      ).toBe(status);
    }

    for (const [result, status] of [
      [{ ok: false, error: "missing" }, 404],
      [{ ok: false, error: "changed", conflict: true }, 409],
    ] as const) {
      const plane = new ControlPlane({ secretEncryptor: encryptor() });
      plane.deleteSlackIntegrationDurable = async () => result;
      expect(
        (
          await invokeHandler(
            createLocalApp({ plane, authMode: "disabled" }).handler,
            "DELETE",
            "/api/v1/integrations/slack",
          )
        ).status,
      ).toBe(status);
    }

    const thrown = new ControlPlane({ secretEncryptor: encryptor() });
    thrown.deleteSlackIntegrationDurable = async () => {
      throw new Error("delete failed");
    };
    expect(
      (
        await invokeHandler(
          createLocalApp({ plane: thrown, authMode: "disabled" }).handler,
          "DELETE",
          "/api/v1/integrations/slack",
        )
      ).status,
    ).toBe(500);
  });

  it("accepts notification and signing-secret options", async () => {
    const plane = new ControlPlane({ secretEncryptor: encryptor() });
    const response = await invokeHandler(
      createLocalApp({ plane, authMode: "disabled" }).handler,
      "POST",
      "/api/v1/integrations/slack",
      {
        ...body(),
        enabled: true,
        signingSecret: "a".repeat(32),
        notifications: DEFAULT_SLACK_NOTIFICATIONS,
      },
    );
    expect(response.status).toBe(201);
  });

  it("fails closed when audits fail on each Slack error and delete outcome", async () => {
    const invoke = (plane: ControlPlane, method: string, requestBody?: unknown) =>
      invokeHandler(
        createLocalApp({ plane, authMode: "disabled" }).handler,
        method,
        "/api/v1/integrations/slack",
        requestBody,
      );
    const auditFailure = () => {
      const plane = new ControlPlane({ secretEncryptor: encryptor() });
      plane.appendAuditLog = async () => {
        throw new Error("audit unavailable");
      };
      return plane;
    };

    expect((await invoke(auditFailure(), "POST", {})).status).toBe(500);

    const rejected = auditFailure();
    rejected.createSlackIntegrationDurable = async () => ({ ok: false, error: "rejected" });
    expect((await invoke(rejected, "POST", body())).status).toBe(500);

    const createThrown = auditFailure();
    createThrown.createSlackIntegrationDurable = async () => {
      throw new Error("write failed");
    };
    expect((await invoke(createThrown, "POST", body())).status).toBe(500);

    const deleteRejected = auditFailure();
    deleteRejected.deleteSlackIntegrationDurable = async () => ({ ok: false, error: "missing" });
    expect((await invoke(deleteRejected, "DELETE")).status).toBe(500);

    const deleteSuccess = auditFailure();
    deleteSuccess.deleteSlackIntegrationDurable = async () => ({ ok: true });
    expect((await invoke(deleteSuccess, "DELETE")).status).toBe(500);

    const deleteThrown = auditFailure();
    deleteThrown.deleteSlackIntegrationDurable = async () => {
      throw new Error("delete failed");
    };
    expect((await invoke(deleteThrown, "DELETE")).status).toBe(500);
  });
});
