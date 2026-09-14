import { describe, expect, it } from "vitest";

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
});
