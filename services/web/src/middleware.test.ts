import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { middleware } from "./middleware.ts";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("web authentication middleware", () => {
  afterEach(() => {
    delete process.env.HARNESS_AUTH_MODE;
    delete process.env.HARNESS_SESSION_SECRET;
  });

  it("allows disabled mode and redirects missing, invalid, or expired sessions to login", async () => {
    const request = new NextRequest("http://localhost/sessions");
    expect((await middleware(request)).headers.get("x-middleware-next")).toBe("1");

    process.env.HARNESS_AUTH_MODE = "required";
    process.env.HARNESS_SESSION_SECRET = "a".repeat(32);
    const redirected = await middleware(new NextRequest("http://localhost/sessions?status=queued"));
    expect(redirected.status).toBe(307);
    expect(redirected.headers.get("location")).toBe(
      "http://localhost/login?returnTo=%2Fsessions%3Fstatus%3Dqueued",
    );
    const invalid = await middleware(
      new NextRequest("http://localhost/sessions", {
        headers: { cookie: "auto_harness_session=not-a-token" },
      }),
    );
    expect(invalid.headers.get("location")).toContain("/login?");
    const expired = await middleware(
      new NextRequest("http://localhost/sessions", {
        headers: { cookie: `auto_harness_session=${signedToken("a".repeat(32), 0)}` },
      }),
    );
    expect(expired.headers.get("location")).toContain("/login?");
  });

  it("allows a valid session and keeps login public without a session", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    process.env.HARNESS_SESSION_SECRET = "a".repeat(32);
    const authenticated = new NextRequest("http://localhost/sessions", {
      headers: { cookie: `auto_harness_session=${signedToken("a".repeat(32))}` },
    });
    expect((await middleware(authenticated)).headers.get("x-middleware-next")).toBe("1");
    expect(
      (await middleware(new NextRequest("http://localhost/login"))).headers.get(
        "x-middleware-next",
      ),
    ).toBe("1");
    expect(
      (
        await middleware(
          new NextRequest("http://localhost/login", { headers: authenticated.headers }),
        )
      ).headers.get("location"),
    ).toBe("http://localhost/");
  });
});

function signedToken(secret: string, exp = Math.floor(Date.now() / 1000) + 60): string {
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    id: "user:alice",
    username: "alice",
    role: "operator",
    kind: "user",
    exp,
  })}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}
