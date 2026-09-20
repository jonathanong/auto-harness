import { describe, expect, it } from "vitest";

import { sentryBuildConfig } from "./sentry-sourcemaps.ts";

describe("sentryBuildConfig", () => {
  it("selects the control-plane web project and immutable release", () => {
    expect(sentryBuildConfig("web", { HARNESS_SENTRY_RELEASE: "a".repeat(40) })).toEqual({
      packageName: "@auto-harness/web",
      project: "auto-harness-control-plane-web",
      release: "a".repeat(40),
      sourceMapDirectory: "services/web/.next",
    });
  });

  it("selects the local host-pane project", () => {
    expect(
      sentryBuildConfig("host-pane", { HARNESS_SENTRY_RELEASE: "b".repeat(40) }),
    ).toMatchObject({
      packageName: "@auto-harness/host-pane",
      project: "auto-harness-host-plane-web",
      release: "b".repeat(40),
    });
  });

  it("rejects a missing or mutable release identifier", () => {
    expect(() => sentryBuildConfig("web", {})).toThrow("HARNESS_SENTRY_RELEASE");
    expect(() => sentryBuildConfig("web", { HARNESS_SENTRY_RELEASE: "main" })).toThrow(
      "40-character git SHA",
    );
  });
});
