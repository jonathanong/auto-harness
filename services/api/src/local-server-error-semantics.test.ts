import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
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

  it("keeps auth JSON parsing and account persistence errors distinct", async () => {
    const auth = new AuthService();
    const plane = new ControlPlane({
      storage: {
        putAuthAccount: async () => {
          throw new Error("storage unavailable");
        },
      } as never,
    });
    const { handler } = createLocalApp({ authService: auth, plane });

    expect(await invokeBadJson(handler, "POST", "/api/v1/auth/login")).toBe(400);
    const failed = await invokeHandler(handler, "POST", "/api/v1/auth/users", {
      username: "alice",
      password: "secret",
      role: "admin",
    });
    expect(failed.status).toBe(500);
    expect(errorCode(failed)).toBe("INTERNAL_ERROR");

    const invalidUser = await invokeHandler(handler, "POST", "/api/v1/auth/users", {
      username: "bad\nname",
      password: "secret",
      role: "admin",
    });
    expect(invalidUser.status).toBe(400);
    expect(errorCode(invalidUser)).toBe("VALIDATION_ERROR");
    expect((await invokeHandler(handler, "POST", "/api/v1/auth/users", null)).status).toBe(400);

    const invalidService = await invokeHandler(handler, "POST", "/api/v1/auth/service-accounts", {
      name: "bad\nname",
      role: "operator",
    });
    expect(invalidService.status).toBe(400);
    expect(errorCode(invalidService)).toBe("VALIDATION_ERROR");
    expect(
      (await invokeHandler(handler, "POST", "/api/v1/auth/service-accounts", null)).status,
    ).toBe(400);

    expect((await invokeHandler(handler, "PATCH", "/api/v1/auth/users", {})).status).toBe(404);

    const throwingAuth = new AuthService();
    throwingAuth.authenticate = async () => {
      throw new Error("auth backend unavailable");
    };
    const throwingAuthApp = createLocalApp({ authService: throwingAuth });
    const authFailure = await invokeHandler(
      throwingAuthApp.handler,
      "POST",
      "/api/v1/auth/login",
      {},
    );
    expect(authFailure.status).toBe(500);
  });

  it("keeps host and session scope failures as not-found responses", async () => {
    const auth = new AuthService({
      mode: "required",
      secret: "a".repeat(32),
      admins: Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
        "base64url",
      ),
    });
    const { apiKey } = await auth.createServiceAccount({
      name: "operator",
      role: "operator",
      allowedRepositoryIds: ["allowed-repository"],
      boundHostId: "host",
    });
    const plane = new ControlPlane();
    plane.registerHost({
      hostId: "host",
      worktrees: [
        {
          id: "worktree",
          name: "worktree",
          repositoryId: "allowed-repository",
          path: "/tmp",
          labels: [],
        },
      ],
      commandProfiles: [],
    });
    const { handler } = createLocalApp({ authService: auth, plane });
    const headers = { authorization: `Bearer ${apiKey}` };

    plane.listHostsDurable = async () => [
      { hostId: "host", repositoryIds: [], worktreeIds: ["worktree"] },
    ];
    const hosts = await invokeHandler(handler, "GET", "/api/v1/hosts", undefined, headers);
    expect(hosts.status).toBe(200);
    const denied = await invokeHandler(
      handler,
      "POST",
      "/api/v1/sessions",
      { repositoryId: "denied-repository" },
      headers,
    );
    expect(denied.status).toBe(404);
    expect(errorCode(denied)).toBe("NOT_FOUND");

    const invalidMetadata = await invokeHandler(
      handler,
      "POST",
      "/api/v1/sessions",
      {
        repositoryId: "allowed-repository",
        prompt: "metadata validation",
        target: { commandId: "echo" },
        metadata: ["not", "an", "object"],
      },
      headers,
    );
    expect(invalidMetadata.status).toBe(400);
    expect(errorCode(invalidMetadata)).toBe("VALIDATION_ERROR");
  });
});
