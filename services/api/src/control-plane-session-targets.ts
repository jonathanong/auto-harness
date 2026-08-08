import type { ControlPlaneState } from "./control-plane-state.ts";

export type SessionTarget =
  | { kind: "provider-account"; id: string; label: string; providerId: string }
  | { kind: "command"; id: string; label: string };

function isAttachedToAnyHost(state: ControlPlaneState, providerAccountId: string): boolean {
  for (const host of state.agentHosts.values()) {
    if (host.providerAccounts.some((pa) => pa.providerAccountId === providerAccountId)) {
      return true;
    }
  }
  return false;
}

/**
 * Unified picker source: attached provider accounts plus standalone commands
 * (providerId: null — provider-owned commands are reached via their provider
 * account's cascade, not selected directly). A provider account not attached
 * to any host would never resolve to a runnable command at assign time
 * (resolveSessionTargetArgv), so it's excluded here rather than offered as a
 * choice that can only ever queue forever.
 */
export function listSessionTargets(state: ControlPlaneState): SessionTarget[] {
  const targets: SessionTarget[] = [];
  for (const account of state.providerAccounts.values()) {
    const provider = state.providers.get(account.providerId);
    if (!provider || !isAttachedToAnyHost(state, account.id)) {
      continue;
    }
    targets.push({
      kind: "provider-account",
      id: account.id,
      label: `${provider.name} — ${account.label}`,
      providerId: provider.id,
    });
  }
  for (const command of state.commands.values()) {
    if (command.providerId !== null) {
      continue;
    }
    targets.push({ kind: "command", id: command.id, label: command.name });
  }
  return targets.toSorted((a, b) => a.label.localeCompare(b.label));
}
