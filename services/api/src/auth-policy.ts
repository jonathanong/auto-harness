import type { Principal } from "./auth.ts";

/** Role gate used by every REST route before it reaches its handler. */
export function authorize(principal: Principal, method: string, pathname: string): boolean {
  if (principal.role === "admin") return true;
  if (pathname.startsWith("/api/v1/auth/")) return false;
  const write = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (principal.role === "read-only") return !write;
  if (!write) return true;
  return !/^\/api\/v1\/(commands|providers|provider-accounts|repositories|hosts(?:\/[^/]+\/inventory|\/drain)|host-inventories|scheduler|host\/messages)/.test(
    pathname,
  );
}

export function mayAccessRepository(
  principal: Principal,
  repositoryId: string | undefined,
): boolean {
  return (
    !principal.allowedRepositoryIds ||
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
