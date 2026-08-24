import { principalHas } from "@auto-harness/shared";

import { loadPrincipal, type MePrincipal } from "../../lib/principal.ts";

export async function loadSettingsPrincipal(): Promise<MePrincipal | null | undefined> {
  return loadPrincipal();
}

export function canManageAccounts(principal: MePrincipal): boolean {
  return principalHas(principal, "accounts:write");
}
