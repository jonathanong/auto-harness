import { describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  ROLE_CAPABILITIES,
  USER_ROLE_DESCRIPTIONS,
  USER_ROLE_LABELS,
  accountGrantError,
  effectiveRole,
  normalizeAccountGrant,
  principalCapabilities,
  principalHas,
  roleHas,
  type AuthzPrincipal,
  type Capability,
} from "./authz.ts";
import { USER_ROLES } from "./constants.ts";
import type { UserRole } from "./types.ts";

const allRoles: UserRole[] = [...USER_ROLES];

function principal(role: UserRole, extra: Partial<AuthzPrincipal> = {}): AuthzPrincipal {
  return { role, ...extra };
}

describe("role capability table", () => {
  it("covers every role and capability exactly once in the admin grant", () => {
    expect(Object.keys(ROLE_CAPABILITIES).toSorted()).toEqual([...USER_ROLES].toSorted());
    expect(ROLE_CAPABILITIES.admin).toEqual(CAPABILITIES);
    for (const role of allRoles) {
      expect(USER_ROLE_DESCRIPTIONS[role].length).toBeGreaterThan(10);
      expect(USER_ROLE_LABELS[role].length).toBeGreaterThan(0);
    }
  });

  it("grants each named role the documented writes", () => {
    const expected: Record<UserRole, Capability[]> = {
      "read-only": [],
      author: ["sessions:write", "sessions:archive"],
      operator: [
        "sessions:write",
        "sessions:archive",
        "sessions:cancel-any",
        "schedules:write",
        "fleet:drain",
      ],
      maintainer: [
        "sessions:write",
        "sessions:archive",
        "sessions:cancel-any",
        "schedules:write",
        "fleet:drain",
        "fleet:inventory",
        "providers:accounts",
      ],
      agent: ["agent:protocol", "fleet:drain"],
      admin: [...CAPABILITIES],
    };
    for (const role of allRoles) {
      expect([...ROLE_CAPABILITIES[role]]).toEqual(expected[role]);
      for (const capability of CAPABILITIES) {
        expect(roleHas(role, capability)).toBe(expected[role].includes(capability));
      }
    }
  });

  it("does not let maintainer edit catalog argv or IAM", () => {
    expect(roleHas("maintainer", "catalog:write")).toBe(false);
    expect(roleHas("maintainer", "accounts:write")).toBe(false);
    expect(roleHas("maintainer", "integrations:write")).toBe(false);
    expect(roleHas("maintainer", "audit:read")).toBe(false);
    expect(roleHas("author", "schedules:write")).toBe(false);
    expect(roleHas("operator", "fleet:inventory")).toBe(false);
    expect(roleHas("agent", "sessions:write")).toBe(false);
  });
});

describe("effectiveRole", () => {
  it("maps legacy bound operator/admin to agent and scoped admin to maintainer", () => {
    expect(effectiveRole(principal("operator", { boundHostId: "host-a" }))).toBe("agent");
    expect(effectiveRole(principal("admin", { boundHostId: "host-a" }))).toBe("agent");
    expect(effectiveRole(principal("maintainer", { boundHostId: "host-a" }))).toBe("agent");
    expect(effectiveRole(principal("admin", { allowedRepositoryIds: ["repo-a"] }))).toBe(
      "maintainer",
    );
    expect(effectiveRole(principal("read-only", { boundHostId: "host-a" }))).toBe("read-only");
    expect(effectiveRole(principal("operator"))).toBe("operator");
    expect(effectiveRole(principal("admin"))).toBe("admin");
    expect(effectiveRole(principal("agent", { boundHostId: "host-a" }))).toBe("agent");
  });
});

describe("principalHas", () => {
  it("requires a bound service-account for the daemon protocol", () => {
    expect(
      principalHas(
        principal("agent", { kind: "service-account", boundHostId: "h" }),
        "agent:protocol",
      ),
    ).toBe(true);
    expect(principalHas(principal("agent", { boundHostId: "h" }), "agent:protocol")).toBe(false);
    expect(
      principalHas(
        principal("operator", { kind: "service-account", boundHostId: "h" }),
        "agent:protocol",
      ),
    ).toBe(true);
    expect(
      principalHas(principal("operator", { kind: "user", boundHostId: "h" }), "agent:protocol"),
    ).toBe(false);
    expect(principalHas(principal("admin"), "agent:protocol")).toBe(false);
    expect(principalHas(principal("admin"), "catalog:write")).toBe(true);
    expect(principalHas(principal("author"), "sessions:write")).toBe(true);
    expect(principalCapabilities(principal("operator", { boundHostId: "h" }))).toEqual([
      ...ROLE_CAPABILITIES.agent,
    ]);
  });
});

describe("normalizeAccountGrant", () => {
  it("rewrites legacy stored shapes to the named roles they actually were", () => {
    expect(normalizeAccountGrant({ role: "operator", boundHostId: "h" })).toEqual({
      role: "agent",
      boundHostId: "h",
    });
    expect(normalizeAccountGrant({ role: "admin", allowedRepositoryIds: ["r"] })).toEqual({
      role: "maintainer",
      allowedRepositoryIds: ["r"],
    });
    expect(normalizeAccountGrant({ role: "admin" })).toEqual({ role: "admin" });
    expect(normalizeAccountGrant({ role: "read-only", boundHostId: "h" })).toEqual({
      role: "read-only",
      boundHostId: "h",
    });
  });
});

describe("accountGrantError", () => {
  it("rejects admin scope, unbound agents, and bound non-agents", () => {
    expect(accountGrantError({ role: "admin" })).toBeUndefined();
    expect(accountGrantError({ role: "author", allowedRepositoryIds: ["r"] })).toBeUndefined();
    expect(accountGrantError({ role: "agent", boundHostId: "h" })).toBeUndefined();
    expect(
      accountGrantError({ role: "agent", boundHostId: "h", allowedRepositoryIds: ["r"] }),
    ).toBeUndefined();
    expect(accountGrantError({ role: "admin", allowedRepositoryIds: ["r"] })).toMatch(/admin/);
    expect(accountGrantError({ role: "admin", boundHostId: "h" })).toMatch(/admin/);
    expect(accountGrantError({ role: "agent" })).toMatch(/boundHostId/);
    expect(accountGrantError({ role: "operator", boundHostId: "h" })).toMatch(/agent/);
    expect(accountGrantError({ role: "read-only", boundHostId: "h" })).toMatch(/agent/);
  });
});
