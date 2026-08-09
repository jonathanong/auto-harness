import { describe, expect, it } from "vitest";

import { AuthService, authModeFromEnv, type Principal } from "./auth.ts";
import { authorize, mayAccessHost, mayAccessRepository } from "./auth-policy.ts";

function admins(entries: Array<{ username: string; password: string }>): string {
  return Buffer.from(JSON.stringify(entries)).toString("base64url");
}

function request(headers: Record<string, string>): { headers: Record<string, string> } {
  return { headers };
}

const admin: Principal = { id: "admin:root", username: "root", role: "admin", kind: "admin" };

describe("control-plane authentication security", () => {
  it("requires a secret and bootstrap admin in required mode", () => {
    expect(() => new AuthService({ mode: "required", secret: "" })).toThrow();
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
    expect(records[0]).not.toHaveProperty("apiKey");
    expect(first.authenticateApiKey(created.apiKey)).toMatchObject({ id: created.account.id });

    const second = new AuthService({
      mode: "required",
      secret: "secret",
      admins: admins([{ username: "root", password: "root" }]),
    });
    await second.hydrate(storage);
    expect(second.authenticateApiKey(created.apiKey)).toMatchObject({
      allowedRepositoryIds: ["repo-a"],
      boundHostId: "host-a",
    });
    expect(second.authenticateApiKey(`${created.apiKey}x`)).toBeNull();
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
});
