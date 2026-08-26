import { DEFAULT_MAX_CONCURRENT_SESSIONS } from "@auto-harness/shared";

/**
 * A leaf module (no control-plane-state.ts import) so hydrate-time callers can
 * resolve an account's cap without pulling in control-plane-provider-account-leases.ts's
 * full dependency chain, which imports back through control-plane-hydrate.ts.
 */
export function maxConcurrentSessionsFor(
  account: { maxConcurrentSessions?: number } | undefined,
): number {
  return account?.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
}
