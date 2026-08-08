import type { ControlPlaneState } from "./control-plane-state.ts";

/**
 * Existence check + human-readable label for a session's target, at create time.
 * Whether the target actually *resolves to a runnable command* on a given worktree
 * (the cascade walk) is worktree-dependent and checked later, at assignment
 * (see control-plane-session-target.ts).
 */
export function resolveSessionTargetLabel(
  state: ControlPlaneState,
  providerAccountId: string | undefined,
  commandId: string | undefined,
): { ok: true; label: string } | { ok: false; error: string } {
  if (commandId !== undefined) {
    const command = state.commands.get(commandId);
    if (!command) {
      return { ok: false, error: `commandId ${commandId} not found` };
    }
    if (command.providerId !== null) {
      return {
        ok: false,
        error: `commandId ${commandId} is owned by a provider; target its provider account instead`,
      };
    }
    return { ok: true, label: command.name };
  }
  const account = state.providerAccounts.get(providerAccountId!);
  if (!account) {
    return { ok: false, error: `providerAccountId ${providerAccountId} not found` };
  }
  const provider = state.providers.get(account.providerId);
  if (!provider) {
    return { ok: false, error: `provider ${account.providerId} not found` };
  }
  return { ok: true, label: `${provider.name} — ${account.label}` };
}
