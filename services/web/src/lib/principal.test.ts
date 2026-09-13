import { afterEach, describe, expect, it, vi } from "vitest";

import { can, isRepositoryScoped, loadPrincipal, type MePrincipal } from "./principal.ts";

const original = process.env.HARNESS_AUTH_MODE;

afterEach(() => {
  if (original === undefined) delete process.env.HARNESS_AUTH_MODE;
  else process.env.HARNESS_AUTH_MODE = original;
});

describe("can", () => {
  it("allows every write when authentication is disabled", () => {
    expect(can(undefined, "catalog:write")).toBe(true);
    expect(can(undefined, "accounts:write")).toBe(true);
  });

  it("fails closed when required authentication has no principal", () => {
    expect(can(null, "catalog:write")).toBe(false);
    expect(can(null, "fleet:inventory")).toBe(false);
  });

  it("uses the shared role table for an authenticated principal", () => {
    const operator: MePrincipal = { username: "op", role: "operator", kind: "user" };
    expect(can(operator, "sessions:write")).toBe(true);
    expect(can(operator, "catalog:write")).toBe(false);
    expect(can(operator, "fleet:drain")).toBe(true);
    expect(can({ ...operator, role: "author" }, "schedules:write")).toBe(false);
    expect(can({ ...operator, role: "maintainer" }, "fleet:inventory")).toBe(true);
    expect(can({ ...operator, role: "maintainer" }, "fleet:exec-config")).toBe(false);
    expect(can({ ...operator, role: "admin" }, "fleet:exec-config")).toBe(true);
    expect(can({ ...operator, role: "admin" }, "accounts:write")).toBe(true);
    expect(
      can(
        { username: "scoped", role: "admin", kind: "user", allowedRepositoryIds: ["repo"] },
        "accounts:write",
      ),
    ).toBe(false);
  });
});

describe("isRepositoryScoped", () => {
  it("is true only when allowedRepositoryIds is a nonempty list", () => {
    expect(isRepositoryScoped(undefined)).toBe(false);
    expect(isRepositoryScoped(null)).toBe(false);
    expect(isRepositoryScoped({ username: "op", role: "operator", kind: "user" })).toBe(false);
    expect(
      isRepositoryScoped({
        username: "op",
        role: "operator",
        kind: "user",
        allowedRepositoryIds: [],
      }),
    ).toBe(false);
    expect(
      isRepositoryScoped({
        username: "scoped",
        role: "author",
        kind: "user",
        allowedRepositoryIds: ["repo"],
      }),
    ).toBe(true);
  });
});

describe("loadPrincipal", () => {
  it("skips the network when authentication is disabled", async () => {
    delete process.env.HARNESS_AUTH_MODE;
    expect(await loadPrincipal()).toBeUndefined();
  });

  it("loads /auth/me when authentication is required", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    const me = { username: "op", role: "operator", kind: "user" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(me), { status: 200 })),
    );
    await expect(loadPrincipal()).resolves.toEqual(me);
    vi.unstubAllGlobals();
  });

  it("returns null on 401 instead of redirecting to login", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    await expect(loadPrincipal()).resolves.toBeNull();
    vi.unstubAllGlobals();
  });

  it("rethrows non-401 failures", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    await expect(loadPrincipal()).rejects.toThrow(/500/);
    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(loadPrincipal()).rejects.toThrow("offline");
    vi.unstubAllGlobals();
  });
});
