import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { proxy } from "./proxy.ts";

const secret = "a".repeat(32);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("host-pane authentication proxy", () => {
  afterEach(() => {
    delete process.env.HARNESS_AUTH_MODE;
    delete process.env.HARNESS_SESSION_SECRET;
  });

  it("allows local disabled mode and requires a signed session in required mode", async () => {
    const request = new NextRequest("http://localhost/api/browse");
    expect((await proxy(request)).headers.get("x-middleware-next")).toBe("1");

    process.env.HARNESS_AUTH_MODE = "required";
    process.env.HARNESS_SESSION_SECRET = secret;
    const denied = await proxy(request);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("content-type")).toMatch(/text\/html/);
    const body = await denied.text();
    expect(body).toMatch(/<!DOCTYPE html>/i);
    expect(body).toMatch(/debug/i);
    expect(body).toMatch(/control plane/i);
    expect(body).not.toBe("authentication required");
    const forged = new NextRequest("http://localhost/api/browse", {
      headers: { cookie: "auto_harness_session=signed" },
    });
    expect((await proxy(forged)).status).toBe(401);
    const viewer = new NextRequest("http://localhost/api/browse", {
      headers: { cookie: `auto_harness_session=${signedToken({ audience: "viewer" })}` },
    });
    expect((await proxy(viewer)).status).toBe(401);
    const authenticated = new NextRequest("http://localhost/api/browse", {
      headers: { cookie: `auto_harness_session=${signedToken()}` },
    });
    expect((await proxy(authenticated)).headers.get("x-middleware-next")).toBe("1");
  });
});

function signedToken(claimOverrides: Record<string, unknown> = {}): string {
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    id: "user:alice",
    username: "alice",
    role: "operator",
    kind: "user",
    exp: Math.floor(Date.now() / 1000) + 60,
    ...claimOverrides,
  })}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}
