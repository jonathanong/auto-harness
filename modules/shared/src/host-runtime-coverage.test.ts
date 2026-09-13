import { describe, expect, it } from "vitest";

import {
  environmentNamesAreCaseSensitive,
  isHostRuntimeReport,
  MAX_RUNTIME_ENVIRONMENT_NAMES,
  MAX_RUNTIME_ENVIRONMENT_NAME_LENGTH,
} from "./host-runtime.ts";

describe("host runtime report validation", () => {
  it("distinguishes Windows environment-name matching from POSIX matching", () => {
    expect(environmentNamesAreCaseSensitive("win32")).toBe(false);
    expect(environmentNamesAreCaseSensitive("linux")).toBe(true);
  });

  it("accepts ready and unready reports with their required mutually exclusive git facts", () => {
    expect(
      isHostRuntimeReport({
        daemonVersion: "1.2.3",
        gitVersion: "2.45.1",
        gitReady: true,
        environmentNames: ["PATH", "HOME"],
        environmentNamesCaseSensitive: false,
      }),
    ).toBe(true);
    expect(
      isHostRuntimeReport({
        daemonVersion: "1.2.3",
        gitVersion: null,
        gitReady: false,
        gitReadinessReason: "git_unavailable",
      }),
    ).toBe(true);
  });

  it("rejects malformed runtime fields and contradictory git readiness facts", () => {
    expect(isHostRuntimeReport(null)).toBe(false);
    expect(isHostRuntimeReport({ daemonVersion: "", gitVersion: null, gitReady: false })).toBe(
      false,
    );
    expect(isHostRuntimeReport({ daemonVersion: "1", gitVersion: null, gitReady: true })).toBe(
      false,
    );
    expect(
      isHostRuntimeReport({
        daemonVersion: "1",
        gitVersion: "2.45.1",
        gitReady: true,
        gitReadinessReason: "git_unavailable",
      }),
    ).toBe(false);
    expect(
      isHostRuntimeReport({
        daemonVersion: "1",
        gitVersion: null,
        gitReady: false,
        gitReadinessReason: "git_readiness_unreported",
      }),
    ).toBe(false);
  });

  it("bounds and deduplicates environment names", () => {
    const base = { daemonVersion: "1", gitVersion: "2", gitReady: true };
    expect(
      isHostRuntimeReport({
        ...base,
        environmentNames: Array.from({ length: MAX_RUNTIME_ENVIRONMENT_NAMES + 1 }, (_, i) =>
          String(i),
        ),
      }),
    ).toBe(false);
    expect(isHostRuntimeReport({ ...base, environmentNames: ["PATH", "PATH"] })).toBe(false);
    expect(
      isHostRuntimeReport({
        ...base,
        environmentNames: ["A".repeat(MAX_RUNTIME_ENVIRONMENT_NAME_LENGTH + 1)],
      }),
    ).toBe(false);
    expect(isHostRuntimeReport({ ...base, environmentNames: ["PATH", 3] })).toBe(false);
    expect(isHostRuntimeReport({ ...base, environmentNamesCaseSensitive: "yes" })).toBe(false);
  });
});
