import type { Principal } from "./auth.ts";
import type { ConnectionRecord } from "./db/plane-storage-types.ts";

/** Persist only admin/user identities on a browser viewer socket. */
export function viewerConnectionPrincipal(
  principal: Principal | null,
): ConnectionRecord["viewerPrincipal"] {
  if (!principal || (principal.kind !== "admin" && principal.kind !== "user")) return undefined;
  return {
    id: principal.id,
    username: principal.username,
    role: principal.role,
    kind: principal.kind,
    ...(principal.allowedRepositoryIds
      ? { allowedRepositoryIds: principal.allowedRepositoryIds }
      : {}),
  };
}
