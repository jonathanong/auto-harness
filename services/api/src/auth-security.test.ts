/* eslint-disable max-lines -- security matrix intentionally covers every auth branch. */
import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AuthService, authModeFromEnv, type Principal } from "./auth.ts";
import { createServiceAccount as createAccount } from "./auth-accounts.ts";
import {
  authorize,
  mayAccessHost,
  mayAccessRepository,
  requiredCapability,
} from "./auth-policy.ts";
import type { AuthAccountRecord } from "./db/plane-storage.ts";

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
    await expect(
      createAccount({ name: "daemon", role: "operator", boundHostId: "host-a" }, new Map()),
    ).rejects.toThrow(/agent/);
    const first = new AuthService({
      mode: "required",
      secret: "a".repeat(32),
      admins: admins([{ username: "root", password: "root" }]),
    });
    const created = await first.createServiceAccount(
      {
        name: "agent-a",
        role: "agent",
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
    expect(await first.authenticateApiKey(created.apiKey)).toMatchObject({
      id: created.account.id,
    });

    const second = new AuthService({
      mode: "required",
      secret: "a".repeat(32),
      admins: admins([{ username: "root", password: "root" }]),
    });
    await second.hydrate(undefined);
    await second.hydrate(storage);
    expect(await second.authenticateApiKey(created.apiKey)).toMatchObject({
      allowedRepositoryIds: ["repo-a"],
      boundHostId: "host-a",
    });
    expect(await second.authenticateApiKey(plain.apiKey)).toMatchObject({
      username: "plain-agent",
    });
    expect(await second.authenticatePassword("persisted-user", "password")).toMatchObject(
      createdUser,
    );
    const persistedUser = records.find((record) => record.username === "persisted-user")!;
    const lazy = new AuthService({
      mode: "required",
      secret: "a".repeat(32),
      admins: admins([{ username: "root", password: "root" }]),
    });
    await lazy.hydrate({
      listAuthAccounts: async () => [],
      getAuthAccountByUsername: async (username) =>
        username === "persisted-user" ? persistedUser : null,
      putAuthAccount: async () => undefined,
      deleteAuthAccount: async () => undefined,
    });
    expect(await lazy.authenticatePassword("persisted-user", "password")).toMatchObject(
      createdUser,
    );
    expect(await second.authenticateApiKey(`${created.apiKey}x`)).toBeNull();
    expect(await second.authenticateApiKey("anything")).toBeNull();
    await second.deleteUser("persisted-user", storage);
    await second.deleteServiceAccount(plain.account.id, storage);
  });

  it("preserves colons in Basic passwords and revokes deleted users' cookies", async () => {
    const auth = new AuthService({
      mode: "required",
      secret: "a".repeat(32),
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
    for (const token of ["..signature", "header..signature", "header.payload."]) {
      expect(
        await auth.authenticate(request({ cookie: `auto_harness_session=${token}` })),
      ).toBeNull();
    }
    await expect(
      auth.createUser({ username: "", password: "x", role: "operator" }),
    ).rejects.toThrow();
    await expect(
      auth.createUser({ username: "bad\u0000name", password: "x", role: "operator" }),
    ).rejects.toThrow();
    await expect(
      auth.createUser({ username: "x".repeat(257), password: "x", role: "operator" }),
    ).rejects.toThrow();
    await expect(
      auth.createUser({ username: "root", password: "x", role: "operator" }),
    ).rejects.toThrow();
    await expect(auth.createServiceAccount({ name: "", role: "operator" })).rejects.toThrow();
    await auth.deleteUser("alice");
    expect(await auth.authenticate(request({ cookie }))).toBeNull();
  });

  it("changes only user passwords after checking the current password and durable write", async () => {
    const updates: Array<{
      id: string;
      expectedPasswordHash: string;
      passwordHash: string;
      updatedAt: string;
    }> = [];
    const storage = {
      listAuthAccounts: async () => [],
      putAuthAccount: async () => undefined,
      updateAuthAccountPassword: async (
        id: string,
        expectedPasswordHash: string,
        passwordHash: string,
        updatedAt: string,
      ) => {
        updates.push({ id, expectedPasswordHash, passwordHash, updatedAt });
        return true;
      },
      deleteAuthAccount: async () => undefined,
    };
    const auth = new AuthService({
      mode: "required",
      secret: "a".repeat(32),
      admins: admins([{ username: "root", password: "root" }]),
    });
    const user = await auth.createUser({ username: "alice", password: "before", role: "operator" });
    expect(await auth.changePassword(user, "wrong", "after", storage)).toBe(
      "invalid-current-password",
    );
    expect(updates).toEqual([]);
    expect(await auth.changePassword(user, "before", "", storage)).toBe("invalid-new-password");
    expect(await auth.changePassword(user, "before", "after", storage)).toBe("changed");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ id: "user:alice", updatedAt: expect.any(String) });
    expect(updates[0]?.expectedPasswordHash).not.toBe("before");
    expect(updates[0]?.passwordHash).not.toBe("after");
    expect(await auth.authenticatePassword("alice", "before")).toBeNull();
    expect(await auth.authenticatePassword("alice", "after")).toMatchObject(user);
    expect(await auth.changePassword(admin, "root", "after", storage)).toBe("unsupported-account");
    expect(await auth.changePassword({ ...user, id: "user:gone" }, "after", "later", storage)).toBe(
      "missing-account",
    );
    storage.updateAuthAccountPassword = async () => false;
    expect(await auth.changePassword(user, "after", "later", storage)).toBe("missing-account");
    expect(await auth.authenticatePassword("alice", "after")).toMatchObject(user);
    expect(
      await auth.changePassword(user, "after", "later", {
        listAuthAccounts: async () => [],
        putAuthAccount: async () => undefined,
        deleteAuthAccount: async () => undefined,
      }),
    ).toBe("storage-unavailable");
  });

  it("uses a compare-and-swap password write so only one concurrent change succeeds", async () => {
    let persistedHash: string | undefined;
    const storage = {
      listAuthAccounts: async () => [],
      putAuthAccount: async () => undefined,
      updateAuthAccountPassword: async (
        _id: string,
        expectedPasswordHash: string,
        passwordHash: string,
        _updatedAt: string,
      ) => {
        if (persistedHash === undefined) persistedHash = expectedPasswordHash;
        if (persistedHash !== expectedPasswordHash) return false;
        persistedHash = passwordHash;
        return true;
      },
      deleteAuthAccount: async () => undefined,
    };
    const auth = new AuthService({
      mode: "required",
      secret: "a".repeat(32),
      admins: admins([{ username: "root", password: "root" }]),
    });
    const user = await auth.createUser({ username: "alice", password: "before", role: "operator" });

    const results = await Promise.all([
      auth.changePassword(user, "before", "after-one", storage),
      auth.changePassword(user, "before", "after-two", storage),
    ]);

    expect(results.filter((result) => result === "changed")).toHaveLength(1);
    expect(results.filter((result) => result === "missing-account")).toHaveLength(1);
    expect(await auth.authenticatePassword("alice", "before")).toBeNull();
    expect(
      Boolean(await auth.authenticatePassword("alice", "after-one")) !==
        Boolean(await auth.authenticatePassword("alice", "after-two")),
    ).toBe(true);
  });

  it("reads durable password hashes on every worker after rotation or deletion", async () => {
    let record: AuthAccountRecord | null = null;
    const storage = {
      listAuthAccounts: async () => (record ? [{ ...record }] : []),
      getAuthAccount: async (id: string) => (record?.id === id ? { ...record } : null),
      getAuthAccountByUsername: async (username: string) =>
        record?.username === username ? { ...record } : null,
      putAuthAccount: async (value: AuthAccountRecord) => {
        record = { ...value };
      },
      updateAuthAccountPassword: async (
        id: string,
        expectedPasswordHash: string,
        passwordHash: string,
        updatedAt: string,
      ) => {
        if (record?.id !== id || record.passwordHash !== expectedPasswordHash) return false;
        record = { ...record, passwordHash, updatedAt };
        return true;
      },
      deleteAuthAccount: async () => {
        record = null;
      },
    };
    const options = {
      mode: "required" as const,
      secret: "a".repeat(32),
      admins: admins([{ username: "root", password: "root" }]),
    };
    const first = new AuthService(options);
    await first.hydrate(storage);
    const user = await first.createUser(
      { username: "alice", password: "before", role: "operator" },
      storage,
    );
    const second = new AuthService(options);
    await second.hydrate(storage);

    expect(await second.authenticatePassword("alice", "before")).toMatchObject(user);
    expect(await first.changePassword(user, "before", "after")).toBe("changed");
    expect(await second.authenticatePassword("alice", "before")).toBeNull();
    expect(await second.authenticatePassword("alice", "after")).toMatchObject(user);
    record = null;
    expect(await second.authenticatePassword("alice", "after")).toBeNull();
  });

  it("checks roles, repository scopes, and host bindings centrally", () => {
    const readOnly: Principal = { ...admin, role: "read-only", kind: "user" };
    const operator: Principal = { ...admin, role: "operator", kind: "service-account" };
    expect(authorize(readOnly, "GET", "/api/v1/sessions")).toBe(true);
    expect(authorize(readOnly, "POST", "/api/v1/sessions")).toBe(false);
    expect(authorize(operator, "POST", "/api/v1/sessions")).toBe(true);
    expect(authorize(operator, "POST", "/api/v1/hosts/drain")).toBe(true);
    expect(authorize(operator, "PUT", "/api/v1/hosts/host-a/inventory")).toBe(false);
    expect(authorize(admin, "POST", "/api/v1/auth/users")).toBe(true);
    expect(authorize(operator, "POST", "/api/v1/auth/users")).toBe(false);
    const scheduleRoute = "/api/v1/schedules/schedule-1";
    expect(authorize(readOnly, "GET", "/api/v1/schedules")).toBe(true);
    expect(authorize(readOnly, "POST", "/api/v1/schedules")).toBe(false);
    expect(authorize(readOnly, "PATCH", scheduleRoute)).toBe(false);
    expect(authorize(readOnly, "POST", `${scheduleRoute}/trigger`)).toBe(false);
    expect(authorize(readOnly, "DELETE", scheduleRoute)).toBe(false);
    expect(authorize(operator, "POST", "/api/v1/schedules")).toBe(true);
    expect(authorize(operator, "PATCH", scheduleRoute)).toBe(true);
    expect(authorize(operator, "POST", `${scheduleRoute}/trigger`)).toBe(true);
    expect(authorize(operator, "DELETE", scheduleRoute)).toBe(true);
    expect(authorize(admin, "POST", "/api/v1/schedules")).toBe(true);
    expect(authorize(admin, "PATCH", scheduleRoute)).toBe(true);
    expect(authorize(admin, "POST", `${scheduleRoute}/trigger`)).toBe(true);
    expect(authorize(admin, "DELETE", scheduleRoute)).toBe(true);
    const author: Principal = { ...admin, role: "author", kind: "user" };
    const maintainer: Principal = { ...admin, role: "maintainer", kind: "user" };
    const agent: Principal = {
      ...admin,
      role: "agent",
      kind: "service-account",
      boundHostId: "host-a",
    };
    expect(authorize(author, "POST", "/api/v1/sessions")).toBe(true);
    expect(authorize(author, "POST", "/api/v1/schedules")).toBe(false);
    expect(authorize(author, "POST", "/api/v1/hosts/drain")).toBe(false);
    expect(authorize(maintainer, "PUT", "/api/v1/hosts/host-a/inventory")).toBe(true);
    expect(authorize(maintainer, "POST", "/api/v1/commands")).toBe(false);
    expect(authorize(maintainer, "POST", "/api/v1/provider-accounts")).toBe(true);
    expect(authorize(agent, "POST", "/api/v1/host/messages")).toBe(true);
    expect(authorize(agent, "POST", "/api/v1/sessions")).toBe(true);
    expect(authorize(agent, "POST", "/api/v1/commands")).toBe(false);
    expect(authorize(operator, "POST", "/api/v1/host/messages")).toBe(false);
    expect(authorize(admin, "POST", "/api/v1/not-a-real-route")).toBe(false);
    expect(mayAccessRepository({ ...operator, allowedRepositoryIds: ["repo-a"] }, "repo-b")).toBe(
      false,
    );
    expect(mayAccessHost({ ...operator, boundHostId: "host-a" }, "host-b")).toBe(false);
    expect(mayAccessHost({ ...operator, boundHostId: "host-a" }, "host-a")).toBe(true);
    expect(requiredCapability("GET", "/api/v1/integrations/slack")).toBe("integrations:write");
    expect(requiredCapability("GET", "/api/v1/auth/users")).toBe("accounts:write");
    expect(requiredCapability("GET", "/api/v1/audit-logs")).toBe("audit:read");
    expect(requiredCapability("POST", "/api/v1/scheduler/assign")).toBe("scheduler:run");
    expect(requiredCapability("GET", "/api/v1/hosts/h/inventory")).toBe("authenticated");
    expect(requiredCapability("PUT", "/api/v1/hosts/h/inventory")).toBe("fleet:inventory");
    expect(requiredCapability("POST", "/api/v1/sessions/s/archive")).toBe("sessions:archive");
    expect(requiredCapability("POST", "/api/v1/sessions/s/cancel")).toBe("sessions:write");
    expect(requiredCapability("GET", "/api/v1/sessions")).toBe("authenticated");
    expect(requiredCapability("POST", "/api/v1/unknown")).toBeNull();
    expect(requiredCapability("GET", "/health")).toBe("authenticated");
  });

  it("rejects tampered or stale cookie claims", async () => {
    const secret = "a".repeat(32);
    const auth = new AuthService({
      mode: "required",
      secret,
      admins: admins([{ username: "root", password: "root" }]),
    });
    const base = { id: "admin:root", username: "root", role: "admin", kind: "admin" };
    const future = Math.floor(Date.now() / 1000) + 60;
    expect(
      await auth.authenticate(
        request({
          cookie: signedCookie(secret, { ...base, exp: future }, { alg: "none", typ: "JWT" }),
        }),
      ),
    ).toBeNull();
    expect(
      await auth.authenticate(
        request({ cookie: signedCookie(secret, { ...base, kind: "unknown", exp: future }) }),
      ),
    ).toBeNull();
    expect(
      await auth.authenticate(
        request({ cookie: signedCookie(secret, { ...base, role: "bogus", exp: future }) }),
      ),
    ).toBeNull();
    expect(
      await auth.authenticate(request({ cookie: signedCookie(secret, { ...base, exp: 0 }) })),
    ).toBeNull();
    expect(
      await auth.authenticate(
        request({ cookie: signedCookie("b".repeat(32), { ...base, exp: future }) }),
      ),
    ).toBeNull();
    const valid = signedCookie(secret, { ...base, exp: future });
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
    expect(await auth.authenticate(request({ cookie: `${cookie}.junk` }))).toBeNull();
    expect(
      await auth.authenticate(
        request({ cookie: signedCookie(secret, { ...base, id: "admin:missing", exp: future }) }),
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
    const mismatch = signedCookie(secret, {
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
      (await auth.authenticateApiKey(service2.apiKey))!,
    );
    expect(
      await auth.authenticate(request({ cookie: service2Cookie.split(";")[0]! })),
    ).toMatchObject({
      id: service2.account.id,
      username: "agent-2",
      role: "operator",
      kind: "service-account",
    });
    const scoped = await auth.createServiceAccount({
      name: "scoped",
      role: "agent",
      allowedRepositoryIds: ["repo-a"],
      boundHostId: "host-a",
    });
    const scopedClaims = {
      id: scoped.account.id,
      username: scoped.account.username,
      role: scoped.account.role,
      kind: scoped.account.kind,
      allowedRepositoryIds: ["repo-a"],
      boundHostId: "host-a",
      exp: future,
    };
    expect(
      await auth.authenticate(request({ cookie: signedCookie(secret, scopedClaims) })),
    ).toMatchObject({ id: scoped.account.id });
    for (const claims of [
      { ...scopedClaims, allowedRepositoryIds: undefined },
      { ...scopedClaims, allowedRepositoryIds: ["repo-a", "repo-b"] },
      { ...scopedClaims, allowedRepositoryIds: ["repo-b"] },
      { ...scopedClaims, boundHostId: "host-b" },
      { ...scopedClaims, unexpected: true },
    ]) {
      expect(await auth.authenticate(request({ cookie: signedCookie(secret, claims) }))).toBeNull();
    }
  });
});
