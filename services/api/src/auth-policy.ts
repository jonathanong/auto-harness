import type { Principal } from "./auth.ts";

/** Role gate used by every REST route before it reaches its handler. */
export function authorize(principal: Principal, method: string, pathname: string): boolean {
  const scopedAdmin =
    principal.role === "admin" && (!!principal.allowedRepositoryIds || !!principal.boundHostId);
  if (principal.role === "admin" && !scopedAdmin) return true;
  if (pathname.startsWith("/api/v1/auth/")) return false;
  if (pathname === "/api/v1/host/messages") {
    return (
      principal.kind === "service-account" &&
      principal.role !== "read-only" &&
      !!principal.boundHostId
    );
  }
  // Let a host-bound admin reach the target-aware drain handler so a different
  // host is hidden with the same 404 as an unknown host.
  if (scopedAdmin && pathname === "/api/v1/hosts/drain") return !!principal.boundHostId;
  if (scopedAdmin && /^\/api\/v1\/hosts\/[^/]+\/inventory$/.test(pathname)) {
    return !!principal.boundHostId;
  }
  const write = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (principal.role === "read-only") return !write;
  if (!write) return true;
  return !/^\/api\/v1\/(commands|providers|provider-accounts|repositories|hosts(?:\/[^/]+\/inventory|\/drain)|host-inventories|scheduler|host\/messages)/.test(
    pathname,
  );
}

export function mayAccessRepository(
  principal: Principal | undefined,
  repositoryId: string | undefined,
): boolean {
  return (
    !principal?.allowedRepositoryIds ||
    !repositoryId ||
    principal.allowedRepositoryIds.includes(repositoryId)
  );
}

/** A host-bound service account may only inspect or operate its own host. */
export function mayAccessHost(
  principal: Principal | undefined,
  hostId: string | undefined,
): boolean {
  return !principal?.boundHostId || principal.boundHostId === hostId;
}
