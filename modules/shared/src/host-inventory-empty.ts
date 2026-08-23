import type { HostInventory } from "./host-inventory.ts";

/** Empty host inventory for “add agent” before any repos are attached. */
export function emptyHostInventory(): HostInventory {
  return { repositories: [], providerAccounts: [], capabilities: [] };
}
