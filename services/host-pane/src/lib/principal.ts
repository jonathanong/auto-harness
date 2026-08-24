import { principalHas, type AuthzPrincipal, type Capability } from "@auto-harness/shared";

import { ApiError, apiGet } from "./api.ts";

export type HostPanePrincipal = AuthzPrincipal & {
  username: string;
  capabilities?: Capability[];
};

/** `undefined` means auth is disabled — local host panes retain their write controls. */
export async function loadPrincipal(): Promise<HostPanePrincipal | undefined> {
  if (process.env.HARNESS_AUTH_MODE !== "required") return undefined;
  try {
    return await apiGet<HostPanePrincipal>("/api/v1/auth/me");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return undefined;
    throw error;
  }
}

export function can(principal: HostPanePrincipal | undefined, capability: Capability): boolean {
  if (!principal) return true;
  return principal.capabilities?.includes(capability) ?? principalHas(principal, capability);
}
