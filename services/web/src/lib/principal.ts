import { principalHas, type Capability, type UserRole } from "@auto-harness/shared";

import { ApiError, apiGet } from "./api.ts";

export type MePrincipal = {
  id?: string;
  username: string;
  role: UserRole;
  kind: "admin" | "user" | "service-account";
  allowedRepositoryIds?: string[];
  boundHostId?: string;
  capabilities?: Capability[];
};

/**
 * `undefined` means authentication is disabled. `null` means auth is required but the
 * request has no authenticated principal; callers must fail closed in that case.
 */
export async function loadPrincipal(): Promise<MePrincipal | null | undefined> {
  if (process.env.HARNESS_AUTH_MODE !== "required") return undefined;
  try {
    return await apiGet<MePrincipal>("/api/v1/auth/me", { redirectOnUnauthorized: false });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export function can(principal: MePrincipal | null | undefined, capability: Capability): boolean {
  if (principal === undefined) return true;
  if (principal === null) return false;
  return principalHas(principal, capability);
}
