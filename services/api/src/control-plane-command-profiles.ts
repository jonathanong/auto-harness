import type { ControlPlaneState } from "./control-plane-state.ts";
import { listHosts } from "./control-plane-agents.ts";

/**
 * Command profile names for UI dropdown: online agents plus host configs
 * (so schedules can be written before the agent connects).
 */
export function listCommandProfiles(state: ControlPlaneState): string[] {
  const set = new Set<string>();
  for (const a of listHosts(state)) {
    if (a.online) {
      for (const p of a.commandProfiles) {
        set.add(p);
      }
    }
  }
  for (const host of state.hostInventories.values()) {
    for (const name of Object.keys(host.commandProfiles)) {
      set.add(name);
    }
  }
  return [...set].toSorted();
}
