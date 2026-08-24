import type { ControlPlaneState } from "./control-plane-state.ts";
import { buildProviderCatalog } from "./control-plane-session-target.ts";
import { targetIsAvailable } from "./queue-placement-planner.ts";

/** Every catalog provider/command is selectable. Availability is a hint only. */
export type SessionTarget =
  | { kind: "provider"; id: string; label: string; available: boolean }
  | { kind: "command"; id: string; label: string; providerId: string | null; available: boolean };

export function listSessionTargets(state: ControlPlaneState): SessionTarget[] {
  const now = Date.parse(state.now());
  const catalog = buildProviderCatalog(state);
  const providers: SessionTarget[] = [...state.providers.values()].map((provider) => ({
    kind: "provider",
    id: provider.id,
    label: provider.name,
    available: targetIsAvailable(state, catalog, { providerId: provider.id }, now),
  }));
  const commands: SessionTarget[] = [...state.commands.values()].map((command) => ({
    kind: "command",
    id: command.id,
    label: command.name,
    providerId: command.providerId,
    available: targetIsAvailable(state, catalog, { commandId: command.id }, now),
  }));
  return [...providers, ...commands].toSorted((a, b) => a.label.localeCompare(b.label));
}
