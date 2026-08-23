import { principalHas, type Capability, type AuthzPrincipal } from "@auto-harness/shared";

import type { Principal } from "./auth.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function matchesRoutePrefix(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

/**
 * Map a REST method+path to the capability that may invoke it.
 * `"authenticated"` means any signed-in principal (including read-only).
 * `null` is an unknown write — deny.
 */
export function requiredCapability(
  method: string,
  pathname: string,
): Capability | "authenticated" | null {
  const write = !SAFE_METHODS.has(method);
  if (pathname === "/api/v1/integrations/slack") return "integrations:write";
  if (
    matchesRoutePrefix(pathname, "/api/v1/auth/users") ||
    matchesRoutePrefix(pathname, "/api/v1/auth/service-accounts")
  ) {
    return "accounts:write";
  }
  if (pathname === "/api/v1/audit-logs") return "audit:read";
  if (pathname === "/api/v1/host/messages") return "agent:protocol";
  if (matchesRoutePrefix(pathname, "/api/v1/scheduler")) return "scheduler:run";
  if (pathname === "/api/v1/hosts/drain") return write ? "fleet:drain" : "authenticated";
  if (/^\/api\/v1\/repositories\/[^/]+\/(pause|drain|activate)$/.test(pathname)) {
    return write ? "repositories:operate" : "authenticated";
  }
  if (/^\/api\/v1\/repositories\/[^/]+\/session-drains(?:\/[^/]+(?:\/release)?)?$/.test(pathname)) {
    return write ? "sessions:write" : "authenticated";
  }
  if (
    pathname === "/api/v1/host-inventories" ||
    /^\/api\/v1\/hosts\/[^/]+\/inventory$/.test(pathname)
  ) {
    return write ? "fleet:inventory" : "authenticated";
  }
  if (matchesRoutePrefix(pathname, "/api/v1/provider-accounts")) {
    return write ? "providers:accounts" : "authenticated";
  }
  if (
    matchesRoutePrefix(pathname, "/api/v1/commands") ||
    matchesRoutePrefix(pathname, "/api/v1/providers") ||
    matchesRoutePrefix(pathname, "/api/v1/repositories")
  ) {
    return write ? "catalog:write" : "authenticated";
  }
  if (matchesRoutePrefix(pathname, "/api/v1/schedules")) {
    return write ? "schedules:write" : "authenticated";
  }
  if (write && /^\/api\/v1\/sessions\/[^/]+\/archive$/.test(pathname)) return "sessions:archive";
  if (matchesRoutePrefix(pathname, "/api/v1/sessions") && write) return "sessions:write";
  if (!write) return "authenticated";
  if (pathname.startsWith("/api/v1/")) return null;
  return "authenticated";
}

const BOUND_KEY_HANDLER_DENIALS = new Set<Capability>([
  "sessions:write",
  "sessions:archive",
  "schedules:write",
]);

/** Role gate used by every REST route before it reaches its handler. */
export function authorize(principal: Principal, method: string, pathname: string): boolean {
  const capability = requiredCapability(method, pathname);
  if (capability === null) return false;
  if (capability === "authenticated") return true;
  // Bound daemon keys must reach the handler so authoring denials stay 404, not 403 —
  // a 403 would advertise that session/schedule writes exist for this credential.
  if (principal.boundHostId && BOUND_KEY_HANDLER_DENIALS.has(capability)) return true;
  return principalHas(principal, capability);
}

export function mayAccessRepository(
  principal: Principal | undefined,
  repositoryId: string | undefined,
): boolean {
  if (!principal?.allowedRepositoryIds) return true;
  // A repository-scoped principal against a resource whose repository we could not
  // determine: deny. Granting here made every unidentified resource reachable by every
  // scoped caller, which is the wrong default for the one check that enforces the scope.
  if (!repositoryId) return false;
  return principal.allowedRepositoryIds.includes(repositoryId);
}

/** A host-bound service account may only inspect or operate its own host. */
export function mayAccessHost(
  principal: Principal | undefined,
  hostId: string | null | undefined,
): boolean {
  return !principal?.boundHostId || principal.boundHostId === hostId;
}

export function may(principal: AuthzPrincipal | undefined, capability: Capability): boolean {
  return !!principal && principalHas(principal, capability);
}
