import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { hasValidSession, loginPath, safeReturnPath } from "./auth-session.ts";

const secret = "a".repeat(32);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("web auth session helpers", () => {
  it("keeps return destinations inside the control plane", () => {
    expect(safeReturnPath("/sessions?status=queued")).toBe("/sessions?status=queued");
    expect(safeReturnPath("https://example.com")).toBe("/");
    expect(safeReturnPath("//example.com")).toBe("/");
    expect(safeReturnPath("/\\example.com")).toBe("/");
    expect(safeReturnPath(null)).toBe("/");
    expect(loginPath("//example.com")).toBe("/login?returnTo=%2F");
  });

  it("accepts only fresh signed session claims", async () => {
    const valid = token({ exp: Math.floor(Date.now() / 1000) + 60 });
    expect(await hasValidSession(valid, secret)).toBe(true);
    expect(await hasValidSession(undefined, secret)).toBe(false);
    expect(await hasValidSession(valid, undefined)).toBe(false);
    expect(await hasValidSession("bad", secret)).toBe(false);
    expect(await hasValidSession("..signature", secret)).toBe(false);
    expect(await hasValidSession("header..signature", secret)).toBe(false);
    expect(await hasValidSession("header.payload.", secret)).toBe(false);
    expect(await hasValidSession(token({ exp: 0 }), secret)).toBe(false);
    expect(await hasValidSession(token({ id: 1 }), secret)).toBe(false);
    expect(await hasValidSession(token({ username: 1 }), secret)).toBe(false);
    expect(await hasValidSession(token({ role: "wrong" }), secret)).toBe(false);
    expect(await hasValidSession(token({ audience: "viewer" }), secret)).toBe(false);
    expect(await hasValidSession(token({ role: "admin", kind: "admin" }), secret)).toBe(true);
    expect(
      await hasValidSession(token({ role: "read-only", kind: "service-account" }), secret),
    ).toBe(true);
    expect(await hasValidSession(token({}, { alg: "none", typ: "JWT" }), secret)).toBe(false);
    expect(await hasValidSession(`${valid}x`, secret)).toBe(false);
    expect(await hasValidSession(malformedHeaderToken(), secret)).toBe(false);
    expect(await hasValidSession(malformedPayloadToken(), secret)).toBe(false);
    expect(await hasValidSession(`${valid.slice(0, valid.lastIndexOf(".") + 1)}%`, secret)).toBe(
      false,
    );
  });
});

function token(
  claimOverrides: Record<string, unknown>,
  header = { alg: "HS256", typ: "JWT" },
): string {
  const unsigned = `${encode(header)}.${encode({
    id: "user:alice",
    username: "alice",
    role: "operator",
    kind: "user",
    exp: Math.floor(Date.now() / 1000) + 60,
    ...claimOverrides,
  })}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}

function malformedHeaderToken(): string {
  const header = Buffer.from("{").toString("base64url");
  const payload = encode({
    id: "user:alice",
    username: "alice",
    role: "operator",
    kind: "user",
    exp: Math.floor(Date.now() / 1000) + 60,
  });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}

function malformedPayloadToken(): string {
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = Buffer.from("{").toString("base64url");
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}
