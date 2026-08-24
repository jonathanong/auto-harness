import { describe, expect, it } from "vitest";

import {
  isHostRepositoryRegistration,
  isHostRunningAttempt,
  isProviderAccountReadiness,
  MAX_PROVIDER_ACCOUNT_READINESS,
  validateHostRepositoryRegistrations,
  validateHostRunningAttempts,
  validateProviderAccountReadiness,
} from "./host-registration.ts";

describe("host repository registration edge validation", () => {
  it("rejects non-records and malformed optional branches", () => {
    for (const value of [null, [], "repository", { id: "", path: "/repo" }, { id: "r", path: 1 }]) {
      expect(isHostRepositoryRegistration(value)).toBe(false);
    }
    expect(isHostRepositoryRegistration({ id: "r", path: "/repo", defaultBranch: "" })).toBe(false);
    expect(isHostRepositoryRegistration({ id: "r", path: "/repo", defaultBranch: "main" })).toBe(
      true,
    );
    expect(validateHostRepositoryRegistrations([{ id: "", path: "/repo" }])).toBe(
      "invalid repository registration",
    );
    for (const value of [null, [], "attempt", { sessionId: "s" }, { attemptId: "a" }]) {
      expect(isHostRunningAttempt(value)).toBe(false);
    }
    expect(validateHostRunningAttempts([{ sessionId: "s", attemptId: 1 } as never])).toBe(
      "invalid running attempt",
    );
  });

  it("rejects oversized or malformed provider-account readiness lists", () => {
    expect(isProviderAccountReadiness(null)).toBe(false);
    expect(isProviderAccountReadiness([])).toBe(false);
    expect(
      validateProviderAccountReadiness(
        Array.from({ length: MAX_PROVIDER_ACCOUNT_READINESS + 1 }, (_, index) => ({
          providerAccountId: `acct-${String(index)}`,
          ready: true,
          fingerprint: "a".repeat(64),
        })),
      ),
    ).toBe("too many provider account readiness entries");
  });
});
