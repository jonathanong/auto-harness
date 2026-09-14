import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { handleAuthRoutes } from "./local-routes-auth.ts";

function authService(): AuthService {
  return new AuthService({
    mode: "required",
    secret: "a".repeat(32),
    admins: Buffer.from(JSON.stringify([{ username: "root", password: "root-password" }])).toString(
      "base64url",
    ),
  });
}

function loginRequest(body: object) {
  const payload = Buffer.from(JSON.stringify(body));
  const req = {
    on(event: string, callback: (chunk?: Buffer) => void) {
      if (event === "data") callback(payload);
      if (event === "end") callback();
      return req;
    },
  };
  let status = 0;
  const res = {
    setHeader() {},
    writeHead(code: number) {
      status = code;
    },
    end() {},
  };
  return { req, res, statusOf: () => status };
}

describe("auth login audit", () => {
  it("returns 500 when a password failure cannot be audited", async () => {
    const auth = authService();
    auth.authenticate = async () => null;
    auth.authenticatePassword = async () => {
      throw new Error("store down");
    };
    const { req, res, statusOf } = loginRequest({ username: "root", password: "root-password" });
    expect(
      await handleAuthRoutes({
        auth,
        plane: { appendAuditLog: async () => Promise.reject(new Error("audit down")) } as never,
        req: req as never,
        res: res as never,
        url: new URL("http://localhost/api/v1/auth/login"),
        method: "POST",
        principal: undefined,
      }),
    ).toBe(true);
    expect(statusOf()).toBe(500);
  });

  it("returns 401 when a password failure is audited", async () => {
    const auth = authService();
    auth.authenticate = async () => null;
    auth.authenticatePassword = async () => {
      throw new Error("store down");
    };
    const { req, res, statusOf } = loginRequest({ username: "root", password: "root-password" });
    expect(
      await handleAuthRoutes({
        auth,
        plane: { appendAuditLog: async () => undefined } as never,
        req: req as never,
        res: res as never,
        url: new URL("http://localhost/api/v1/auth/login"),
        method: "POST",
        principal: undefined,
      }),
    ).toBe(true);
    expect(statusOf()).toBe(401);
  });
});
