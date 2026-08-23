/* eslint-disable max-lines */
import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeBadJson, invokeHandler } from "./local-server-test-helpers.ts";

function admins(): string {
  return Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
    "base64url",
  );
}

describe("createLocalApp authentication routes", () => {
  it("refuses to orphan schedules when deleting their authenticated owner", async () => {
    const plane = new ControlPlane();
    plane.createRepository({ id: "repo", name: "repo", url: "https://example.test/repo" });
    plane.createCommand({ id: "command", name: "command", argv: ["echo"], providerId: null });
    const auth = new AuthService({ mode: "disabled", secret: "secret", admins: admins() });
    const principal = await auth.createUser({
      username: "alice",
      password: "password",
      role: "operator",
    });
    expect(
      plane.putSchedule({
        id: "owned-schedule",
        repositoryId: "repo",
        principalId: principal.id,
        name: "owned",
        target: { commandId: "command" },
        cron: "* * * * *",
        timeout: 30,
      }),
    ).toMatchObject({ ok: true });
    const { handler } = createLocalApp({ plane, authService: auth });

    const response = await invokeHandler(handler, "DELETE", "/api/v1/auth/users/alice");

    expect(response.status).toBe(409);
    expect(response.json).toMatchObject({
      error: {
        code: "CONFLICT",
        dependencies: [{ kind: "schedule", id: "owned-schedule" }],
      },
    });
    expect(auth.listUsers()).toContainEqual(expect.objectContaining({ id: principal.id }));
  });

  it("supports login/logout and principal administration", async () => {
    const plane = new ControlPlane();
    const auth = new AuthService({ mode: "disabled", secret: "secret", admins: admins() });
    const { handler } = createLocalApp({ plane, authService: auth });
    const invoke = (
      method: string,
      path: string,
      body?: unknown,
      headers?: Record<string, string>,
    ) => invokeHandler(handler, method, path, body, headers);

    expect((await invoke("GET", "/api/v1/auth/users")).json).toEqual({ items: [] });
    expect((await invoke("POST", "/api/v1/auth/users", {})).status).toBe(400);
    const user = await invoke("POST", "/api/v1/auth/users", {
      username: "alice",
      password: "password",
      role: "operator",
    });
    expect(user.status).toBe(201);
    expect(user.json).toMatchObject({ username: "alice", role: "operator" });
    expect(
      (
        await invoke("POST", "/api/v1/auth/users", {
          username: "alice",
          password: "password",
          role: "operator",
        })
      ).status,
    ).toBe(409);
    expect((await invoke("GET", "/api/v1/auth/users")).json).toMatchObject({
      items: [expect.objectContaining({ username: "alice" })],
    });

    const invalidAccount = await invoke("POST", "/api/v1/auth/service-accounts", {
      name: "agent-a",
      role: "operator",
      allowedRepositoryIds: ["repo-a", 4],
      boundHostId: "host-a",
    });
    expect(
      (await invoke("POST", "/api/v1/auth/service-accounts", { name: "bad", role: "invalid" }))
        .status,
    ).toBe(400);
    expect(invalidAccount.status).toBe(400);
    const account = await invoke("POST", "/api/v1/auth/service-accounts", {
      name: "agent-a",
      role: "agent",
      allowedRepositoryIds: ["repo-a"],
      boundHostId: "host-a",
    });
    expect(account.status).toBe(201);
    expect(account.json).toMatchObject({
      account: { name: "agent-a", createdAt: expect.any(String) },
      apiKey: expect.any(String),
    });
    const legacyDaemon = await invoke("POST", "/api/v1/auth/service-accounts", {
      name: "legacy-daemon",
      role: "operator",
      boundHostId: "host-a",
    });
    expect(legacyDaemon.status).toBe(201);
    expect(legacyDaemon.json).toMatchObject({
      account: { name: "legacy-daemon", role: "agent", boundHostId: "host-a" },
    });
    const remappedUser = await invoke("POST", "/api/v1/auth/users", {
      username: "repo-admin",
      password: "password",
      role: "admin",
      allowedRepositoryIds: ["repo-a"],
    });
    expect(remappedUser.status).toBe(201);
    expect(remappedUser.json).toMatchObject({ username: "repo-admin", role: "maintainer" });
    expect((await invoke("DELETE", "/api/v1/auth/users/repo-admin")).status).toBe(204);
    const scopedAccount = await invoke("POST", "/api/v1/auth/service-accounts", {
      name: "agent-b",
      role: "read-only",
      allowedRepositoryIds: ["repo-a"],
    });
    expect(scopedAccount.status).toBe(201);
    expect((await invoke("GET", "/api/v1/auth/service-accounts")).json).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ name: "agent-a", createdAt: expect.any(String) }),
      ]),
    });
    const accountId = (account.json as { account: { id: string } }).account.id;
    const legacyId = (legacyDaemon.json as { account: { id: string } }).account.id;
    const scopedId = (scopedAccount.json as { account: { id: string } }).account.id;
    expect((await invoke("DELETE", `/api/v1/auth/service-accounts/${accountId}`)).status).toBe(204);
    expect((await invoke("DELETE", `/api/v1/auth/service-accounts/${accountId}`)).status).toBe(404);
    expect((await invoke("DELETE", `/api/v1/auth/service-accounts/${legacyId}`)).status).toBe(204);
    expect((await invoke("DELETE", `/api/v1/auth/service-accounts/${scopedId}`)).status).toBe(204);
    expect((await invoke("DELETE", "/api/v1/auth/users/alice")).status).toBe(204);
    expect((await invoke("DELETE", "/api/v1/auth/users/alice")).status).toBe(404);

    const login = await invoke("POST", "/api/v1/auth/login", {
      username: "root",
      password: "root",
    });
    expect(login.status).toBe(200);
    expect(
      (
        await invoke("POST", "/api/v1/auth/login", undefined, {
          authorization: `Basic ${Buffer.from("root:root").toString("base64")}`,
        })
      ).status,
    ).toBe(200);
    expect((await invoke("POST", "/api/v1/auth/login", {})).status).toBe(401);
    expect(
      (await invoke("POST", "/api/v1/auth/login", { username: "root", password: "bad" })).status,
    ).toBe(401);
    expect((await invoke("POST", "/api/v1/auth/logout")).status).toBe(204);

    expect(await invokeBadJson(handler, "POST", "/api/v1/auth/users")).toBe(400);
    expect(await invokeBadJson(handler, "POST", "/api/v1/auth/service-accounts")).toBe(400);

    expect((await invoke("POST", "/api/v1/host/messages", {})).status).toBe(400);
    expect((await invoke("POST", "/api/v1/scheduler/assign")).status).toBe(200);
    expect((await invoke("POST", "/api/v1/scheduler/ack-deadlines")).status).toBe(200);
    expect((await invoke("POST", "/api/v1/scheduler/reclaim-stale")).status).toBe(200);
    expect((await invoke("POST", "/api/v1/scheduler/cron")).status).toBe(200);
    expect((await invoke("POST", "/api/v1/hosts/drain", {})).status).toBe(400);
    expect((await invoke("GET", "/api/v1/worktrees")).status).toBe(200);

    const throwingLogin = new AuthService({ mode: "disabled", secret: "secret", admins: admins() });
    (throwingLogin as unknown as { issueCookie: () => never }).issueCookie = () => {
      throw "cookie failure";
    };
    const loginApp = createLocalApp({ plane: new ControlPlane(), authService: throwingLogin });
    expect(
      (
        await invokeHandler(loginApp.handler, "POST", "/api/v1/auth/login", {
          username: "root",
          password: "root",
        })
      ).status,
    ).toBe(500);

    const throwingUser = new AuthService({ mode: "disabled", secret: "secret", admins: admins() });
    (throwingUser as unknown as { createUser: () => Promise<never> }).createUser = async () => {
      throw "user failure";
    };
    const userApp = createLocalApp({ plane: new ControlPlane(), authService: throwingUser });
    expect(
      (
        await invokeHandler(userApp.handler, "POST", "/api/v1/auth/users", {
          username: "bob",
          password: "password",
          role: "operator",
        })
      ).status,
    ).toBe(500);

    const throwingAccount = new AuthService({
      mode: "disabled",
      secret: "secret",
      admins: admins(),
    });
    (
      throwingAccount as unknown as { createServiceAccount: () => Promise<never> }
    ).createServiceAccount = async () => {
      throw "account failure";
    };
    const accountApp = createLocalApp({ plane: new ControlPlane(), authService: throwingAccount });
    expect(
      (
        await invokeHandler(accountApp.handler, "POST", "/api/v1/auth/service-accounts", {
          name: "agent",
          role: "operator",
        })
      ).status,
    ).toBe(500);
  });

  it("protects account administration in required mode", async () => {
    const auth = new AuthService({ mode: "required", secret: "a".repeat(32), admins: admins() });
    const { apiKey } = await auth.createServiceAccount({ name: "operator", role: "operator" });
    const { handler } = createLocalApp({ plane: new ControlPlane(), authService: auth });
    const body = { username: "alice", password: "password", role: "operator" };
    expect((await invokeHandler(handler, "POST", "/api/v1/auth/users", body)).status).toBe(401);
    expect(
      (
        await invokeHandler(handler, "POST", "/api/v1/auth/users", body, {
          authorization: `Bearer ${apiKey}`,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeHandler(handler, "GET", "/api/v1/auth/users", undefined, {
          authorization: `Bearer ${apiKey}`,
        })
      ).status,
    ).toBe(403);
  });
});
