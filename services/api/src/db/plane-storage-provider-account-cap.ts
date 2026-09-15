/**
 * The slot-cap fragment shared by direct assignment: a slot is available when
 * the required maxConcurrentSessions is above the slot.
 */
export function providerAccountCapCondition(slot: number): {
  condition: string;
  values: Record<string, unknown>;
} {
  return {
    condition: "maxConcurrentSessions > :slot",
    values: { ":slot": slot },
  };
}
