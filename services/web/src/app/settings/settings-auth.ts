import { principalHas } from "@auto-harness/shared";

import { loadPrincipal, type MePrincipal } from "../../lib/principal.ts";

export type SettingsPrincipal = MePrincipal;

export async function loadSettingsPrincipal(): Promise<SettingsPrincipal | undefined> {
  return loadPrincipal();
}

export function canManageAccounts(principal: SettingsPrincipal): boolean {
  return principalHas(principal, "accounts:write");
}
