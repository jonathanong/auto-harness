import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { hasValidSession, SESSION_COOKIE, sessionCookieValue } from "./session-cookie.ts";

const secret = "a".repeat(32);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("session cookie helpers", () => {
  it("reads the named cookie and ignores neighboring values", () => {
    expect(sessionCookieValue(undefined)).toBeUndefined();
    expect(sessionCookieValue(`${SESSION_COOKIE}=abc; other=x`)).toBe("abc");
    expect(sessionCookieValue(`other=x; ${SESSION_COOKIE}=def`)).toBe("def");
  });

  it("rejects a viewer-ticket audience even when the HMAC is valid", async () => {
    const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
      id: "user:alice",
      username: "alice",
      role: "operator",
      kind: "user",
      audience: "viewer",
      exp: Math.floor(Date.now() / 1000) + 60,
    })}`;
    const token = `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
    expect(await hasValidSession(token, secret)).toBe(false);
  });
});
