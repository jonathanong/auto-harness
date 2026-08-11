import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeBadJson, invokeHandler } from "./local-server-test-helpers.ts";

function errorCode(response: Awaited<ReturnType<typeof invokeHandler>>): string | undefined {
  return (response.json as { error?: { code?: string } }).error?.code;
}

describe("local route error semantics", () => {
  it("keeps malformed JSON separate from session persistence failures", async () => {
    const plane = new ControlPlane();
    const { handler } = createLocalApp({ plane });

    expect(await invokeBadJson(handler, "POST", "/api/v1/sessions")).toBe(400);

    plane.createSessionDurable = async () => {
      throw new Error("storage unavailable");
    };
    const failed = await invokeHandler(handler, "POST", "/api/v1/sessions", {});
    expect(failed.status).toBe(500);
    expect(errorCode(failed)).toBe("INTERNAL_ERROR");
    expect(failed.raw).not.toContain("storage unavailable");
  });

  it("maps session validation, conflict, and missing outcomes consistently", async () => {
    const plane = new ControlPlane();
    const { handler } = createLocalApp({ plane });

    const invalid = await invokeHandler(handler, "POST", "/api/v1/sessions", {});
    expect(invalid.status).toBe(400);
    expect(errorCode(invalid)).toBe("VALIDATION_ERROR");

    plane.createSessionDurable = async () => ({
      ok: false,
      error: "session creation conflicted; retry the request",
      code: "CONFLICT",
    });
    const conflict = await invokeHandler(handler, "POST", "/api/v1/sessions", {});
    expect(conflict.status).toBe(409);
    expect(errorCode(conflict)).toBe("CONFLICT");

    plane.cancelSessionDurable = async () => ({ ok: false, error: "session not found" });
    const missing = await invokeHandler(handler, "POST", "/api/v1/sessions/missing/cancel", {});
    expect(missing.status).toBe(404);
    expect(errorCode(missing)).toBe("NOT_FOUND");

    plane.cancelSessionDurable = async () => ({ ok: false, error: "session cannot cancel" });
    const conflictCancel = await invokeHandler(
      handler,
      "POST",
      "/api/v1/sessions/missing/cancel",
      {},
    );
    expect(conflictCancel.status).toBe(409);
    expect(errorCode(conflictCancel)).toBe("CONFLICT");
  });

  it("does not turn host backend failures into invalid JSON errors", async () => {
    const plane = new ControlPlane();
    const { handler } = createLocalApp({ plane });

    expect(await invokeBadJson(handler, "POST", "/api/v1/host/messages")).toBe(400);
    plane.handleHostMessageDurable = async () => {
      throw new Error("storage unavailable");
    };
    const message = await invokeHandler(handler, "POST", "/api/v1/host/messages", {
      type: "host:keepalive",
      hostId: "host",
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(message.status).toBe(500);
    expect(errorCode(message)).toBe("INTERNAL_ERROR");

    expect(await invokeBadJson(handler, "POST", "/api/v1/hosts/drain")).toBe(400);
    expect((await invokeHandler(handler, "POST", "/api/v1/hosts/drain", null)).status).toBe(400);
    plane.drainHostDurable = async () => {
      throw new Error("storage unavailable");
    };
    const drain = await invokeHandler(handler, "POST", "/api/v1/hosts/drain", { hostId: "host" });
    expect(drain.status).toBe(500);
    expect(errorCode(drain)).toBe("INTERNAL_ERROR");

    plane.handleHostMessageDurable = async () => ({ ok: false, error: "session not found" });
    const missing = await invokeHandler(handler, "POST", "/api/v1/host/messages", {
      type: "host:keepalive",
      hostId: "host",
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(missing.status).toBe(404);
    expect(errorCode(missing)).toBe("NOT_FOUND");

    plane.handleHostMessageDurable = async () => ({ ok: false, error: "stale host connection" });
    const stale = await invokeHandler(handler, "POST", "/api/v1/host/messages", {
      type: "host:keepalive",
      hostId: "host",
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(stale.status).toBe(409);
    expect(errorCode(stale)).toBe("CONFLICT");

    plane.handleHostMessageDurable = async () => ({ ok: true });
    const accepted = await invokeHandler(handler, "POST", "/api/v1/host/messages", {
      type: "host:keepalive",
      hostId: "host",
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(accepted.status).toBe(200);
  });
});
