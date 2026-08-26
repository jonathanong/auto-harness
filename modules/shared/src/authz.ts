import type { UserRole } from "./types.ts";

export type Capability =
  | "sessions:write"
  | "sessions:cancel-any"
  | "sessions:archive"
  | "schedules:write"
  | "repositories:operate"
  | "fleet:drain"
  | "fleet:inventory"
  | "fleet:exec-config"
  | "providers:accounts"
  | "providers:leases"
  | "catalog:write"
  | "accounts:write"
  | "integrations:write"
  | "audit:read"
  | "scheduler:run"
  | "agent:protocol";

export const CAPABILITIES = [
  "sessions:write",
  "sessions:cancel-any",
  "sessions:archive",
  "schedules:write",
  "repositories:operate",
  "fleet:drain",
  "fleet:inventory",
  "fleet:exec-config",
  "providers:accounts",
  "providers:leases",
  "catalog:write",
  "accounts:write",
  "integrations:write",
  "audit:read",
  "scheduler:run",
  "agent:protocol",
] as const satisfies readonly Capability[];

const AUTHOR_CAPABILITIES = [
  "sessions:write",
  "sessions:archive",
] as const satisfies readonly Capability[];

const OPERATOR_CAPABILITIES = [
  ...AUTHOR_CAPABILITIES,
  "sessions:cancel-any",
  "schedules:write",
  "repositories:operate",
  "fleet:drain",
  "providers:leases",
] as const satisfies readonly Capability[];

const MAINTAINER_CAPABILITIES = [
  ...OPERATOR_CAPABILITIES,
  "fleet:inventory",
  "providers:accounts",
] as const satisfies readonly Capability[];

export const ROLE_CAPABILITIES = {
  "read-only": [],
  author: AUTHOR_CAPABILITIES,
  operator: OPERATOR_CAPABILITIES,
  maintainer: MAINTAINER_CAPABILITIES,
  agent: ["agent:protocol", "fleet:drain"],
  admin: CAPABILITIES,
} as const satisfies Record<UserRole, readonly Capability[]>;

export const USER_ROLE_LABELS = {
  "read-only": "Read-only",
  author: "Author",
  operator: "Operator",
  maintainer: "Maintainer",
  agent: "Host daemon",
  admin: "Admin",
} as const satisfies Record<UserRole, string>;

export const USER_ROLE_DESCRIPTIONS = {
  "read-only": "Observe sessions, catalog, and fleet. No writes.",
  author: "Create, clone, resume, and archive sessions. Cancel only your own.",
  operator: "Run the queue: sessions, any in-scope cancel, schedules, and drain.",
  maintainer: "Configure fleet inventory and provider accounts, plus operator work.",
  agent: "Bound to one host; cannot author sessions.",
  admin:
    "Platform admin: catalog argv, fleet exec-config, accounts, Slack, audit. Must be unscoped.",
} as const satisfies Record<UserRole, string>;

/** Identity fields that affect role mapping and grants. */
export type AuthzPrincipal = {
  role: UserRole;
  kind?: string;
  allowedRepositoryIds?: string[];
  boundHostId?: string;
};

/**
 * Legacy rows stored `operator`/`admin` plus `boundHostId` or repo scope. Map them to the
 * named roles those combinations actually were, without escalating `read-only`.
 */
export function effectiveRole(principal: AuthzPrincipal): UserRole {
  if (principal.boundHostId) {
    return principal.role === "read-only" ? "read-only" : "agent";
  }
  if (principal.role === "admin" && principal.allowedRepositoryIds?.length) return "maintainer";
  return principal.role;
}

export function roleHas(role: UserRole, capability: Capability): boolean {
  return (ROLE_CAPABILITIES[role] as readonly Capability[]).includes(capability);
}

export function principalHas(principal: AuthzPrincipal, capability: Capability): boolean {
  const role = effectiveRole(principal);
  if (capability === "agent:protocol") {
    return (
      roleHas(role, capability) && principal.kind === "service-account" && !!principal.boundHostId
    );
  }
  return roleHas(role, capability);
}

export function principalCapabilities(principal: AuthzPrincipal): Capability[] {
  return CAPABILITIES.filter((capability) => principalHas(principal, capability));
}

/** Rewrite a stored/submitted grant to the named role those axes actually were. */
export function normalizeAccountGrant(input: {
  role: UserRole;
  allowedRepositoryIds?: string[];
  boundHostId?: string;
}): {
  role: UserRole;
  allowedRepositoryIds?: string[];
  boundHostId?: string;
} {
  return {
    role: effectiveRole(input),
    ...(input.allowedRepositoryIds?.length
      ? { allowedRepositoryIds: input.allowedRepositoryIds }
      : {}),
    ...(input.boundHostId ? { boundHostId: input.boundHostId } : {}),
  };
}

/** Why a role + scope + bind combination cannot be stored. `undefined` means valid. */
export function accountGrantError(input: {
  role: UserRole;
  allowedRepositoryIds?: string[];
  boundHostId?: string;
}): string | undefined {
  const scoped = Boolean(input.allowedRepositoryIds?.length);
  if (input.role === "admin" && (scoped || input.boundHostId)) {
    return "admin accounts cannot be repository- or host-scoped";
  }
  if (input.role === "agent") {
    if (!input.boundHostId) return "agent accounts require boundHostId";
    return undefined;
  }
  if (input.boundHostId) return "boundHostId is only valid on agent accounts";
  return undefined;
}
