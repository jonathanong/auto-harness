import { DEFAULT_MAX_CONCURRENT_SESSIONS } from "@auto-harness/shared";

/**
 * The slot-cap fragment shared by direct assignment
 * (providerAccountLastAssignedTransactItem) and legacy-lease backfill: a slot
 * is available when maxConcurrentSessions is unset and the slot is within the
 * default cap, or when it's explicitly set above the slot.
 */
export function providerAccountCapCondition(slot: number): {
  condition: string;
  values: Record<string, unknown>;
} {
  return {
    condition:
      "(attribute_not_exists(maxConcurrentSessions) AND :slot < :defaultCap) OR maxConcurrentSessions > :slot",
    values: { ":slot": slot, ":defaultCap": DEFAULT_MAX_CONCURRENT_SESSIONS },
  };
}
