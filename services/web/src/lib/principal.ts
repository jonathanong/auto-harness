import { principalHas, type Capability, type UserRole } from "@auto-harness/shared";

import { apiGet } from "./api.ts";

export type MePrincipal = {
  id?: string;
  username: string;
  role: UserRole;
  kind: "admin" | "user" | "service-account";
  allowedRepositoryIds?: string[];
  boundHostId?: string;
  capabilities?: Capability[];
};

/** `undefined` means auth is disabled — the local loopback shows every write control. */
export async function loadPrincipal(): Promise<MePrincipal | undefined> {
  if (process.env.HARNESS_AUTH_MODE !== "required") return undefined;
  return apiGet<MePrincipal>("/api/v1/auth/me");
}

export function can(principal: MePrincipal | undefined, capability: Capability): boolean {
  if (!principal) return true;
  return principalHas(principal, capability);
}
