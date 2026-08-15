/* eslint-disable max-lines -- self-service auth coverage includes a stream-error fixture. */
import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { handleAuthRoutes } from "./local-routes-auth.ts";
import { handleSelfServiceAuthRoutes } from "./local-routes-auth-self-service.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

function admins(): string {
  return Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
    "base64url",
  );
}

describe("self-service authentication routes", () => {
  it("returns the current principal and changes user passwords", async () => {
    const auth = new AuthService({ mode: "required", secret: "a".repeat(32), admins: admins() });
    const user = await auth.createUser({ username: "alice", password: "before", role: "operator" });
    const session = { cookie: await issueCookie(auth, user) };
    const { handler } = createLocalApp({ plane: new ControlPlane(), authService: auth });

    expect(
      (await invokeHandler(handler, "GET", "/api/v1/auth/me", undefined, session)).json,
    ).toMatchObject(user);
    const viewerTicket = await invokeHandler(
      handler,
      "POST",
      "/api/v1/auth/viewer-ticket",
      undefined,
      session,
    );
    expect(viewerTicket.status).toBe(200);
    expect(
      await auth.authenticateViewerTicket((viewerTicket.json as { ticket: string }).ticket),
    ).toMatchObject(user);
    expect((await invokeHandler(handler, "POST", "/api/v1/auth/viewer-ticket")).status).toBe(401);
    expect((await invokeHandler(handler, "GET", "/api/v1/auth/me")).status).toBe(401);
    expect(
      (await invokeHandler(handler, "PUT", "/api/v1/auth/password", {}, session)).json,
    ).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(
      (
        await invokeHandler(
          handler,
          "PUT",
          "/api/v1/auth/password",
          { currentPassword: "wrong", newPassword: "after" },
          session,
        )
      ).json,
    ).toMatchObject({ error: { code: "INVALID_CREDENTIALS" } });
    expect(
      (
        await invokeHandler(
          handler,
          "PUT",
          "/api/v1/auth/password",
          { currentPassword: "before", newPassword: "" },
          session,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await invokeHandler(
          handler,
          "PUT",
          "/api/v1/auth/password",
          { currentPassword: "before", newPassword: "after" },
          session,
        )
      ).status,
    ).toBe(200);
    expect(await auth.authenticatePassword("alice", "before")).toBeNull();
    expect(await auth.authenticatePassword("alice", "after")).toMatchObject(user);
    expect(await auth.authenticatePassword("missing", "after")).toBeNull();

    const adminSession = {
      cookie: await issueCookie(auth, (await auth.authenticatePassword("root", "root"))!),
    };
    expect(
      (
        await invokeHandler(
          handler,
          "PUT",
          "/api/v1/auth/password",
          { currentPassword: "root", newPassword: "after" },
          adminSession,
        )
      ).json,
    ).toMatchObject({ error: { code: "UNSUPPORTED_ACCOUNT" } });
  });

  it("maps unavailable and missing password writes to structured errors", async () => {
    const auth = new AuthService({ mode: "required", secret: "a".repeat(32), admins: admins() });
    const user = await auth.createUser({ username: "alice", password: "before", role: "operator" });
    const session = { cookie: await issueCookie(auth, user) };
    const { handler } = createLocalApp({ plane: new ControlPlane(), authService: auth });
    const replace = (result: "missing-account" | "storage-unavailable" | "throws") => {
      (auth as unknown as { changePassword: () => Promise<unknown> }).changePassword = async () => {
        if (result === "throws") throw new Error("storage unavailable");
        return result;
      };
    };

    replace("missing-account");
    expect(
      (
        await invokeHandler(
          handler,
          "PUT",
          "/api/v1/auth/password",
          { currentPassword: "before", newPassword: "after" },
          session,
        )
      ).json,
    ).toMatchObject({ error: { code: "NOT_FOUND" } });
    replace("storage-unavailable");
    expect(
      (
        await invokeHandler(
          handler,
          "PUT",
          "/api/v1/auth/password",
          { currentPassword: "before", newPassword: "after" },
          session,
        )
      ).json,
    ).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    replace("throws");
    expect(
      (
        await invokeHandler(
          handler,
          "PUT",
          "/api/v1/auth/password",
          { currentPassword: "before", newPassword: "after" },
          session,
        )
      ).json,
    ).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    (auth as unknown as { changePassword: () => Promise<unknown> }).changePassword = async () =>
      "changed";
    (auth as unknown as { issueCookie: () => never }).issueCookie = () => {
      throw new Error("cookie write failed");
    };
    expect(
      (
        await invokeHandler(
          handler,
          "PUT",
          "/api/v1/auth/password",
          { currentPassword: "before", newPassword: "after" },
          session,
        )
      ).json,
    ).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
  });

  it("keeps disabled loopback mode while self-service endpoints require a session", async () => {
    const auth = new AuthService({ mode: "disabled", secret: "a".repeat(32), admins: admins() });
    const user = await auth.createUser({ username: "alice", password: "before", role: "operator" });
    const { handler } = createLocalApp({ plane: new ControlPlane(), authService: auth });
    expect(
      (
        await invokeHandler(handler, "GET", "/api/v1/auth/me", undefined, {
          cookie: await issueCookie(auth, user),
        })
      ).json,
    ).toMatchObject(user);
    expect((await invokeHandler(handler, "GET", "/api/v1/auth/me")).status).toBe(401);
    expect((await invokeHandler(handler, "POST", "/api/v1/auth/viewer-ticket")).json).toEqual({
      ticket: null,
    });
    expect((await invokeHandler(handler, "PUT", "/api/v1/auth/password", {})).status).toBe(401);
    expect((await invokeHandler(handler, "GET", "/api/v1/auth/unknown")).status).toBe(404);
  });

  it("rejects a ticket request without a principal when called outside the server guard", async () => {
    const auth = new AuthService({ mode: "required", secret: "a".repeat(32), admins: admins() });
    let status = 0;
    const result = await handleSelfServiceAuthRoutes({
      auth,
      plane: new ControlPlane(),
      req: {} as never,
      res: {
        setHeader() {
          /* response header */
        },
        writeHead(code: number) {
          status = code;
        },
        end() {
          /* response body */
        },
      } as never,
      url: new URL("http://localhost/api/v1/auth/viewer-ticket"),
      method: "POST",
    });
    expect(result).toBe(true);
    expect(status).toBe(401);
  });

  it("uses a safe validation message when a request stream rejects with a non-Error", async () => {
    const auth = new AuthService({ mode: "disabled", secret: "a".repeat(32), admins: admins() });
    const principal = await auth.createUser({
      username: "alice",
      password: "before",
      role: "operator",
    });
    let status = 0;
    let payload = "";
    const req = {
      on(event: string, callback: (reason?: unknown) => void) {
        if (event === "error") callback("stream closed");
        return req;
      },
    };
    const res = {
      setHeader() {
        /* response header */
      },
      writeHead(code: number) {
        status = code;
      },
      end(value?: string) {
        payload = value ?? "";
      },
    };

    expect(
      await handleAuthRoutes({
        auth,
        plane: new ControlPlane(),
        req: req as never,
        res: res as never,
        url: new URL("http://localhost/api/v1/auth/password"),
        method: "PUT",
        principal,
      }),
    ).toBe(true);
    expect(status).toBe(400);
    expect(JSON.parse(payload)).toMatchObject({
      error: { code: "VALIDATION_ERROR", message: "invalid password change" },
    });
  });
});

async function issueCookie(
  auth: AuthService,
  principal: Awaited<ReturnType<AuthService["authenticatePassword"]>>,
) {
  let header = "";
  auth.issueCookie(
    { setHeader: (_name: string, value: string) => (header = value) } as never,
    principal!,
  );
  return header.split(";")[0]!;
}
