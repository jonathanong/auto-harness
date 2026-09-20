import { describe, expect, it } from "vitest";

import { resolveSentryRelease, sentryEnabled } from "./sentry-release.ts";

describe("Sentry deployment release", () => {
  it("normalizes padded opt-in values", () => {
    expect(sentryEnabled({ HARNESS_SENTRY_ENABLED: "  1  " })).toBe(true);
    expect(sentryEnabled({ HARNESS_SENTRY_ENABLED: " true " })).toBe(false);
  });

  it("derives an immutable SHA for a direct enabled CDK deployment", () => {
    expect(resolveSentryRelease({ HARNESS_SENTRY_ENABLED: " 1 " }, () => "a".repeat(40))).toBe(
      "a".repeat(40),
    );
  });

  it("uses an explicit immutable SHA and stays unset when Sentry is off", () => {
    expect(
      resolveSentryRelease(
        { HARNESS_SENTRY_ENABLED: "1", HARNESS_SENTRY_RELEASE: ` ${"b".repeat(40)} ` },
        () => {
          throw new Error("should not read git for an explicit release");
        },
      ),
    ).toBe("b".repeat(40));
    expect(resolveSentryRelease({}, () => "a".repeat(40))).toBeUndefined();
  });

  it("rejects mutable release identifiers", () => {
    expect(() =>
      resolveSentryRelease({ HARNESS_SENTRY_ENABLED: "1", HARNESS_SENTRY_RELEASE: "main" }, () =>
        "a".repeat(40),
      ),
    ).toThrow("immutable 40-character git SHA");
  });
});
