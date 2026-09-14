import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

describe("session log settings routes", () => {
  it("gets defaults and puts a CAS update", async () => {
    const { handler } = createLocalApp({ authMode: "off" });
    const got = await invokeHandler(handler, "GET", "/api/v1/session-log-settings");
    expect(got.status).toBe(200);
    expect(got.json).toMatchObject({ uploadMode: "off", version: 0 });
    const saved = await invokeHandler(handler, "PUT", "/api/v1/session-log-settings", {
      version: 0,
      uploadMode: "always",
      batchMaxKb: 32,
    });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ uploadMode: "always", batchMaxKb: 32, version: 1 });
    const conflict = await invokeHandler(handler, "PUT", "/api/v1/session-log-settings", {
      version: 0,
      uploadMode: "off",
    });
    expect(conflict.status).toBe(409);
  });

  it("rejects unknown fields", async () => {
    const { handler } = createLocalApp({ authMode: "off" });
    const response = await invokeHandler(handler, "PUT", "/api/v1/session-log-settings", {
      version: 0,
      extra: true,
    });
    expect(response.status).toBe(400);
  });

  it("rejects invalid bodies and surfaces GET/PUT failures", async () => {
    const { handler } = createLocalApp({ authMode: "off" });
    for (const body of [
      [],
      { version: -1 },
      { version: 0, uploadMode: "sometimes" },
      { version: 0, batchMaxKb: "big" },
    ]) {
      const response = await invokeHandler(handler, "PUT", "/api/v1/session-log-settings", body);
      expect(response.status).toBe(400);
    }
    const getPlane = new ControlPlane();
    getPlane.getSessionLogSettings = async () => {
      throw new Error("down");
    };
    const failingGet = createLocalApp({ authMode: "off", plane: getPlane });
    expect(
      (await invokeHandler(failingGet.handler, "GET", "/api/v1/session-log-settings")).status,
    ).toBe(500);
    const putPlane = new ControlPlane();
    putPlane.putSessionLogSettings = async () => {
      throw new Error("down");
    };
    const failingPut = createLocalApp({ authMode: "off", plane: putPlane });
    expect(
      (
        await invokeHandler(failingPut.handler, "PUT", "/api/v1/session-log-settings", {
          version: 0,
        })
      ).status,
    ).toBe(500);
  });

  it("rejects non-PUT methods and non-conflict put failures", async () => {
    const { handler } = createLocalApp({ authMode: "off" });
    expect((await invokeHandler(handler, "POST", "/api/v1/session-log-settings", {})).status).toBe(
      404,
    );
    const saved = await invokeHandler(handler, "PUT", "/api/v1/session-log-settings", {
      version: 0,
      uploadMode: "subscribed",
      batchMaxKb: 16,
      batchMaxLines: 20,
      batchMaxWaitMs: 5_000,
      controlPlanePollMs: 10_000,
    });
    expect(saved.status).toBe(200);
    const validation = new ControlPlane();
    validation.putSessionLogSettings = async () => ({ ok: false, error: "bad version" });
    const validating = createLocalApp({ authMode: "off", plane: validation });
    expect(
      (
        await invokeHandler(validating.handler, "PUT", "/api/v1/session-log-settings", {
          version: 0,
        })
      ).status,
    ).toBe(400);
    const auditFail = new ControlPlane();
    auditFail.appendAuditLog = async () => {
      throw new Error("audit down");
    };
    const audited = createLocalApp({ authMode: "off", plane: auditFail });
    expect(
      (
        await invokeHandler(audited.handler, "PUT", "/api/v1/session-log-settings", {
          version: -1,
        })
      ).status,
    ).toBe(500);
    const successAudit = new ControlPlane();
    successAudit.appendAuditLog = async () => {
      throw new Error("audit down");
    };
    const successAudited = createLocalApp({ authMode: "off", plane: successAudit });
    expect(
      (
        await invokeHandler(successAudited.handler, "PUT", "/api/v1/session-log-settings", {
          version: 0,
        })
      ).status,
    ).toBe(500);
  });
});
