import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

/**
 * Route modules catch their own IO, but anything escaping one used to reject the floated
 * promise in createServer's callback. Node turns that into process exit, so a single
 * unguarded throw took the API down and left the client waiting on a silent socket.
 *
 * A malformed request line is the cheapest way to reach that: `new URL(req.url, base)`
 * runs before any route is chosen, so it sits outside every per-route try/catch.
 */
const MALFORMED_URL = "http://[";

function app() {
  return createLocalApp({ plane: new ControlPlane(), rateLimitConfig: { enabled: false } });
}

describe("local app error boundary", () => {
  it("answers 500 to a malformed request URL instead of rejecting to the process", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { handler } = app();

    const res = await invokeHandler(handler, "GET", MALFORMED_URL);

    expect(res.status).toBe(500);
    expect(res.json).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("logs the path without the query string, which can carry a viewer ticket", async () => {
    const messages: string[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      messages.push(String(message));
    });
    const { handler } = app();

    await invokeHandler(handler, "GET", `${MALFORMED_URL}?ticket=super-secret`);

    expect(messages.join("\n")).toContain(MALFORMED_URL);
    expect(messages.join("\n")).not.toContain("super-secret");
    errors.mockRestore();
  });

  it("still serves normal requests", async () => {
    const { handler } = app();

    expect((await invokeHandler(handler, "GET", "/health")).status).toBe(200);
  });
});
