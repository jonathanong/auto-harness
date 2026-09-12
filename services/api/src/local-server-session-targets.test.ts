import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { sessionTargetListKey } from "./local-routes-session-targets.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

describe("createLocalApp session-targets", () => {
  it("keys picker rows by kind and id", () => {
    expect(sessionTargetListKey({ kind: "command", id: "cmd-1" })).toBe("command:cmd-1");
  });

  it("GET /api/v1/session-targets lists provider accounts and standalone commands", async () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    plane.createCommand({ id: "cmd-1", name: "echo-hello", argv: ["echo"], providerId: null });
    const { handler } = createLocalApp({ plane });

    const res = await invokeHandler(handler, "GET", "/api/v1/session-targets");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      items: [{ kind: "command", id: "cmd-1", label: "echo-hello" }],
    });
  });

  it("returns 500 when listing session targets throws", async () => {
    const plane = new ControlPlane();
    plane.listSessionTargetsDurable = async () => {
      throw new Error("catalog unavailable");
    };
    const { handler } = createLocalApp({ plane });
    const res = await invokeHandler(handler, "GET", "/api/v1/session-targets");
    expect(res.status).toBe(500);
    expect(res.json).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
  });

  it("falls through for unrelated paths", async () => {
    const plane = new ControlPlane();
    const { handler } = createLocalApp({ plane });
    expect((await invokeHandler(handler, "GET", "/missing")).status).toBe(404);
  });
});
