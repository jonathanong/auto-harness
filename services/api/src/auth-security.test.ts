/* eslint-disable max-lines -- security matrix intentionally covers every auth branch. */
import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AuthService, authModeFromEnv, type Principal } from "./auth.ts";
import { createServiceAccount as createAccount } from "./auth-accounts.ts";
import { authorize, mayAccessHost, mayAccessRepository } from "./auth-policy.ts";

function admins(entries: Array<{ username: string; password: string }>): string {
  return Buffer.from(JSON.stringify(entries)).toString("base64url");
}

function request(headers: Record<string, string>): { headers: Record<string, string> } {
  return { headers };
}

const admin: Principal = { id: "admin:root", username: "root", role: "admin", kind: "admin" };
const encodeJson = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function signedCookie(
  secret: string,
  payload: Record<string, unknown>,
  header = { alg: "HS256", typ: "JWT" },
): string {
  const unsigned = `${encodeJson(header)}.${encodeJson(payload)}`;
  return `auto_harness_session=${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}

describe("control-plane authentication security", () => {
  it("requires a secret and bootstrap admin in required mode", () => {
    expect(() => new AuthService({ mode: "required", secret: "" })).toThrow();
    expect(() => new AuthService({ mode: "disabled", admins: "not-json" })).toThrow();
    expect(
      () =>
        new AuthService({
          mode: "disabled",
          admins: Buffer.from(JSON.stringify([{}])).toString("base64url"),
        }),
    ).toThrow();
    expect(
      () =>
        new AuthService({
          mode: "disabled",
          admins: Buffer.from(JSON.stringify([{ username: "", password: "" }])).toString(
            "base64url",
          ),
        }),
    ).toThrow();
    expect(authModeFromEnv()).toBe("disabled");
    expect(authModeFromEnv("required")).toBe("required");
    expect(() => authModeFromEnv("invalid")).toThrow();
  });

  it("persists and hydrates service accounts without retaining the clear key", async () => {
    const records: unknown[] = [];
    const storage = {
      listAuthAccounts: async () => records as never[],
      putAuthAccount: async (record: unknown) => void records.push(record),
      deleteAuthAccount: async () => undefined,
    };
    await expect(createAccount({ name: "", role: "operator" }, new Map())).rejects.toThrow();
    const first = new AuthService({
      mode: "required",
      secret: "secret",
      admins: admins([{ username: "root", password: "root" }]),
    });
    const created = await first.createServiceAccount(
      {
        name: "agent-a",
        role: "operator",
        allowedRepositoryIds: ["repo-a"],
        boundHostId: "host-a",
      },
      storage,
    );
    const plain = await first.createServiceAccount(
      { name: "plain-agent", role: "operator" },
      storage,
    );
    const createdUser = await first.createUser(
      { username: "persisted-user", password: "password", role: "read-only" },
      storage,
    );
    expect(records[0]).not.toHaveProperty("apiKey");
    records.push({
      id: "bad-key",
      username: "bad",
      kind: "service-account",
      role: "operator",
      apiKeyHash: "x",
    });
    records.push({
      id: "scoped-user",
      username: "scoped-user",
      kind: "user",
      role: "read-only",
      passwordHash: "not-used",
      allowedRepositoryIds: ["repo-a"],
      boundHostId: "host-a",
    });
    expect(first.authenticateApiKey(created.apiKey)).toMatchObject({ id: created.account.id });

    const second = new AuthService({
      mode: "required",
      secret: "secret",
      admins: admins([{ username: "root", password: "root" }]),
    });
    await second.hydrate(undefined);
    await second.hydrate(storage);
    expect(second.authenticateApiKey(created.apiKey)).toMatchObject({
      allowedRepositoryIds: ["repo-a"],
      boundHostId: "host-a",
    });
    expect(second.authenticateApiKey(plain.apiKey)).toMatchObject({ username: "plain-agent" });
    expect(await second.authenticatePassword("persisted-user", "password")).toMatchObject(
      createdUser,
    );
    expect(second.authenticateApiKey(`${created.apiKey}x`)).toBeNull();
    expect(second.authenticateApiKey("anything")).toBeNull();
    await second.deleteUser("persisted-user", storage);
    await second.deleteServiceAccount(plain.account.id, storage);
  });

  it("preserves colons in Basic passwords and revokes deleted users' cookies", async () => {
    const auth = new AuthService({
      mode: "required",
      secret: "secret",
      admins: admins([{ username: "root", password: "root" }]),
    });
    const user = await auth.createUser({ username: "alice", password: "p:a:ss", role: "operator" });
    const encoded = Buffer.from("alice:p:a:ss").toString("base64");
    expect(await auth.authenticate(request({ authorization: `Basic ${encoded}` }))).toMatchObject(
      user,
    );
    let setCookie = "";
    const response = {
      setHeader: (_name: string, value: string) => {
        setCookie = value;
      },
    };
    auth.issueCookie(response as never, user);
    const cookie = setCookie.split(";")[0]!;
    expect(await auth.authenticate(request({ cookie }))).toMatchObject(user);
    expect(await auth.authenticate(request({ authorization: "Bearer" }))).toBeNull();
    expect(await auth.authenticate(request({ authorization: "Bearer " }))).toBeNull();
    expect(await auth.authenticate(request({ authorization: "Digest value" }))).toBeNull();
    expect(
      await auth.authenticate({
        headers: {
          authorization: {
            startsWith: (value: string) => value === "Basic ",
            slice: () => {
              throw new Error("malformed authorization");
            },
          } as never,
        },
      }),
    ).toBeNull();
    expect(
      await auth.authenticate({
        headers: { authorization: `Basic ${Buffer.from("alice").toString("base64")}` },
      }),
    ).toBeNull();
    expect(
      await auth.authenticate({
        headers: { authorization: `Basic ${Buffer.from(":password").toString("base64")}` },
      }),
    ).toBeNull();
    expect(
      await auth.authenticate(request({ cookie: "auto_harness_session=malformed" })),
    ).toBeNull();
    await expect(
      auth.createUser({ username: "", password: "x", role: "operator" }),
    ).rejects.toThrow();
    await expect(
      auth.createUser({ username: "root", password: "x", role: "operator" }),
    ).rejects.toThrow();
    await expect(auth.createServiceAccount({ name: "", role: "operator" })).rejects.toThrow();
    await auth.deleteUser("alice");
    expect(await auth.authenticate(request({ cookie }))).toBeNull();
  });

  it("checks roles, repository scopes, and host bindings centrally", () => {
    const readOnly: Principal = { ...admin, role: "read-only", kind: "user" };
    const operator: Principal = { ...admin, role: "operator", kind: "service-account" };
    expect(authorize(readOnly, "GET", "/api/v1/sessions")).toBe(true);
    expect(authorize(readOnly, "POST", "/api/v1/sessions")).toBe(false);
    expect(authorize(operator, "POST", "/api/v1/sessions")).toBe(true);
    expect(authorize(operator, "POST", "/api/v1/hosts/drain")).toBe(false);
    expect(authorize(admin, "POST", "/api/v1/auth/users")).toBe(true);
    expect(authorize(operator, "POST", "/api/v1/auth/users")).toBe(false);
    expect(mayAccessRepository({ ...operator, allowedRepositoryIds: ["repo-a"] }, "repo-b")).toBe(
      false,
    );
    expect(mayAccessHost({ ...operator, boundHostId: "host-a" }, "host-b")).toBe(false);
    expect(mayAccessHost({ ...operator, boundHostId: "host-a" }, "host-a")).toBe(true);
  });

  it("rejects tampered or stale cookie claims", async () => {
    const auth = new AuthService({
      mode: "required",
      secret: "secret",
      admins: admins([{ username: "root", password: "root" }]),
    });
    const base = { id: "admin:root", username: "root", role: "admin", kind: "admin" };
    const future = Math.floor(Date.now() / 1000) + 60;
    expect(
      await auth.authenticate(
        request({
          cookie: signedCookie("secret", { ...base, exp: future }, { alg: "none", typ: "JWT" }),
        }),
      ),
    ).toBeNull();
    expect(
      await auth.authenticate(
        request({ cookie: signedCookie("secret", { ...base, kind: "unknown", exp: future }) }),
      ),
    ).toBeNull();
    expect(
      await auth.authenticate(
        request({ cookie: signedCookie("secret", { ...base, role: "bogus", exp: future }) }),
      ),
    ).toBeNull();
    expect(
      await auth.authenticate(request({ cookie: signedCookie("secret", { ...base, exp: 0 }) })),
    ).toBeNull();
    const valid = signedCookie("secret", { ...base, exp: future });
    expect(await auth.authenticate(request({ cookie: `${valid}x` }))).toBeNull();
    const root = await auth.authenticatePassword("root", "root");
    expect(root).toMatchObject(base);
    let setCookie = "";
    auth.issueCookie(
      { setHeader: (_name: string, value: string) => (setCookie = value) } as never,
      root!,
    );
    const cookie = setCookie.split(";")[0]!;
    expect(await auth.authenticate(request({ cookie }))).toMatchObject(base);
    expect(
      await auth.authenticate(
        request({ cookie: signedCookie("secret", { ...base, id: "admin:missing", exp: future }) }),
      ),
    ).toBeNull();
    const service = await auth.createServiceAccount({ name: "agent", role: "operator" });
    let serviceCookie = "";
    auth.issueCookie(
      { setHeader: (_name: string, value: string) => (serviceCookie = value) } as never,
      service.account,
    );
    const service2 = await auth.createServiceAccount({ name: "agent-2", role: "operator" });
    await auth.deleteServiceAccount(service.account.id);
    expect(await auth.authenticate(request({ cookie: serviceCookie.split(";")[0]! }))).toBeNull();
    const mismatch = signedCookie("secret", {
      id: service2.account.id,
      username: "wrong",
      role: "operator",
      kind: "service-account",
      exp: future,
    });
    expect(await auth.authenticate(request({ cookie: mismatch }))).toBeNull();
    let service2Cookie = "";
    auth.issueCookie(
      { setHeader: (_name: string, value: string) => (service2Cookie = value) } as never,
      auth.authenticateApiKey(service2.apiKey)!,
    );
    expect(
      await auth.authenticate(request({ cookie: service2Cookie.split(";")[0]! })),
    ).toMatchObject({
      id: service2.account.id,
      username: "agent-2",
      role: "operator",
      kind: "service-account",
    });
  });
});
