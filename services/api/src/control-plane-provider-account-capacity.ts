import { DEFAULT_MAX_CONCURRENT_SESSIONS } from "@auto-harness/shared";

/** Leaf module: importing this resolver from control-plane-provider-account-leases.ts reintroduces a cycle through control-plane-state.ts. */
export function maxConcurrentSessionsFor(
  account: { maxConcurrentSessions?: number } | undefined,
): number {
  return account?.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
}
