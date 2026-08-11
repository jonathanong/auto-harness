import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeBadJson, invokeHandler } from "./local-server-test-helpers.ts";

function errorCode(response: Awaited<ReturnType<typeof invokeHandler>>): string | undefined {
  return (response.json as { error?: { code?: string } }).error?.code;
}

describe("local auth route error semantics", () => {
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
