import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { middleware } from "./middleware.ts";

describe("host-pane authentication middleware", () => {
  afterEach(() => delete process.env.HARNESS_AUTH_MODE);

  it("allows local disabled mode and requires a session cookie in required mode", () => {
    const request = new NextRequest("http://localhost/api/browse");
    expect(middleware(request).headers.get("x-middleware-next")).toBe("1");

    process.env.HARNESS_AUTH_MODE = "required";
    expect(middleware(request).status).toBe(401);
    const authenticated = new NextRequest("http://localhost/api/browse", {
      headers: { cookie: "auto_harness_session=signed" },
    });
    expect(middleware(authenticated).headers.get("x-middleware-next")).toBe("1");
  });
});
