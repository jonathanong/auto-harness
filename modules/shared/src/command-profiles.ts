import type { HostInventory } from "./host-inventory.ts";

type CommandProfile = HostInventory["commandProfiles"][string];

/** Add or replace a named command profile on a host's inventory. */
export function setCommandProfile(
  existing: HostInventory,
  name: string,
  profile: CommandProfile,
): HostInventory {
  return {
    ...existing,
    commandProfiles: { ...existing.commandProfiles, [name]: profile },
  };
}

/** Remove a named command profile from a host's inventory. */
export function removeCommandProfile(existing: HostInventory, name: string): HostInventory {
  const next = { ...existing.commandProfiles };
  delete next[name];
  return { ...existing, commandProfiles: next };
}
