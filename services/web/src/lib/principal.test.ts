import { afterEach, describe, expect, it, vi } from "vitest";

import { can, loadPrincipal, type MePrincipal } from "./principal.ts";

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

  it("uses the shared role table for an authenticated principal", () => {
    const operator: MePrincipal = { username: "op", role: "operator", kind: "user" };
    expect(can(operator, "sessions:write")).toBe(true);
    expect(can(operator, "catalog:write")).toBe(false);
    expect(can(operator, "fleet:drain")).toBe(true);
    expect(can({ ...operator, role: "author" }, "schedules:write")).toBe(false);
    expect(can({ ...operator, role: "maintainer" }, "fleet:inventory")).toBe(true);
    expect(can({ ...operator, role: "admin" }, "accounts:write")).toBe(true);
    expect(
      can(
        { username: "scoped", role: "admin", kind: "user", allowedRepositoryIds: ["repo"] },
        "accounts:write",
      ),
    ).toBe(false);
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

  it("returns undefined on 401 instead of redirecting to login", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    await expect(loadPrincipal()).resolves.toBeUndefined();
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
