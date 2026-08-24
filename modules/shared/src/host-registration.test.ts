import { describe, expect, it } from "vitest";

import {
  isHostRepositoryRegistration,
  isHostRunningAttempt,
  validateHostRepositoryRegistrations,
  validateHostRunningAttempts,
} from "./host-registration.ts";

describe("host registration repository validation", () => {
  it("validates explicit repositories and duplicate IDs", () => {
    expect(isHostRepositoryRegistration({ id: "r", path: "/r" })).toBe(true);
    expect(isHostRepositoryRegistration({ id: "r", path: "" })).toBe(false);
    expect(validateHostRepositoryRegistrations([{ id: "r", path: "/r" }])).toBeNull();
    expect(
      validateHostRepositoryRegistrations([
        { id: "r", path: "/r" },
        { id: "r", path: "/other" },
      ]),
    ).toBe("duplicate repository r");
  });

  it("validates reconnect attempt claims", () => {
    expect(isHostRunningAttempt({ sessionId: "s", attemptId: "a" })).toBe(true);
    expect(isHostRunningAttempt({ sessionId: "s", attemptId: "" })).toBe(false);
    expect(isHostRunningAttempt({ sessionId: "", attemptId: "a" })).toBe(false);
    expect(isHostRunningAttempt(null)).toBe(false);
    expect(validateHostRunningAttempts([{ sessionId: "s", attemptId: "a" }])).toBeNull();
    expect(
      validateHostRunningAttempts([
        { sessionId: "s", attemptId: "a" },
        { sessionId: "s", attemptId: "b" },
      ]),
    ).toBe("duplicate running session s");
    expect(validateHostRunningAttempts([{ sessionId: "s", attemptId: "" }])).toBe(
      "invalid running attempt",
    );
  });
});
