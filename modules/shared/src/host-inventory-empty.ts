/** Empty host inventory for “add agent” before any repos are attached. */
export function emptyHostInventory() {
  return { repositories: [], providerAccounts: [], capabilities: [] };
}
